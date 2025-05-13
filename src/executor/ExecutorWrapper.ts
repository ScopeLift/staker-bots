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
import {
  serializeProfitabilityCheck,
  getCurrentBlockNumberWithRetry,
  sleep,
} from './strategies/helpers';
import { RelayerExecutorWithMEV, MEVRelayerExecutorConfig } from './strategies/RelayerExecutorWithMEV';

// Basic sleep function implementation if not available in utils
// const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Supported executor types
 */
export enum ExecutorType {
  WALLET = 'wallet',
  DEFENDER = 'defender',
  WALLET_WITH_MEV = 'wallet_with_mev',
  DEFENDER_WITH_MEV = 'defender_with_mev',
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

// Add MEV-specific configuration interface
export interface MEVConfig {
  useMevProtection: boolean;
  flashbots?: {
    rpcUrl?: string;
    chainId?: number;
    fast?: boolean;
  };
  wallet?: {
    privateKey?: string;
  };
}

/**
 * Wrapper class that manages different executor implementations
 * Provides a unified interface for interacting with executors
 */
export class ExecutorWrapper {
  private executor: IExecutor;
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
    } else if (type === ExecutorType.DEFENDER_WITH_MEV) {
      // Create a RelayerExecutorWithMEV with MEV protection
      const mevConfig: MEVRelayerExecutorConfig = {
        ...EXECUTOR.DEFAULT_RELAYER_CONFIG,
        ...(config as Partial<ExtendedRelayerExecutorConfig>),
        errorLogger: this.errorLogger,
        useMevProtection: true,
        // Add wallet config if provided
        wallet: {
          privateKey: process.env.EXECUTOR_PRIVATE_KEY || '',
          ...(config as any)?.wallet,
        },
        // Add flashbots config if provided
        flashbots: {
          chainId: Number(process.env.CHAIN_ID || '1'),
          fast: process.env.FLASHBOTS_FAST_MODE !== 'false',
          rpcUrl: process.env.FLASHBOTS_RPC_URL || '',
          ...(config as any)?.flashbots,
        },
      };

      this.executor = new RelayerExecutorWithMEV(
        lstContract, 
        provider, 
        mevConfig
      );
    } else if (type === ExecutorType.WALLET_WITH_MEV) {
      // For wallet with MEV, we'll also use RelayerExecutorWithMEV but configure it differently
      const mevConfig: MEVRelayerExecutorConfig = {
        ...EXECUTOR.DEFAULT_RELAYER_CONFIG,
        apiKey: '',    // Not used with wallet
        apiSecret: '', // Not used with wallet
        address: '',   // Not used with wallet
        errorLogger: this.errorLogger,
        useMevProtection: true,
        // Add wallet config using private key from env or config
        wallet: {
          privateKey: process.env.EXECUTOR_PRIVATE_KEY || '',
          ...(config as Partial<ExtendedExecutorConfig>)?.wallet,
        },
        // Add flashbots config if provided
        flashbots: {
          chainId: Number(process.env.CHAIN_ID || '1'),
          fast: process.env.FLASHBOTS_FAST_MODE !== 'false',
          rpcUrl: process.env.FLASHBOTS_RPC_URL || '',
          ...(config as any)?.flashbots,
        },
      };

      this.executor = new RelayerExecutorWithMEV(
        lstContract, 
        provider, 
        mevConfig
      );
    } else {
      throw new ExecutorError(
        `Invalid executor type: ${type}. Must be one of: ${Object.values(ExecutorType).join(', ')}`,
        { type },
        false,
      );
    }

    // Set database if provided
    if (db && this.executor.setDatabase) {
      this.executor.setDatabase(db);
    }
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
            severity: 'fatal',
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
   * Helper to potentially validate Defender credentials if enough time has passed.
   * Assumes the underlying RelayerExecutor has a method like `validateCredentials`.
   */
  private async ensureDefenderCredentialsValid(): Promise<void> {
    if (this.type !== ExecutorType.DEFENDER) return;

    const oneHour = 3600 * 1000;
    if (Date.now() - this.lastDefenderValidationTimestamp > oneHour) {
      this.logger.info(
        'Attempting to validate Defender credentials (after 1 hour)...',
      );
      try {
        // Check if the executor has the validateCredentials method
        if (this.executor.validateCredentials) {
          await this.executor.validateCredentials();
          this.logger.info('Defender credentials validated successfully.');
        } else {
          this.logger.warn(
            'RelayerExecutor does not have a validateCredentials method.',
          );
        }
        this.lastDefenderValidationTimestamp = Date.now();
      } catch (error) {
        this.logger.error('Failed to validate Defender credentials', {
          error: error instanceof Error ? error.message : String(error),
        });
        // Check if it's a 403 error, if so, prepare to exit
        if (error instanceof Error && error.message.includes('403')) {
          this.logger.error(
            'CRITICAL: Defender credential validation resulted in 403. Exiting process.',
          );
          process.exit(1); // Exit the process, PM2 should restart it
        }
        // Otherwise, rethrow as a potentially retryable error
        throw new ExecutorError(
          'Defender credential validation failed',
          { error: error instanceof Error ? error.message : String(error) },
          true,
        );
      }
    }
  }

  /**
   * Queues a transaction for execution
   * @param depositIds - Array of deposit IDs to claim rewards for
   * @param profitability - Profitability check results
   * @param txData - Optional transaction data
   * @returns Queued transaction object
   */
  async queueTransaction(
    depositIds: bigint[],
    profitability: GovLstProfitabilityCheck,
    txData?: string,
  ): Promise<QueuedTransaction | null> {
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
      // Parse txData if it's a string and contains profitability data
      let processedProfitability = profitability;
      if (txData) {
        try {
          const parsedData = JSON.parse(txData);
          if (parsedData.profitability) {
            processedProfitability = serializeProfitabilityCheck(
              parsedData.profitability,
            );
          }
        } catch (parseError) {
          this.logger.error('Failed to parse txData', {
            error:
              parseError instanceof Error
                ? parseError.message
                : String(parseError),
            txData,
          });

          if (this.errorLogger) {
            await this.errorLogger.warn(parseError as Error, {
              context: 'parse-tx-data',
              txData,
            });
          }
        }
      }

      const currentBlock = await getCurrentBlockNumberWithRetry(
        this.provider,
        this.logger,
      );
      const result = await this.executor.queueTransaction(
        depositIds,
        processedProfitability,
        txData,
      );

      // Update checkpoint after successful transaction queueing
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

      return result;
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

  /**
   * Gets statistics about the transaction queue
   * @returns Queue statistics
   */
  async getQueueStats(): Promise<QueueStats> {
    try {
      return await this.executor.getQueueStats();
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
}
