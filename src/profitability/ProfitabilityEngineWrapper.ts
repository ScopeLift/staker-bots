import { ethers } from 'ethers';
import { Logger } from '@/monitor/logging';
import {
  IGovLstProfitabilityEngine,
  ProfitabilityEngineConfig,
} from './interfaces/IProfitabilityEngine';
import { GovLstProfitabilityEngine } from './strategies/GovLstProfitabilityEngine';
import {
  GovLstDeposit,
  GovLstProfitabilityCheck,
  GovLstBatchAnalysis,
  ProfitabilityConfig,
} from './interfaces/types';
import { CONFIG } from '@/configuration';
import { QUEUE_CONSTANTS, EVENTS } from './constants';
import {
  DepositNotFoundError,
  InvalidDepositDataError,
  QueueProcessingError,
} from '@/configuration/errors';
import { IExecutor } from '@/executor/interfaces/IExecutor';
import { DatabaseWrapper } from '@/database';
import {
  ProcessingQueueStatus,
  TransactionQueueStatus,
} from '@/database/interfaces/types';

// Add component type constant
const PROFITABILITY_COMPONENT = {
  TYPE: 'profitability-engine',
  INITIAL_BLOCK_HASH: ethers.ZeroHash,
};

interface DatabaseDeposit {
  deposit_id: string;
  owner_address: string;
  depositor_address?: string;
  delegatee_address: string | null;
  amount: string;
  earning_power?: string;
  created_at?: string;
  updated_at?: string;
}

interface DepositCache {
  deposit: GovLstDeposit;
  timestamp: number;
}

interface ProfitableTransaction {
  deposit_id: bigint;
  unclaimed_rewards: bigint;
  expected_profit: bigint;
}

/**
 * Wrapper for the GovLst profitability engine that handles caching and analysis
 */
export class GovLstProfitabilityEngineWrapper
  implements IGovLstProfitabilityEngine
{
  private readonly engine: IGovLstProfitabilityEngine;
  private readonly processingQueue: Set<string> = new Set();
  private readonly depositCache: Map<string, DepositCache> = new Map();
  private queueProcessorInterval: NodeJS.Timeout | null = null;
  private rewardCheckInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastProcessedBlock = 0;
  private static readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private static readonly REWARD_CHECK_INTERVAL =
    CONFIG.profitability.rewardCheckInterval;
  private profitableTransactions: ProfitableTransaction[] = [];
  private readonly profitabilityCache = new Map<
    string,
    {
      check: GovLstProfitabilityCheck;
      timestamp: number;
    }
  >();
  private readonly provider: ethers.Provider;

  constructor(
    private readonly db: DatabaseWrapper,
    govLstContract: ethers.Contract,
    stakerContract: ethers.Contract,
    provider: ethers.Provider,
    private readonly logger: Logger,
    config: ProfitabilityConfig,
    private readonly executor: IExecutor,
  ) {
    this.provider = provider;
    this.engine = new GovLstProfitabilityEngine(
      govLstContract as ethers.Contract & {
        payoutAmount(): Promise<bigint>;
        claimAndDistributeReward(
          recipient: string,
          minExpectedReward: bigint,
          depositIds: bigint[],
        ): Promise<void>;
        balanceOf(account: string): Promise<bigint>;
        balanceCheckpoint(account: string): Promise<bigint>;
        depositIdForHolder(account: string): Promise<bigint>;
        earningPowerOf(depositId: bigint): Promise<bigint>;
        minQualifyingEarningPowerBips(): Promise<bigint>;
      },
      stakerContract as ethers.Contract & {
        balanceOf(account: string): Promise<bigint>;
        deposits(
          depositId: bigint,
        ): Promise<[string, bigint, bigint, string, string]>;
        unclaimedReward(depositId: bigint): Promise<bigint>;
      },
      provider,
      config,
    );
  }

  private serializeProfitabilityCheck(deposits: GovLstDeposit[]): string {
    return deposits
      .map((d) => `${d.deposit_id}-${d.delegatee_address}-${d.amount}`)
      .sort()
      .join('|');
  }
  private serializeBigInts(obj: unknown): unknown {
    if (typeof obj === 'bigint') {
      return obj.toString();
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.serializeBigInts(item));
    }

    if (obj !== null && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.serializeBigInts(value);
      }
      return result;
    }

    return obj;
  }

  async checkGroupProfitability(
    deposits: GovLstDeposit[],
  ): Promise<GovLstProfitabilityCheck> {
    const cacheKey = this.serializeProfitabilityCheck(deposits);
    const cached = this.profitabilityCache.get(cacheKey);

    if (
      cached &&
      Date.now() - cached.timestamp < GovLstProfitabilityEngineWrapper.CACHE_TTL
    ) {
      return cached.check;
    }

    const check = await this.engine.checkGroupProfitability(deposits);

    // Serialize BigInt values before caching
    const serializedCheck = this.serializeBigInts(
      check,
    ) as GovLstProfitabilityCheck;

    this.profitabilityCache.set(cacheKey, {
      check: serializedCheck,
      timestamp: Date.now(),
    });

    return serializedCheck;
  }

  async getProfitableTransactions(): Promise<ProfitableTransaction[]> {
    return this.profitableTransactions;
  }

  async clearProfitableTransactions(): Promise<void> {
    this.profitableTransactions = [];
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    // Load last checkpoint
    const checkpoint = await this.db.getCheckpoint(
      PROFITABILITY_COMPONENT.TYPE,
    );
    if (checkpoint) {
      this.lastProcessedBlock = checkpoint.last_block_number;
      this.logger.info('Resuming from checkpoint', {
        lastProcessedBlock: this.lastProcessedBlock,
      });
    } else {
      // Initialize checkpoint if none exists
      const currentBlock = await this.provider.getBlockNumber();
      this.lastProcessedBlock = currentBlock;
      await this.db.updateCheckpoint({
        component_type: PROFITABILITY_COMPONENT.TYPE,
        last_block_number: currentBlock,
        block_hash: PROFITABILITY_COMPONENT.INITIAL_BLOCK_HASH,
        last_update: new Date().toISOString(),
      });
    }

    await this.engine.start();
    this.isRunning = true;
    this.startQueueProcessor();
    this.startRewardChecker();
    await this.requeuePendingItems();
    this.logger.info(EVENTS.ENGINE_STARTED);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    await this.engine.stop();
    this.isRunning = false;
    this.stopQueueProcessor();
    this.stopRewardChecker();

    // Log profitable transactions before stopping
    if (this.profitableTransactions.length > 0) {
      this.logger.info('Profitable transactions found:', {
        transactions: this.profitableTransactions.map((tx) => ({
          deposit_id: tx.deposit_id.toString(),
          unclaimed_rewards: ethers.formatEther(tx.unclaimed_rewards),
          expected_profit: ethers.formatEther(tx.expected_profit),
        })),
      });
    }

    this.logger.info(EVENTS.ENGINE_STOPPED);
  }

  async getStatus(): Promise<{
    isRunning: boolean;
    lastGasPrice: bigint;
    lastUpdateTimestamp: number;
    queueSize: number;
    groupCount: number;
  }> {
    const baseStatus = await this.engine.getStatus();
    return {
      ...baseStatus,
      queueSize: this.processingQueue.size,
      groupCount: 0,
    };
  }

  async analyzeAndGroupDeposits(
    deposits: GovLstDeposit[],
  ): Promise<GovLstBatchAnalysis> {
    return this.engine.analyzeAndGroupDeposits(deposits);
  }

  private startQueueProcessor(): void {
    if (this.queueProcessorInterval) return;
    this.queueProcessorInterval = setInterval(
      () => this.processQueue(),
      QUEUE_CONSTANTS.PROCESSOR_INTERVAL,
    );
  }

  private stopQueueProcessor(): void {
    if (!this.queueProcessorInterval) return;
    clearInterval(this.queueProcessorInterval);
    this.queueProcessorInterval = null;
  }

  private startRewardChecker(): void {
    if (this.rewardCheckInterval) return;
    this.rewardCheckInterval = setInterval(
      () => this.checkAndProcessRewards(),
      GovLstProfitabilityEngineWrapper.REWARD_CHECK_INTERVAL,
    );
  }

  private stopRewardChecker(): void {
    if (!this.rewardCheckInterval) return;
    clearInterval(this.rewardCheckInterval);
    this.rewardCheckInterval = null;
  }

  private async requeuePendingItems(): Promise<void> {
    try {
      const pendingItems = await this.db.getProcessingQueueItemsByStatus(
        ProcessingQueueStatus.PENDING,
      );

      for (const item of pendingItems) {
        if (item.deposit_id) this.processingQueue.add(item.deposit_id);
      }

      this.logger.info(EVENTS.ITEMS_REQUEUED, { count: pendingItems.length });
    } catch (error) {
      throw new QueueProcessingError(error as Error, { operation: 'requeue' });
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processingQueue.size === 0) return;

    try {
      const currentBlock = await this.provider.getBlockNumber();
      const deposits = await this.getDepositsWithCache(
        Array.from(this.processingQueue).map((id) => BigInt(id)),
      );

      // Clear the processing queue since we've retrieved the deposits
      this.processingQueue.clear();

      // Skip if no deposits found
      if (deposits.length === 0) {
        this.logger.info('No deposits found to process');
        return;
      }

      // Analyze deposits for profitability
      const analysis = await this.analyzeAndGroupDeposits(deposits);

      // Update checkpoint after successful processing
      if (currentBlock > this.lastProcessedBlock) {
        const block = await this.provider.getBlock(currentBlock);
        if (!block) throw new Error(`Block ${currentBlock} not found`);

        await this.db.updateCheckpoint({
          component_type: PROFITABILITY_COMPONENT.TYPE,
          last_block_number: currentBlock,
          block_hash: block.hash!,
          last_update: new Date().toISOString(),
        });
        this.lastProcessedBlock = currentBlock;
      }

      // Log analysis results
      this.logger.info(EVENTS.QUEUE_PROCESSED, {
        totalGroups: analysis.deposit_groups.length,
        totalProfit: analysis.total_expected_profit.toString(),
        lastProcessedBlock: this.lastProcessedBlock,
        depositCount: deposits.length,
      });

      // Update processing queue items to completed
      for (const deposit of deposits) {
        const processingItem = await this.db.getProcessingQueueItemByDepositId(
          deposit.deposit_id.toString(),
        );
        if (processingItem) {
          await this.db.updateProcessingQueueItem(processingItem.id, {
            status: ProcessingQueueStatus.COMPLETED,
          });
        }
      }
    } catch (error) {
      // Log the specific error details
      this.logger.error('Queue processing error:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        queueSize: this.processingQueue.size,
      });

      // Re-add failed items back to the queue for retry
      const failedIds = Array.from(this.processingQueue);
      this.processingQueue.clear(); // Clear the queue first

      for (const id of failedIds) {
        try {
          const processingItem =
            await this.db.getProcessingQueueItemByDepositId(id);
          if (processingItem) {
            await this.db.updateProcessingQueueItem(processingItem.id, {
              status: ProcessingQueueStatus.FAILED,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } catch (dbError) {
          this.logger.error('Failed to update processing queue item:', {
            error: dbError instanceof Error ? dbError.message : String(dbError),
            depositId: id,
          });
        }
      }

      throw new QueueProcessingError(error as Error, {
        queueSize: this.processingQueue.size,
      });
    }
  }

  private async getDepositsWithCache(
    depositIds: bigint[],
  ): Promise<GovLstDeposit[]> {
    const now = Date.now();
    const deposits: GovLstDeposit[] = [];

    for (const id of depositIds) {
      const idStr = id.toString();
      const cached = this.depositCache.get(idStr);

      if (
        cached &&
        now - cached.timestamp < GovLstProfitabilityEngineWrapper.CACHE_TTL
      ) {
        deposits.push(cached.deposit);
        continue;
      }

      const deposit = await this.db.getDeposit(idStr);
      if (!deposit) throw new DepositNotFoundError(idStr);

      const govLstDeposit = this.convertToGovLstDeposit(deposit);
      this.depositCache.set(idStr, {
        deposit: govLstDeposit,
        timestamp: now,
      });
      deposits.push(govLstDeposit);
    }

    return deposits;
  }

  private convertToGovLstDeposit(deposit: DatabaseDeposit): GovLstDeposit {
    if (!deposit.deposit_id || !deposit.owner_address || !deposit.amount) {
      throw new InvalidDepositDataError(deposit);
    }

    return {
      deposit_id: BigInt(deposit.deposit_id),
      owner_address: deposit.owner_address,
      depositor_address: deposit.depositor_address,
      delegatee_address: deposit.delegatee_address || '',
      amount: BigInt(deposit.amount),
      shares_of: BigInt(deposit.amount),
      payout_amount: BigInt(0),
      rewards: BigInt(0),
      earning_power: BigInt(deposit.earning_power || '0'),
      created_at: deposit.created_at || new Date().toISOString(),
      updated_at: deposit.updated_at || new Date().toISOString(),
    };
  }

  /**
   * Checks for unclaimed rewards and processes profitable deposits
   * This method runs periodically to identify and process deposits with unclaimed rewards
   */
  private async checkAndProcessRewards(): Promise<void> {
    try {
      this.logger.info('Starting reward check cycle with components:', {
        isRunning: this.isRunning,
        queueSize: this.processingQueue.size,
      });

      // Get all deposits from database
      const deposits = await this.db.getAllDeposits();
      this.logger.info(
        `Found ${deposits.length} deposits to check for rewards`,
      );

      if (deposits.length === 0) {
        this.logger.info('No deposits found to check');
        return;
      }

      // Check each deposit for unclaimed rewards
      const profitableDeposits: DatabaseDeposit[] = [];
      const depositDetails: Array<{ depositId: bigint; rewards: bigint }> = [];

      for (const deposit of deposits) {
        try {
          // Skip deposits with no ID
          if (!deposit.deposit_id) continue;

          // Get unclaimed rewards for this deposit
          const unclaimedRewards = await (
            this.engine as IGovLstProfitabilityEngine & {
              stakerContract: {
                unclaimedReward: (depositId: string) => Promise<bigint>;
              };
            }
          ).stakerContract.unclaimedReward(deposit.deposit_id);

          this.logger.info(
            `Unclaimed rewards for deposit ${deposit.deposit_id}:`,
            {
              depositId: deposit.deposit_id,
              rewards: unclaimedRewards.toString(),
              owner: deposit.owner_address,
              amount: deposit.amount,
            },
          );

          // Add deposits with non-zero rewards to the profitable list
          if (unclaimedRewards > 0n) {
            profitableDeposits.push(deposit);
            depositDetails.push({
              depositId: BigInt(deposit.deposit_id),
              rewards: unclaimedRewards,
            });
          }
        } catch (error) {
          this.logger.error(
            `Error checking rewards for deposit ${deposit.deposit_id}:`,
            { error },
          );
          // Continue with other deposits
        }
      }

      this.logger.info(
        `Found ${profitableDeposits.length} deposits with unclaimed rewards`,
      );

      // Process profitable deposits if any found
      if (profitableDeposits.length > 0) {
        // Calculate total rewards and shares
        const totalRewards = depositDetails.reduce(
          (sum, detail) => sum + detail.rewards,
          0n,
        );

        const totalShares = profitableDeposits.reduce(
          (sum, deposit) => sum + BigInt(deposit.amount),
          0n,
        );

        // Get current gas price and estimate total gas cost
        const gasPrice = await this.provider.getFeeData();
        const gasEstimate = BigInt(300000);
        const gasBuffer = BigInt(this.engine.config.gasPriceBuffer);
        const totalGasCost =
          (gasEstimate * (gasPrice.gasPrice || 0n) * (100n + gasBuffer)) / 100n;

        const minProfitMargin = this.engine.config.minProfitMargin;
        const isReallyProfitable =
          totalRewards > totalGasCost + minProfitMargin;

        if (!isReallyProfitable) {
          this.logger.info(
            'Skipping deposits - not profitable after gas costs:',
            {
              totalRewards: ethers.formatEther(totalRewards),
              estimatedGasCost: ethers.formatEther(totalGasCost),
              minProfitMargin: ethers.formatEther(minProfitMargin),
            },
          );
          return;
        }

        // Create profitability check object for all deposits
        const profitabilityCheck: GovLstProfitabilityCheck = {
          is_profitable: true,
          constraints: {
            has_enough_shares: true,
            meets_min_reward: true,
            meets_min_profit: true,
          },
          estimates: {
            expected_profit: totalRewards - totalGasCost,
            gas_estimate: gasEstimate,
            total_shares: totalShares,
            payout_amount: totalRewards,
          },
          deposit_details: depositDetails,
        };

        try {
          // First validate the transaction
          await this.executor.validateTransaction(
            profitableDeposits.map((d) => BigInt(d.deposit_id)),
            profitabilityCheck,
          );

          // If validation succeeds, create database entries
          // Update or create processing queue items
          for (const deposit of profitableDeposits) {
            // Check for existing queue item
            const existingItem = await this.db.getProcessingQueueItem(
              deposit.deposit_id,
            );
            if (existingItem) {
              // Update existing item
              await this.db.updateProcessingQueueItem(existingItem.id, {
                status: ProcessingQueueStatus.PENDING,
                delegatee: deposit.delegatee_address || '',
              });
              this.logger.info(
                `Updated existing queue item for deposit ${deposit.deposit_id}`,
              );
            } else {
              // Create new item
              await this.db.createProcessingQueueItem({
                deposit_id: deposit.deposit_id,
                status: ProcessingQueueStatus.PENDING,
                delegatee: deposit.delegatee_address || '',
              });
              this.logger.info(
                `Created new queue item for deposit ${deposit.deposit_id}`,
              );
            }
          }

          // Create a single transaction queue item for all deposits
          const txQueueItem = await this.db.createTransactionQueueItem({
            deposit_id: profitableDeposits.map((d) => d.deposit_id).join(','),
            status: TransactionQueueStatus.PENDING,
            tx_data: JSON.stringify({
              depositIds: profitableDeposits.map((d) => d.deposit_id),
              totalRewards: totalRewards.toString(),
              profitability: this.serializeBigInts(profitabilityCheck),
            }),
          });

          // Queue the transaction with the executor
          const queueResult = await this.executor.queueTransaction(
            profitableDeposits.map((d) => BigInt(d.deposit_id)),
            profitabilityCheck,
            JSON.stringify({
              depositIds: profitableDeposits.map((d) => d.deposit_id),
              totalRewards: totalRewards.toString(),
              profitability: this.serializeBigInts(profitabilityCheck),
              queueItemId: txQueueItem.id,
            }),
          );

          this.logger.info('Transaction processing status:', {
            queueItemId: txQueueItem.id,
            depositIds: profitableDeposits.map((d) => d.deposit_id),
            totalRewards: ethers.formatEther(totalRewards),
            gasEstimate: gasEstimate.toString(),
            executorStatus: await this.executor.getStatus(),
            queueResult,
          });
        } catch (error) {
          this.logger.error('Failed to validate/queue transaction:', { error });
          throw error; // No cleanup needed since we validate before creating database entries
        }
      } else {
        this.logger.info('No profitable deposits found in this check cycle');
      }
    } catch (error) {
      this.logger.error('Error in reward check cycle:', {
        error,
        message: 'Skipping current cycle and continuing to next one',
      });
    }
  }

  get config(): ProfitabilityEngineConfig {
    return this.engine.config;
  }
}
