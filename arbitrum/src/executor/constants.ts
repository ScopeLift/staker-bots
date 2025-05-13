import { ExecutorConfig, RelayerExecutorConfig } from "./interfaces/types";
import { ethers } from "ethers";

/**
 * Default configuration values for executor components
 */
export const EXECUTOR = {
  /**
   * Default configuration for wallet-based executor
   */
  DEFAULT_CONFIG: {
    chainId: 42161, // Arbitrum One
    wallet: {
      privateKey: "",
      minBalance: ethers.parseEther("0.000001"), // 0.1 ETH
      maxPendingTransactions: 5,
    },
    maxQueueSize: 100,
    minConfirmations: 2,
    maxRetries: 3,
    retryDelayMs: 5000,
    transferOutThreshold: ethers.parseEther("0.5"), // 0.5 ETH
    gasBoostPercentage: 30, // 30%
    concurrentTransactions: 3,
    defaultTipReceiver: "",
  } as ExecutorConfig,

  /**
   * Default configuration for relayer-based executor
   */
  DEFAULT_RELAYER_CONFIG: {
    relayer: {
      apiKey: "",
      apiSecret: "",
      minBalance: ethers.parseEther("0.000001"), // 0.1 ETH
      maxPendingTransactions: 5,
    },
    maxQueueSize: 100,
    minConfirmations: 2,
    maxRetries: 3,
    retryDelayMs: 5000,
    transferOutThreshold: ethers.parseEther("0.5"), // 0.5 ETH
    gasBoostPercentage: 30, // 30%
    concurrentTransactions: 3,
    defaultTipReceiver: "",
  } as RelayerExecutorConfig,
};

// For backward compatibility
export const DEFAULT_EXECUTOR_CONFIG = EXECUTOR.DEFAULT_CONFIG;
export const DEFAULT_RELAYER_EXECUTOR_CONFIG = EXECUTOR.DEFAULT_RELAYER_CONFIG;
