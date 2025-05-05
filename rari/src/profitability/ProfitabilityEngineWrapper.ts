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
import { ErrorLogger } from '@/configuration/errorLogger';
import { TransactionType } from '@/database/interfaces/types';

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
 * Enhanced config to support error logger
 */
export interface EnhancedConfig extends ProfitabilityConfig {
  errorLogger?: ErrorLogger;
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
  private readonly errorLogger?: ErrorLogger;

  constructor(
    private readonly db: DatabaseWrapper,
    govLstContract: ethers.Contract,
    stakerContract: ethers.Contract,
    provider: ethers.Provider,
    private readonly logger: Logger,
    config: EnhancedConfig,
    private readonly executor: IExecutor,
  ) {
    this.provider = provider;
    this.errorLogger = config.errorLogger;

    // Pass the error logger to the engine
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
      {
        ...config,
        errorLogger: this.errorLogger, // Pass error logger to the engine
      },
    );
  }

  async checkGroupProfitability(
    deposits: GovLstDeposit[],
  ): Promise<GovLstProfitabilityCheck> {
    try {
      return await this.engine.checkGroupProfitability(deposits);
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'wrapper-checkGroupProfitability',
          depositCount: deposits.length,
        });
      }
      throw error;
    }
  }

  async getProfitableTransactions(): Promise<ProfitableTransaction[]> {
    return this.profitableTransactions;
  }

  async clearProfitableTransactions(): Promise<void> {
    this.profitableTransactions = [];
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    try {
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
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'profitability-engine-start',
        });
      } else {
        this.logger.error('Failed to start profitability engine:', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    try {
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
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'profitability-engine-stop',
        });
      } else {
        this.logger.error('Failed to stop profitability engine:', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
      throw error;
    }
  }

  async getStatus(): Promise<{
    isRunning: boolean;
    lastGasPrice: bigint;
    lastUpdateTimestamp: number;
    queueSize: number;
    groupCount: number;
  }> {
    try {
      const baseStatus = await this.engine.getStatus();
      return {
        ...baseStatus,
        queueSize: this.processingQueue.size,
        groupCount: 0,
      };
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'profitability-engine-getStatus',
        });
      }
      throw error;
    }
  }

  async analyzeAndGroupDeposits(
    deposits: GovLstDeposit[],
  ): Promise<GovLstBatchAnalysis> {
    try {
      return await this.engine.analyzeAndGroupDeposits(deposits);
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'analyzeAndGroupDeposits',
          depositCount: deposits.length,
        });
      }
      throw error;
    }
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
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'requeue-pending-items',
          operation: 'requeue',
        });
      }
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
        deposits.push(await this.convertToGovLstDeposit(deposit));
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
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'process-queue',
          queueSize: this.processingQueue.size,
        });
      } else {
        // Log the specific error details
        this.logger.error('Queue processing error:', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          queueSize: this.processingQueue.size,
        });
      }

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
          if (this.errorLogger) {
            await this.errorLogger.error(dbError as Error, {
              context: 'update-processing-queue-item',
              depositId: id,
            });
          } else {
            this.logger.error('Failed to update processing queue item:', {
              error:
                dbError instanceof Error ? dbError.message : String(dbError),
              depositId: id,
            });
          }
        }
      }

      throw new QueueProcessingError(error as Error, {
        queueSize: this.processingQueue.size,
      });
    }
  }

  private async convertToGovLstDeposit(
    deposit: DatabaseDeposit,
  ): Promise<GovLstDeposit> {
    try {
      // Log the incoming deposit data for debugging
      this.logger.debug('Converting database deposit:', {
        deposit_id: deposit.deposit_id,
        owner_address: deposit.owner_address,
        amount: deposit.amount,
        delegatee_address: deposit.delegatee_address,
        earning_power: deposit.earning_power,
      });

      // Validate required fields
      if (!deposit.deposit_id) {
        throw new InvalidDepositDataError({
          deposit,
          cause: new Error('Missing deposit_id'),
        });
      }

      if (!deposit.owner_address) {
        throw new InvalidDepositDataError({
          deposit,
          cause: new Error('Missing owner_address'),
        });
      }

      // amount can be 0, but must be defined
      if (typeof deposit.amount === 'undefined' || deposit.amount === null) {
        throw new InvalidDepositDataError({
          deposit,
          cause: new Error('Amount field is undefined or null'),
        });
      }

      // Handle numeric conversions safely
      let depositId: bigint;
      let amount: bigint;
      let earningPower: bigint;

      try {
        depositId = BigInt(deposit.deposit_id);
        // Validate deposit_id is not negative
        if (depositId < 0n) {
          throw new Error('Negative deposit_id is not allowed');
        }
      } catch (error) {
        throw new InvalidDepositDataError({
          deposit,
          cause: new Error(`Invalid deposit_id format: ${deposit.deposit_id}`),
        });
      }

      try {
        // Handle both string and number inputs for amount
        amount =
          typeof deposit.amount === 'string'
            ? BigInt(deposit.amount)
            : BigInt(Math.floor(deposit.amount));

        // Allow zero amounts but not negative
        if (amount < 0n) {
          throw new Error('Negative amount is not allowed');
        }
      } catch (error) {
        throw new InvalidDepositDataError({
          deposit,
          cause: new Error(`Invalid amount format: ${deposit.amount}`),
        });
      }

      try {
        if (
          deposit.earning_power === undefined ||
          deposit.earning_power === null
        ) {
          earningPower = BigInt(0);
        } else {
          earningPower =
            typeof deposit.earning_power === 'string'
              ? BigInt(deposit.earning_power)
              : BigInt(Math.floor(deposit.earning_power));

          // Allow zero earning power but not negative
          if (earningPower < 0n) {
            this.logger.warn('Negative earning_power found, defaulting to 0:', {
              deposit_id: deposit.deposit_id,
              earning_power: deposit.earning_power,
            });
            earningPower = BigInt(0);
          }
        }
      } catch (error) {
        if (this.errorLogger) {
          await this.errorLogger.warn(
            `Invalid earning_power format, defaulting to 0: ${deposit.earning_power}`,
            {
              context: 'convert-deposit',
              deposit_id: deposit.deposit_id,
            },
          );
        } else {
          this.logger.warn('Invalid earning_power format, defaulting to 0:', {
            deposit_id: deposit.deposit_id,
            earning_power: deposit.earning_power,
          });
        }
        earningPower = BigInt(0);
      }

      // Create and return the GovLstDeposit object
      const govLstDeposit: GovLstDeposit = {
        deposit_id: depositId,
        owner_address: deposit.owner_address,
        depositor_address: deposit.depositor_address || deposit.owner_address, // Default to owner if not specified
        delegatee_address: deposit.delegatee_address || '', // Empty string if not specified
        amount: amount,
        shares_of: amount, // Default to amount if not specified
        payout_amount: BigInt(0), // Will be set during processing
        rewards: BigInt(0), // Will be calculated during processing
        earning_power: earningPower,
        created_at: deposit.created_at || new Date().toISOString(),
        updated_at: deposit.updated_at || new Date().toISOString(),
      };

      // Log successful conversion
      this.logger.debug('Successfully converted deposit:', {
        deposit_id: govLstDeposit.deposit_id.toString(),
        amount: govLstDeposit.amount.toString(),
        earning_power: govLstDeposit.earning_power.toString(),
      });

      return govLstDeposit;
    } catch (error) {
      // Log detailed error information
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'convert-deposit',
          deposit_id: deposit.deposit_id,
          owner_address: deposit.owner_address
            ? deposit.owner_address.substring(0, 6) + '...'
            : undefined,
        });
      } else {
        this.logger.error('Failed to convert deposit data:', {
          error: error instanceof Error ? error.message : String(error),
          deposit_id: deposit.deposit_id,
          owner_address: deposit.owner_address,
          amount: deposit.amount,
          stack: error instanceof Error ? error.stack : undefined,
        });
      }

      // Re-throw with proper error type
      if (error instanceof InvalidDepositDataError) {
        throw error;
      }

      throw new InvalidDepositDataError({
        deposit,
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  // Add helper function for BigInt serialization
  private serializeBigIntValues(
    obj: Record<string, unknown> | unknown[] | unknown,
  ): Record<string, unknown> | unknown[] | unknown {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === 'bigint') {
      return obj.toString();
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.serializeBigIntValues(item));
    }

    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(
        obj as Record<string, unknown>,
      )) {
        result[key] = this.serializeBigIntValues(value);
      }
      return result;
    }

    return obj;
  }

  private async createQueueItems(
    deposits: GovLstDeposit[],
    profitability: GovLstProfitabilityCheck,
  ): Promise<void> {
    try {
      // Serialize profitability check data for database storage
      const serializedProfitability = this.serializeBigIntValues(profitability);

      // Create processing queue items for each deposit
      for (const deposit of deposits) {
        const depositId = deposit.deposit_id.toString();

        // Check if deposit is already in processing queue
        const existingItem =
          await this.db.getProcessingQueueItemByDepositId(depositId);

        const queueItem = {
          deposit_id: depositId,
          status: ProcessingQueueStatus.PENDING,
          delegatee: deposit.delegatee_address,
          last_profitability_check: JSON.stringify(serializedProfitability),
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

      // Serialize transaction data
      const txData = {
        depositIds: deposits.map((d) => d.deposit_id.toString()),
        expectedProfit: profitability.estimates.expected_profit.toString(),
        gasEstimate: profitability.estimates.gas_estimate.toString(),
        totalShares: profitability.estimates.total_shares.toString(),
      };

      const txQueueItem = await this.db.createTransactionQueueItem({
        deposit_id: firstDeposit.deposit_id.toString(),
        status: TransactionQueueStatus.PENDING,
        tx_data: JSON.stringify(txData),
        transaction_type: TransactionType.CLAIM_AND_DISTRIBUTE,
      });

      this.logger.info('Created queue items:', {
        processingQueueCount: deposits.length,
        transactionQueueId: txQueueItem.id,
        firstDepositId: firstDeposit.deposit_id.toString(),
      });
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'create-queue-items',
          depositCount: deposits.length,
          firstDepositId: deposits[0]?.deposit_id.toString(),
        });
      } else {
        this.logger.error('Failed to create queue items:', {
          error: error instanceof Error ? error.message : String(error),
          depositCount: deposits.length,
          firstDepositId: deposits[0]?.deposit_id.toString(),
        });
      }
      throw error;
    }
  }

  // Update checkAndProcessRewards to use serialized values when queueing transactions
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
      this.logger.info(
        `Found ${deposits.length} deposits to check for rewards`,
      );

      if (deposits.length === 0) {
        this.logger.info('No deposits to process, skipping cycle');
        return;
      }

      // Log sample deposit for debugging
      if (deposits.length > 0) {
        const firstDeposit = deposits[0];
        if (firstDeposit && firstDeposit.owner_address) {
          this.logger.debug('Sample deposit structure:', {
            first_deposit: {
              ...firstDeposit,
              // Don't log sensitive data
              owner_address: '0x....' + firstDeposit.owner_address.slice(-4),
              depositor_address: firstDeposit.depositor_address
                ? '0x....' + firstDeposit.depositor_address.slice(-4)
                : undefined,
            },
          });
        }
      }

      // Filter out deposits that are already in a transaction queue
      const depositsToCheck = [];
      for (const deposit of deposits) {
        const existingTxQueueItem =
          await this.db.getTransactionQueueItemByDepositId(deposit.deposit_id);
        if (
          existingTxQueueItem &&
          (existingTxQueueItem.status === TransactionQueueStatus.PENDING ||
            existingTxQueueItem.status === TransactionQueueStatus.SUBMITTED)
        ) {
          this.logger.info(
            `Skipping deposit ${deposit.deposit_id} - already in transaction queue`,
          );
          continue;
        }
        depositsToCheck.push(deposit);
      }

      // Convert database deposits to GovLstDeposits
      const govLstDeposits = [];
      for (const deposit of depositsToCheck) {
        const govLstDeposit = await this.convertToGovLstDeposit(deposit);
        govLstDeposits.push(govLstDeposit);
      }

      // Use GovLstProfitabilityEngine to analyze deposits
      const analysis =
        await this.engine.analyzeAndGroupDeposits(govLstDeposits);

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
            deposit_details: group.deposit_ids.map((id) => ({
              depositId: id,
              rewards: BigInt(0), // Will be calculated by contract
            })),
          };

          // Validate the transaction first
          await this.executor.validateTransaction(
            group.deposit_ids,
            profitabilityCheck,
          );

          // Create queue items using the helper method
          const groupDeposits = govLstDeposits.filter((d) =>
            group.deposit_ids.includes(d.deposit_id),
          );
          await this.createQueueItems(groupDeposits, profitabilityCheck);

          // Queue transaction with executor using serialized data
          const serializedTxData = this.serializeBigIntValues({
            depositIds: group.deposit_ids,
            totalRewards: group.total_rewards,
            expectedProfit: group.expected_profit,
            gasEstimate: group.gas_estimate,
          });

          await this.executor.queueTransaction(
            group.deposit_ids,
            profitabilityCheck,
            JSON.stringify(serializedTxData),
          );

          this.logger.info('Successfully queued profitable group:', {
            groupSize: group.deposit_ids.length,
            totalRewards: group.total_rewards.toString(),
            expectedProfit: group.expected_profit.toString(),
            gasEstimate: group.gas_estimate.toString(),
          });
        } catch (error) {
          if (this.errorLogger) {
            await this.errorLogger.error(error as Error, {
              context: 'process-profitable-group',
              depositIds: group.deposit_ids.map(String),
            });
          } else {
            this.logger.error('Failed to process profitable group:', {
              error: error instanceof Error ? error.message : String(error),
              depositIds: group.deposit_ids.map(String),
            });
          }
          // Continue with next group
        }
      }
    } catch (error) {
      if (this.errorLogger) {
        if (error instanceof InvalidDepositDataError) {
          await this.errorLogger.error(error, {
            context: 'check-process-rewards-invalid-deposit',
            retryable: error.retryable,
          });
        } else {
          await this.errorLogger.error(error as Error, {
            context: 'check-process-rewards',
            type:
              error instanceof Error ? error.constructor.name : typeof error,
          });
        }
      } else {
        if (error instanceof InvalidDepositDataError) {
          this.logger.error('Invalid deposit data encountered:', {
            error: error.message,
            context: error.context,
            retryable: error.retryable,
          });
        } else {
          this.logger.error('Error in reward check cycle:', {
            error: error instanceof Error ? error.message : String(error),
            type:
              error instanceof Error ? error.constructor.name : typeof error,
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      }

      // Continue to next cycle
      this.logger.info('Skipping current cycle and continuing to next one');
    }
  }

  /**
   * Handle score event updates for a delegatee
   * @param delegatee The delegatee address
   * @param score The new score value
   */
  async onScoreEvent(delegatee: string, score: bigint): Promise<void> {
    try {
      this.logger.info('Processing score event', {
        delegatee,
        score: score.toString(),
      });

      // Get all deposits for this delegatee
      const deposits = await this.db.getDepositsByDelegatee(delegatee);
      if (!deposits.length) {
        this.logger.info('No deposits found for delegatee', { delegatee });
        return;
      }

      // Convert deposits and check profitability
      const govLstDeposits = await Promise.all(
        deposits.map((d) => this.convertToGovLstDeposit(d))
      );

      const profitabilityCheck = await this.checkGroupProfitability(govLstDeposits);
      if (!profitabilityCheck.is_profitable) {
        this.logger.info('Deposits not profitable after score update', {
          delegatee,
          depositCount: deposits.length,
        });
        return;
      }

      // Create queue items for profitable deposits
      await this.createQueueItems(govLstDeposits, profitabilityCheck);

      this.logger.info('Successfully processed score event', {
        delegatee,
        depositCount: deposits.length,
        profitable: profitabilityCheck.is_profitable,
      });
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'onScoreEvent',
          delegatee,
          score: score.toString(),
        });
      }
      throw error;
    }
  }

  get config(): ProfitabilityEngineConfig {
    return this.engine.config;
  }
}