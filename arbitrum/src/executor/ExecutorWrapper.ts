import { ethers } from "ethers";
import { BaseExecutor } from "./strategies/BaseExecutor";
import { RelayerExecutor } from "./strategies/RelayerExecutor";
import { ConsoleLogger } from "@/monitor/logging";
import {
  ExecutorConfig,
  QueuedTransaction,
  QueueStats,
  TransactionReceipt,
  RelayerExecutorConfig,
} from "./interfaces/types";
import { EXECUTOR } from "./constants";
import { ProfitabilityCheck } from "@/profitability/interfaces/types";
import { IExecutor } from "./interfaces/IExecutor";
import { DatabaseWrapper } from "@/database";

/**
 * Supported executor types
 */
export enum ExecutorType {
  WALLET = "wallet",
  RELAYER = "relayer",
}

/**
 * Extended configs with error handling
 */
export interface ExtendedExecutorConfig extends ExecutorConfig {
  errorLogger?: (message: string, context?: Record<string, unknown>) => void;
}

export interface ExtendedRelayerExecutorConfig extends RelayerExecutorConfig {
  errorLogger?: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * Wrapper for executor implementations that handles different execution strategies
 */
export function ExecutorWrapper({
  stakerContract,
  provider,
  type = ExecutorType.WALLET,
  config = {},
  db,
}: {
  stakerContract: ethers.Contract;
  provider: ethers.Provider;
  type?: ExecutorType;
  config?: Partial<ExtendedExecutorConfig | ExtendedRelayerExecutorConfig>;
  db?: DatabaseWrapper;
}): {
  executor: IExecutor;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getStatus: () => Promise<{
    isRunning: boolean;
    walletBalance: bigint;
    pendingTransactions: number;
    queueSize: number;
  }>;
  queueTransaction: (
    depositId: bigint,
    profitability: ProfitabilityCheck,
    txData?: string,
  ) => Promise<QueuedTransaction>;
  getQueueStats: () => Promise<QueueStats>;
  getTransaction: (id: string) => Promise<QueuedTransaction | null>;
  getTransactionReceipt: (hash: string) => Promise<TransactionReceipt | null>;
  transferOutTips: () => Promise<TransactionReceipt | null>;
  clearQueue: () => Promise<void>;
} {
  const logger = new ConsoleLogger("info");

  // Validate inputs
  if (!provider) {
    throw new Error("Provider is required");
  }

  if (!stakerContract?.target || !stakerContract?.interface) {
    throw new Error("Invalid staker contract provided");
  }

  // Initialize executor based on type
  let executor: IExecutor;

  if (type === ExecutorType.WALLET) {
    // Create a BaseExecutor with local wallet
    const fullConfig: ExtendedExecutorConfig = {
      ...EXECUTOR.DEFAULT_CONFIG,
      ...(config as Partial<ExtendedExecutorConfig>),
      wallet: {
        ...EXECUTOR.DEFAULT_CONFIG.wallet,
        ...(config as Partial<ExtendedExecutorConfig>).wallet,
      },
    };

    executor = new BaseExecutor({
      contractAddress: stakerContract.target as string,
      contractInterface: stakerContract.interface,
      provider,
      config: fullConfig,
    });
  } else if (type === ExecutorType.RELAYER) {
    // Create a RelayerExecutor with OpenZeppelin Defender
    const fullConfig: ExtendedRelayerExecutorConfig = {
      ...EXECUTOR.DEFAULT_RELAYER_CONFIG,
      ...(config as Partial<ExtendedRelayerExecutorConfig>),
      relayer: {
        ...EXECUTOR.DEFAULT_RELAYER_CONFIG.relayer,
        ...(config as Partial<ExtendedRelayerExecutorConfig>).relayer,
      },
    };

    executor = new RelayerExecutor(stakerContract, provider, fullConfig);
  } else {
    throw new Error(
      `Invalid executor type: ${type}. Must be 'wallet' or 'relayer'`,
    );
  }

  // Set database if provided
  if (db && executor.setDatabase) {
    executor.setDatabase(db);
  }

  /**
   * Start the executor
   */
  async function start(): Promise<void> {
    try {
      await executor.start();
      logger.info("Executor started");
    } catch (error) {
      logger.error("Failed to start executor", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Stop the executor
   */
  async function stop(): Promise<void> {
    try {
      await executor.stop();
      logger.info("Executor stopped");
    } catch (error) {
      logger.error("Failed to stop executor", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get the current status of the executor
   */
  async function getStatus(): Promise<{
    isRunning: boolean;
    walletBalance: bigint;
    pendingTransactions: number;
    queueSize: number;
  }> {
    try {
      return await executor.getStatus();
    } catch (error) {
      logger.error("Failed to get executor status", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Queue a transaction for execution
   */
  async function queueTransaction(
    depositId: bigint,
    profitability: ProfitabilityCheck,
    txData?: string,
  ): Promise<QueuedTransaction> {
    try {
      return await executor.queueTransaction(depositId, profitability, txData);
    } catch (error) {
      logger.error("Failed to queue transaction", {
        error: error instanceof Error ? error.message : String(error),
        depositId: depositId.toString(),
      });
      throw error;
    }
  }

  /**
   * Get statistics about the transaction queue
   */
  async function getQueueStats(): Promise<QueueStats> {
    try {
      return await executor.getQueueStats();
    } catch (error) {
      logger.error("Failed to get queue stats", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get a specific transaction by ID
   */
  async function getTransaction(id: string): Promise<QueuedTransaction | null> {
    try {
      return await executor.getTransaction(id);
    } catch (error) {
      logger.error("Failed to get transaction", {
        error: error instanceof Error ? error.message : String(error),
        id,
      });
      throw error;
    }
  }

  /**
   * Get transaction receipt
   */
  async function getTransactionReceipt(
    hash: string,
  ): Promise<TransactionReceipt | null> {
    try {
      return await executor.getTransactionReceipt(hash);
    } catch (error) {
      logger.error("Failed to get transaction receipt", {
        error: error instanceof Error ? error.message : String(error),
        hash,
      });
      throw error;
    }
  }

  /**
   * Transfer accumulated tips to the configured receiver
   */
  async function transferOutTips(): Promise<TransactionReceipt | null> {
    try {
      return await executor.transferOutTips();
    } catch (error) {
      logger.error("Failed to transfer out tips", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Clear the transaction queue
   */
  async function clearQueue(): Promise<void> {
    try {
      await executor.clearQueue();
    } catch (error) {
      logger.error("Failed to clear queue", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return {
    executor,
    start,
    stop,
    getStatus,
    queueTransaction,
    getQueueStats,
    getTransaction,
    getTransactionReceipt,
    transferOutTips,
    clearQueue,
  };
}
