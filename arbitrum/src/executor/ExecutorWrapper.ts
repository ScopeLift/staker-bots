import { ethers } from 'ethers';
import { BaseExecutor } from './strategies/BaseExecutor';
import { RelayerExecutor } from './strategies/RelayerExecutor';
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
import { ProfitabilityCheck } from '@/profitability/interfaces/types';
import { IExecutor } from './interfaces/IExecutor';
import { DatabaseWrapper } from '@/database';

export enum ExecutorType {
  WALLET = 'WALLET',
  RELAYER = 'RELAYER',
}

export class ExecutorWrapper {
  private executor: IExecutor;

  constructor(
    stakerContract: ethers.Contract,
    provider: ethers.Provider,
    type: ExecutorType = ExecutorType.WALLET,
    config: Partial<ExecutorConfig | RelayerExecutorConfig> = {},
    private readonly db?: DatabaseWrapper, // Database access
  ) {
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

      this.executor = new BaseExecutor(
        stakerContract.target as string,
        stakerContract.interface,
        provider,
        fullConfig,
      );
      if (db && this.executor.setDatabase) {
        this.executor.setDatabase(db);
      }
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
      if (db && this.executor.setDatabase) {
        this.executor.setDatabase(db);
      }
    } else {
      throw new Error(`Unsupported executor type: ${type}`);
    }
  }

  /**
   * Start the executor
   */
  async start(): Promise<void> {
    await this.executor.start();
  }

  /**
   * Stop the executor
   */
  async stop(): Promise<void> {
    await this.executor.stop();
  }

  /**
   * Get the current status of the executor
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    walletBalance: bigint;
    pendingTransactions: number;
    queueSize: number;
  }> {
    return this.executor.getStatus();
  }

  /**
   * Queue a transaction for execution
   */
  async queueTransaction(
    depositId: bigint,
    profitability: ProfitabilityCheck,
    txData?: string,
  ): Promise<QueuedTransaction> {
    return this.executor.queueTransaction(depositId, profitability, txData);
  }

  /**
   * Get statistics about the transaction queue
   */
  async getQueueStats(): Promise<QueueStats> {
    return this.executor.getQueueStats();
  }

  /**
   * Get a specific transaction by ID
   */
  async getTransaction(id: string): Promise<QueuedTransaction | null> {
    return this.executor.getTransaction(id);
  }

  /**
   * Get transaction receipt
   */
  async getTransactionReceipt(
    hash: string,
  ): Promise<TransactionReceipt | null> {
    return this.executor.getTransactionReceipt(hash);
  }

  /**
   * Transfer accumulated tips to the configured receiver
   */
  async transferOutTips(): Promise<TransactionReceipt | null> {
    return this.executor.transferOutTips();
  }

  /**
   * Clear the transaction queue
   */
  async clearQueue(): Promise<void> {
    await this.executor.clearQueue();
  }
}
