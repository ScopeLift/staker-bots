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
import {
  DEFAULT_EXECUTOR_CONFIG,
  DEFAULT_RELAYER_EXECUTOR_CONFIG,
} from './constants';
import { GovLstProfitabilityCheck } from '@/profitability/interfaces/types';
import { IExecutor } from './interfaces/IExecutor';
import { DatabaseWrapper } from '@/database';
import { ExecutorError } from './errors';

/**
 * Supported executor types
 */
export enum ExecutorType {
  WALLET = 'WALLET',
  RELAYER = 'RELAYER',
}

/**
 * Wrapper class that manages different executor implementations
 * Provides a unified interface for interacting with executors
 */
export class ExecutorWrapper {
  private executor: IExecutor;
  private readonly logger: Logger;

  /**
   * Creates a new ExecutorWrapper instance
   * @param stakerContract - The staker contract instance
   * @param provider - Ethereum provider
   * @param type - Type of executor to use (WALLET or RELAYER)
   * @param config - Executor configuration
   * @param db - Optional database instance
   */
  constructor(
    stakerContract: ethers.Contract,
    provider: ethers.Provider,
    type: ExecutorType = ExecutorType.WALLET,
    config: Partial<ExecutorConfig | RelayerExecutorConfig> = {},
    private readonly db?: DatabaseWrapper,
  ) {
    if (!provider) {
      throw new ExecutorError('Provider is required', {}, false);
    }

    if (!stakerContract?.target || !stakerContract?.interface) {
      throw new ExecutorError(
        'Invalid staker contract provided',
        { contract: stakerContract },
        false
      );
    }

    this.logger = new ConsoleLogger('info');

    if (type === ExecutorType.WALLET) {
      // Create a BaseExecutor with local wallet
      const fullConfig: ExecutorConfig = {
        ...DEFAULT_EXECUTOR_CONFIG,
        ...(config as Partial<ExecutorConfig>),
        wallet: {
          ...DEFAULT_EXECUTOR_CONFIG.wallet,
          ...(config as Partial<ExecutorConfig>).wallet,
        },
      };

      this.executor = new BaseExecutor({
        contractAddress: stakerContract.target as string,
        contractAbi: stakerContract.interface,
        provider,
        config: fullConfig,
      });
    } else if (type === ExecutorType.RELAYER) {
      // Create a RelayerExecutor with OpenZeppelin Defender
      const fullConfig: RelayerExecutorConfig = {
        ...DEFAULT_RELAYER_EXECUTOR_CONFIG,
        ...(config as Partial<RelayerExecutorConfig>),
        relayer: {
          ...DEFAULT_RELAYER_EXECUTOR_CONFIG.relayer,
          ...(config as Partial<RelayerExecutorConfig>).relayer,
        },
      };

      this.executor = new RelayerExecutor(stakerContract, provider, fullConfig);
    } else {
      throw new ExecutorError(
        `Unsupported executor type: ${type}`,
        { type },
        false
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
    try {
      await this.executor.start();
    } catch (error) {
      throw new ExecutorError(
        'Failed to start executor',
        { error: error instanceof Error ? error.message : String(error) },
        true
      );
    }
  }

  /**
   * Stops the executor service
   */
  async stop(): Promise<void> {
    try {
      await this.executor.stop();
    } catch (error) {
      throw new ExecutorError(
        'Failed to stop executor',
        { error: error instanceof Error ? error.message : String(error) },
        true
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
      throw new ExecutorError(
        'Failed to get executor status',
        { error: error instanceof Error ? error.message : String(error) },
        true
      );
    }
  }

  private serializeProfitabilityCheck(check: GovLstProfitabilityCheck): GovLstProfitabilityCheck {
    // Convert string values back to BigInt if they were serialized
    const parseBigInt = (value: string | bigint): bigint => {
      return typeof value === 'string' ? BigInt(value) : value;
    };

    return {
      ...check,
      estimates: {
        expected_profit: parseBigInt(check.estimates.expected_profit),
        gas_estimate: parseBigInt(check.estimates.gas_estimate),
        total_shares: parseBigInt(check.estimates.total_shares),
        payout_amount: parseBigInt(check.estimates.payout_amount)
      },
      deposit_details: check.deposit_details.map(detail => ({
        ...detail,
        depositId: parseBigInt(detail.depositId),
        rewards: parseBigInt(detail.rewards)
      }))
    };
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
  ): Promise<QueuedTransaction> {
    try {
      // Parse txData if it's a string and contains profitability data
      let processedProfitability = profitability;
      if (txData) {
        try {
          const parsedData = JSON.parse(txData);
          if (parsedData.profitability) {
            processedProfitability = this.serializeProfitabilityCheck(parsedData.profitability);
          }
        } catch (error) {
          this.logger.error('Failed to parse txData', {
            error: error instanceof Error ? error.message : String(error),
            txData
          });
        }
      }

      return await this.executor.queueTransaction(
        depositIds,
        processedProfitability,
        txData
      );
    } catch (error) {
      throw new ExecutorError(
        'Failed to queue transaction',
        {
          error: error instanceof Error ? error.message : String(error),
          depositIds: depositIds.map(String),
          profitability,
        },
        true
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
      throw new ExecutorError(
        'Failed to get queue statistics',
        { error: error instanceof Error ? error.message : String(error) },
        true
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
      throw new ExecutorError(
        'Failed to get transaction',
        {
          error: error instanceof Error ? error.message : String(error),
          transactionId: id,
        },
        true
      );
    }
  }

  /**
   * Gets a transaction receipt
   * @param hash - Transaction hash
   * @returns Transaction receipt or null if not found
   */
  async getTransactionReceipt(hash: string): Promise<TransactionReceipt | null> {
    try {
      return await this.executor.getTransactionReceipt(hash);
    } catch (error) {
      throw new ExecutorError(
        'Failed to get transaction receipt',
        {
          error: error instanceof Error ? error.message : String(error),
          transactionHash: hash,
        },
        true
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
      throw new ExecutorError(
        'Failed to transfer tips',
        { error: error instanceof Error ? error.message : String(error) },
        true
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
      throw new ExecutorError(
        'Failed to clear queue',
        { error: error instanceof Error ? error.message : String(error) },
        true
      );
    }
  }
}
