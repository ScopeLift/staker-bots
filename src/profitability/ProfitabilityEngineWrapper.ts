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

interface ProfitableTransaction {
  deposit_id: bigint;
  unclaimed_rewards: bigint;
  expected_profit: bigint;
}

/**
 * Wrapper for the GovLst profitability engine that handles analysis and processing
 */
export class GovLstProfitabilityEngineWrapper
  implements IGovLstProfitabilityEngine
{
  private readonly engine: IGovLstProfitabilityEngine;
  private readonly processingQueue: Set<string> = new Set();
  private queueProcessorInterval: NodeJS.Timeout | null = null;
  private rewardCheckInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastProcessedBlock = 0;
  private static readonly REWARD_CHECK_INTERVAL =
    CONFIG.profitability.rewardCheckInterval;
  private profitableTransactions: ProfitableTransaction[] = [];
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

  async checkGroupProfitability(
    deposits: GovLstDeposit[],
  ): Promise<GovLstProfitabilityCheck> {
    return this.engine.checkGroupProfitability(deposits);
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
      const deposits: GovLstDeposit[] = [];

      // Get deposits directly from database
      for (const id of Array.from(this.processingQueue)) {
        const deposit = await this.db.getDeposit(id);
        if (!deposit) throw new DepositNotFoundError(id);
        deposits.push(this.convertToGovLstDeposit(deposit));
      }

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

  private convertToGovLstDeposit(deposit: DatabaseDeposit): GovLstDeposit {
    if (!deposit.deposit_id || !deposit.owner_address || !deposit.amount) {
      throw new InvalidDepositDataError(deposit);
    }

    // Ensure all numeric values are properly converted to BigInt
    try {
      return {
        deposit_id: BigInt(deposit.deposit_id),
        owner_address: deposit.owner_address,
        depositor_address: deposit.depositor_address,
        delegatee_address: deposit.delegatee_address || '',
        amount: BigInt(deposit.amount),
        shares_of: BigInt(deposit.amount), // Default to amount if not specified
        payout_amount: BigInt(0), // Will be set during processing
        rewards: BigInt(0), // Will be calculated during processing
        earning_power: deposit.earning_power ? BigInt(deposit.earning_power) : BigInt(0),
        created_at: deposit.created_at || new Date().toISOString(),
        updated_at: deposit.updated_at || new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Failed to convert deposit data:', {
        error: error instanceof Error ? error.message : String(error),
        deposit,
      });
      throw new InvalidDepositDataError({
        deposit,
        cause: error instanceof Error ? error : new Error(String(error))
      });
    }
  }

  // Add helper method for consistent queue item creation
  private async createQueueItems(
    deposits: GovLstDeposit[],
    profitability: GovLstProfitabilityCheck,
  ): Promise<void> {
    try {
      // Create processing queue items for each deposit
      for (const deposit of deposits) {
        const depositId = deposit.deposit_id.toString();
        
        // Check if deposit is already in processing queue
        const existingItem = await this.db.getProcessingQueueItemByDepositId(depositId);
        
        const queueItem = {
          deposit_id: depositId,
          status: ProcessingQueueStatus.PENDING,
          delegatee: deposit.delegatee_address,
          last_profitability_check: JSON.stringify(profitability),
        };

        if (existingItem) {
          await this.db.updateProcessingQueueItem(existingItem.id, queueItem);
        } else {
          await this.db.createProcessingQueueItem(queueItem);
        }
      }

      // Create transaction queue item for the group
      const firstDeposit = deposits[0];
      if (!firstDeposit) {
        throw new Error('No deposits available for transaction queue item');
      }

      const txQueueItem = await this.db.createTransactionQueueItem({
        deposit_id: firstDeposit.deposit_id.toString(),
        status: TransactionQueueStatus.PENDING,
        tx_data: JSON.stringify({
          depositIds: deposits.map(d => d.deposit_id.toString()),
          expectedProfit: profitability.estimates.expected_profit.toString(),
          gasEstimate: profitability.estimates.gas_estimate.toString(),
          totalShares: profitability.estimates.total_shares.toString(),
        }),
      });

      this.logger.info('Created queue items:', {
        processingQueueCount: deposits.length,
        transactionQueueId: txQueueItem.id,
      });
    } catch (error) {
      this.logger.error('Failed to create queue items:', {
        error: error instanceof Error ? error.message : String(error),
        depositCount: deposits.length,
      });
      throw error;
    }
  }

  // Update checkAndProcessRewards to use the new helpers
  private async checkAndProcessRewards(): Promise<void> {
    try {
      // Get executor status first
      const executorStatus = await this.executor.getStatus();
      this.logger.info('Starting reward check cycle with components:', {
        isRunning: executorStatus.isRunning,
        queueSize: executorStatus.queueSize,
      });

      // Get all deposits to check
      const deposits = await this.db.getAllDeposits();
      this.logger.info(`Found ${deposits.length} deposits to check for rewards`);

      // Filter out deposits that are already in a transaction queue
      const depositsToCheck = [];
      for (const deposit of deposits) {
        const existingTxQueueItem = await this.db.getTransactionQueueItemByDepositId(deposit.deposit_id);
        if (existingTxQueueItem && 
            (existingTxQueueItem.status === TransactionQueueStatus.PENDING || 
             existingTxQueueItem.status === TransactionQueueStatus.SUBMITTED)) {
          this.logger.info(`Skipping deposit ${deposit.deposit_id} - already in transaction queue`);
          continue;
        }
        depositsToCheck.push(deposit);
      }

      // Convert database deposits to GovLstDeposits
      const govLstDeposits = depositsToCheck.map(deposit => this.convertToGovLstDeposit(deposit));

      // Use GovLstProfitabilityEngine to analyze deposits
      const analysis = await this.engine.analyzeAndGroupDeposits(govLstDeposits);

      this.logger.info('Deposit analysis results:', {
        totalGroups: analysis.deposit_groups.length,
        totalExpectedProfit: ethers.formatEther(analysis.total_expected_profit),
        totalGasEstimate: analysis.total_gas_estimate.toString(),
        totalDeposits: analysis.total_deposits,
      });

      // Process each profitable group
      for (const group of analysis.deposit_groups) {
        try {
          const profitabilityCheck = {
            is_profitable: true,
            constraints: {
              has_enough_shares: true,
              meets_min_reward: true,
              meets_min_profit: true,
            },
            estimates: {
              expected_profit: group.expected_profit,
              gas_estimate: group.gas_estimate,
              gas_cost: group.gas_estimate,
              total_shares: group.total_shares,
              payout_amount: group.total_payout,
            },
            deposit_details: group.deposit_ids.map(id => ({
              depositId: id,
              rewards: BigInt(0), // Will be calculated by contract
            })),
          };

          // Validate the transaction first
          await this.executor.validateTransaction(group.deposit_ids, profitabilityCheck);

          // Create queue items using the helper method
          const groupDeposits = govLstDeposits.filter(d => 
            group.deposit_ids.includes(d.deposit_id)
          );
          await this.createQueueItems(groupDeposits, profitabilityCheck);

          // Queue transaction with executor
          await this.executor.queueTransaction(
            group.deposit_ids,
            profitabilityCheck,
            JSON.stringify({
              depositIds: group.deposit_ids.map(String),
              totalRewards: group.total_rewards.toString(),
              expectedProfit: group.expected_profit.toString(),
              gasEstimate: group.gas_estimate.toString(),
            }),
          );

          this.logger.info('Successfully queued profitable group:', {
            groupSize: group.deposit_ids.length,
            totalRewards: ethers.formatEther(group.total_rewards),
            expectedProfit: ethers.formatEther(group.expected_profit),
            gasEstimate: group.gas_estimate.toString(),
          });
        } catch (error) {
          this.logger.error('Failed to process profitable group:', {
            error: error instanceof Error ? error.message : String(error),
            depositIds: group.deposit_ids.map(String),
          });
          // Continue with next group
        }
      }
    } catch (error) {
      this.logger.error('Error in reward check cycle:', {
        error: error instanceof Error ? error.message : String(error),
        message: 'Skipping current cycle and continuing to next one',
      });
    }
  }

  get config(): ProfitabilityEngineConfig {
    return this.engine.config;
  }
}
