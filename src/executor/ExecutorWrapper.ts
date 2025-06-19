import { ethers } from 'ethers';
import { BaseExecutor } from './strategies/BaseExecutor';
import { RelayerExecutor } from './strategies/RelayerExecutor';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import {
  ExecutorConfig,
  QueuedTransaction,
  QueueStats,
  TransactionReceipt,
  RelayerExecutorConfig,
} from './interfaces/types';
import { EXECUTOR } from '@/configuration/constants';
import { GovLstProfitabilityCheck } from '@/profitability/interfaces/types';
import { IExecutor } from './interfaces/IExecutor';
import { DatabaseWrapper } from '@/database';
import {
  ExecutorError,
  TransactionValidationError,
} from '@/configuration/errors';
import { ErrorLogger } from '@/configuration/errorLogger';
import { getCurrentBlockNumberWithRetry, sleep } from './strategies/helpers';
import { QueueManager } from './QueueManager';
import {
  TransactionType,
  TransactionQueueStatus,
} from '@/database/interfaces/types';
import { TransactionStatus } from './interfaces/types';

/**
 * Supported executor types
 */
export enum ExecutorType {
  WALLET = 'wallet',
  DEFENDER = 'defender',
}

/**
 * Extended configs with error logger
 */
export interface ExtendedExecutorConfig extends ExecutorConfig {
  errorLogger?: ErrorLogger;
}

export interface ExtendedRelayerExecutorConfig extends RelayerExecutorConfig {
  errorLogger?: ErrorLogger;
}

/**
 * Wrapper class that manages different executor implementations
 * Provides a unified interface for interacting with executors
 */
export class ExecutorWrapper {
  private executor: IExecutor;
  private bumpQueue: QueueManager;
  private claimQueue: QueueManager;
  private readonly logger: Logger;
  private readonly errorLogger?: ErrorLogger;
  private isRunning = false;
  private lastProcessedBlock = 0;
  private readonly provider: ethers.Provider;
  private readonly type: ExecutorType; // Store executor type
  private lastDefenderValidationTimestamp = 0; // Timestamp for Defender validation check

  /**
   * Creates a new ExecutorWrapper instance
   * @param stakerContract - The staker contract instance
   * @param provider - Ethereum provider
   * @param type - Type of executor to use (WALLET or DEFENDER)
   * @param config - Executor configuration
   * @param db - Optional database instance
   */
  constructor(
    lstContract: ethers.Contract,
    provider: ethers.Provider,
    type: ExecutorType = ExecutorType.WALLET,
    config: Partial<
      ExtendedExecutorConfig | ExtendedRelayerExecutorConfig
    > = {},
    private readonly db?: DatabaseWrapper,
  ) {
    if (!provider) {
      throw new ExecutorError('Provider is required', {}, false);
    }

    if (!lstContract?.target || !lstContract?.interface) {
      throw new ExecutorError(
        'Invalid staker contract provided',
        { contract: lstContract },
        false,
      );
    }

    if (!this.db) {
      throw new ExecutorError('Database instance is required', {}, false);
    }

    this.logger = new ConsoleLogger('info');
    this.errorLogger = config.errorLogger;
    this.provider = provider;
    this.type = type; // Store the type

    if (type === ExecutorType.WALLET) {
      // Create a BaseExecutor with local wallet
      const fullConfig: ExtendedExecutorConfig = {
        ...EXECUTOR.DEFAULT_CONFIG,
        ...(config as Partial<ExtendedExecutorConfig>),
        wallet: {
          ...EXECUTOR.DEFAULT_CONFIG.wallet,
          ...(config as Partial<ExtendedExecutorConfig>).wallet,
        },
        errorLogger: this.errorLogger,
      };

      this.executor = new BaseExecutor({
        contractAddress: lstContract.target as string,
        contractAbi: lstContract.interface,
        provider,
        config: fullConfig,
      });
    } else if (type === ExecutorType.DEFENDER) {
      // Create a RelayerExecutor with OpenZeppelin Defender
      const fullConfig: ExtendedRelayerExecutorConfig = {
        ...EXECUTOR.DEFAULT_RELAYER_CONFIG,
        ...(config as Partial<ExtendedRelayerExecutorConfig>),
        errorLogger: this.errorLogger,
      };

      this.executor = new RelayerExecutor(lstContract, provider, fullConfig);
      this.lastDefenderValidationTimestamp = Date.now(); // Initialize timestamp
    } else {
      throw new ExecutorError(
        `Invalid executor type: ${type}. Must be '${ExecutorType.WALLET}' or '${ExecutorType.DEFENDER}'`,
        { type },
        false,
      );
    }

    // Set database if provided
    if (this.executor.setDatabase) {
      this.executor.setDatabase(this.db);
    }

    this.bumpQueue = new QueueManager(TransactionType.BUMP, this.db);
    this.claimQueue = new QueueManager(
      TransactionType.CLAIM_AND_DISTRIBUTE,
      this.db,
    );
  }

  /**
   * Starts the executor service
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    try {
      // Load last checkpoint
      const checkpoint = await this.db?.getCheckpoint('executor');
      if (checkpoint) {
        this.lastProcessedBlock = checkpoint.last_block_number;
        this.logger.info('Executor resuming from checkpoint', {
          lastProcessedBlock: this.lastProcessedBlock,
        });
      } else {
        // Initialize checkpoint if none exists
        const currentBlock = await this.provider.getBlockNumber();
        this.lastProcessedBlock = currentBlock;
        await this.db?.updateCheckpoint({
          component_type: 'executor',
          last_block_number: currentBlock,
          block_hash: ethers.ZeroHash,
          last_update: new Date().toISOString(),
        });
      }

      this.isRunning = true;
      this.logger.info('Executor started');
      await this.executor.start();
    } catch (error) {
      this.logger.error('Failed to start executor', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'executor-start',
        });
      }

      throw new ExecutorError(
        'Failed to start executor',
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
  }

  /**
   * Stops the executor service
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    try {
      this.isRunning = false;
      this.logger.info('Executor stopped');
      await this.executor.stop();
    } catch (error) {
      this.logger.error('Failed to stop executor', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'executor-stop',
        });
      }

      throw new ExecutorError(
        'Failed to stop executor',
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
  }

  /**
   * Gets the current status of the executor
   * @returns Current executor status
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    walletBalance: bigint;
    pendingTransactions: number;
    queueSize: number;
  }> {
    try {
      return await this.executor.getStatus();
    } catch (error) {
      if (
        this.type === ExecutorType.DEFENDER &&
        error instanceof Error &&
        error.message.includes('403')
      ) {
        this.logger.error(
          'CRITICAL: Received 403 from Defender. Exiting process.',
          { error: error.message },
        );

        if (this.errorLogger) {
          await this.errorLogger.error(error as Error, {
            context: 'defender-authentication-failure',
            severity: 'critical',
          });
        }

        process.exit(1);
      }

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'get-executor-status',
        });
      }

      throw new ExecutorError(
        'Failed to get executor status',
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
  }

  /**
   * Validate a transaction before queueing
   * @param depositIds - Array of deposit IDs to claim rewards for
   * @param profitability - Profitability check results
   * @returns true if the transaction is valid, throws TransactionValidationError otherwise
   */
  async validateTransaction(
    depositIds: bigint[],
    profitability: GovLstProfitabilityCheck,
  ): Promise<{ isValid: boolean; error: TransactionValidationError | null }> {
    try {
      const { isValid, error } = await this.executor.validateTransaction(
        depositIds,
        profitability,
      );
      if (!isValid) {
        throw error;
      }
      return {
        isValid: true,
        error: null,
      };
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'validate-transaction',
          depositIds: depositIds.map(String),
          profitability,
        });
      }

      throw new ExecutorError(
        'Failed to validate transaction',
        {
          error: error instanceof Error ? error.message : String(error),
          depositIds: depositIds.map(String),
          profitability,
        },
        false,
      );
    }
  }

  /**
   * Queues a transaction for execution
   * @param depositIds - Array of deposit IDs to claim rewards for
   * @param profitability - Profitability check results
   * @param txData - Optional transaction data
   * @param transactionType - Type of transaction
   * @returns Queued transaction object
   */
  async queueTransaction(
    depositIds: bigint[],
    profitability: GovLstProfitabilityCheck,
    txData?: string,
    transactionType: TransactionType = TransactionType.BUMP,
  ): Promise<QueuedTransaction> {
    if (!this.isRunning) {
      const error = new ExecutorError('Executor is not running', {
        depositIds: depositIds.map((id) => id.toString()),
        profitability,
      });

      if (this.errorLogger) {
        await this.errorLogger.warn(error, {
          context: 'queue-transaction-not-running',
        });
      }

      throw error;
    }

    try {
      // Choose the appropriate queue based on transaction type
      const queue =
        transactionType === TransactionType.BUMP
          ? this.bumpQueue
          : this.claimQueue;

      const queueItem = await queue.addTransaction(
        depositIds,
        profitability,
        txData,
      );

      // Also queue the transaction in the underlying executor for actual execution
      const executorTransaction = await this.executor.queueTransaction(
        depositIds,
        profitability,
        txData,
      );

      // Convert QueueItem to QueuedTransaction but use executor transaction ID
      const queuedTransaction: QueuedTransaction = {
        id: executorTransaction.id,
        depositIds,
        profitability,
        status: executorTransaction.status,
        createdAt: executorTransaction.createdAt,
        hash: queueItem.hash,
        tx_data: queueItem.tx_data,
        metadata: {
          queueItemId: queueItem.id,
          depositIds: depositIds.map(String),
        },
      };

      // Update checkpoint after successful transaction queueing
      await this.updateCheckpoint();

      return queuedTransaction;
    } catch (error) {
      if (
        this.type === ExecutorType.DEFENDER &&
        error instanceof Error &&
        error.message.includes('403')
      ) {
        this.logger.error(
          'CRITICAL: Received 403 from Defender. Exiting process.',
          { error: error.message },
        );

        if (this.errorLogger) {
          await this.errorLogger.fatal(error as Error, {
            context: 'defender-authentication-failure',
            operation: 'queue-transaction',
          });
        }

        process.exit(1);
      }

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'queue-transaction',
          depositIds: depositIds.map(String),
        });
      }

      throw new ExecutorError(
        'Failed to queue transaction',
        {
          error: error instanceof Error ? error.message : String(error),
          depositIds: depositIds.map(String),
        },
        true,
      );
    }
  }

  private mapQueueStatus(status: TransactionQueueStatus): TransactionStatus {
    switch (status) {
      case TransactionQueueStatus.PENDING:
        return TransactionStatus.QUEUED;
      case TransactionQueueStatus.SUBMITTED:
        return TransactionStatus.PENDING;
      case TransactionQueueStatus.CONFIRMED:
        return TransactionStatus.CONFIRMED;
      case TransactionQueueStatus.FAILED:
        return TransactionStatus.FAILED;
      default:
        return TransactionStatus.QUEUED;
    }
  }

  /**
   * Gets statistics about the transaction queue
   * @returns Queue statistics
   */
  async getQueueStats(): Promise<QueueStats> {
    try {
      const [bumpStats, claimStats] = await Promise.all([
        this.bumpQueue.getQueueStats(),
        this.claimQueue.getQueueStats(),
      ]);

      return {
        totalItems: bumpStats.total + claimStats.total,
        pendingItems: bumpStats.pending + claimStats.pending,
        failedItems: bumpStats.failed + claimStats.failed,
        byType: {
          [TransactionType.BUMP]: {
            total: bumpStats.total,
            pending: bumpStats.pending,
            submitted: bumpStats.submitted,
            confirmed: bumpStats.confirmed,
            failed: bumpStats.failed,
          },
          [TransactionType.CLAIM_AND_DISTRIBUTE]: {
            total: claimStats.total,
            pending: claimStats.pending,
            submitted: claimStats.submitted,
            confirmed: claimStats.confirmed,
            failed: claimStats.failed,
          },
        },
      };
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'get-queue-stats',
        });
      }

      throw new ExecutorError(
        'Failed to get queue statistics',
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
  }

  /**
   * Gets a specific transaction by ID
   * @param id - Transaction ID
   * @returns Transaction object or null if not found
   */
  async getTransaction(id: string): Promise<QueuedTransaction | null> {
    try {
      return await this.executor.getTransaction(id);
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'get-transaction',
          transactionId: id,
        });
      }

      throw new ExecutorError(
        'Failed to get transaction',
        {
          error: error instanceof Error ? error.message : String(error),
          transactionId: id,
        },
        true,
      );
    }
  }

  /**
   * Gets a transaction receipt
   * @param hash - Transaction hash
   * @returns Transaction receipt or null if not found
   */
  async getTransactionReceipt(
    hash: string,
  ): Promise<TransactionReceipt | null> {
    try {
      return await this.executor.getTransactionReceipt(hash);
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'get-transaction-receipt',
          transactionHash: hash,
        });
      }

      throw new ExecutorError(
        'Failed to get transaction receipt',
        {
          error: error instanceof Error ? error.message : String(error),
          transactionHash: hash,
        },
        true,
      );
    }
  }

  /**
   * Transfers accumulated tips to the configured receiver
   * @returns Transaction receipt or null if transfer not needed/possible
   */
  async transferOutTips(): Promise<TransactionReceipt | null> {
    try {
      return await this.executor.transferOutTips();
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'transfer-out-tips',
        });
      }

      throw new ExecutorError(
        'Failed to transfer tips',
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
  }

  /**
   * Clears the transaction queue
   */
  async clearQueue(): Promise<void> {
    try {
      await this.executor.clearQueue();
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'clear-queue',
        });
      }

      throw new ExecutorError(
        'Failed to clear queue',
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
  }

  private async updateCheckpoint(): Promise<void> {
    const currentBlock = await getCurrentBlockNumberWithRetry(
      this.provider,
      this.logger,
    );

    if (currentBlock > this.lastProcessedBlock) {
      let block: ethers.Block | null = null;
      for (let i = 0; i < 3; i++) {
        try {
          block = await this.provider.getBlock(currentBlock);
          if (block) break;
        } catch (blockError) {
          this.logger.warn(
            `Failed to get block details for ${currentBlock} (attempt ${i + 1}/3)`,
            { error: blockError },
          );

          if (this.errorLogger) {
            await this.errorLogger.warn(blockError as Error, {
              context: 'get-block-details',
              blockNumber: currentBlock,
              attempt: i + 1,
            });
          }

          await sleep(500 * (i + 1));
        }
      }

      if (!block) {
        const blockError = new Error(
          `Block ${currentBlock} not found after retries`,
        );
        this.logger.error(
          `Block ${currentBlock} not found after retries. Cannot update checkpoint.`,
        );

        if (this.errorLogger) {
          await this.errorLogger.error(blockError, {
            context: 'update-checkpoint-block-not-found',
            blockNumber: currentBlock,
          });
        }

        throw blockError;
      }

      await this.db?.updateCheckpoint({
        component_type: 'executor',
        last_block_number: currentBlock,
        block_hash: block.hash!,
        last_update: new Date().toISOString(),
      });
      this.lastProcessedBlock = currentBlock;
    }
  }
}
