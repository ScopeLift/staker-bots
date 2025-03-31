import { ExecutorConfig, RelayerExecutorConfig } from './interfaces/types';
import { ethers } from 'ethers';

export const EXECUTOR_EVENTS = {
  TRANSACTION_QUEUED: 'Transaction queued for execution',
  TRANSACTION_STARTED: 'Started executing transaction',
  TRANSACTION_CONFIRMED: 'Transaction confirmed',
  TRANSACTION_FAILED: 'Transaction failed',
  QUEUE_PROCESSED: 'Processed transaction queue',
  TIPS_TRANSFERRED: 'Transferred accumulated tips',
  ERROR: 'Executor error occurred',
} as const;

export const GAS_CONSTANTS = {
  GAS_PRICE_UPDATE_INTERVAL: 60_000, // 1 minute
  GAS_PRICE_BUFFER_PERCENT: 30, // 30%
  MIN_GAS_LIMIT: 150_000n, // Minimum gas limit for reward claims
  MAX_GAS_LIMIT: 500_000n, // Maximum gas limit for reward claims
  GAS_LIMIT_BUFFER: 1.2, // 20% buffer on gas estimates
} as const;

export const QUEUE_CONSTANTS = {
  QUEUE_PROCESSOR_INTERVAL: 15000, // 15 seconds
  MAX_BATCH_SIZE: 100, // Maximum number of deposits per batch
  MIN_BATCH_SIZE: 1, // Minimum number of deposits per batch
  MAX_RETRIES: 3, // Maximum number of retries per transaction
  RETRY_DELAY: 5000, // 5 seconds between retries
} as const;

export const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = {
  wallet: {
    privateKey: '',
    minBalance: ethers.parseEther('0.1'), // 0.1 ETH
    maxPendingTransactions: 5,
  },
  maxQueueSize: 100,
  minConfirmations: 2,
  maxRetries: QUEUE_CONSTANTS.MAX_RETRIES,
  retryDelayMs: QUEUE_CONSTANTS.RETRY_DELAY,
  transferOutThreshold: ethers.parseEther('0.5'), // 0.5 ETH
  gasBoostPercentage: GAS_CONSTANTS.GAS_PRICE_BUFFER_PERCENT,
  concurrentTransactions: 3,
  defaultTipReceiver: '',
};

export const DEFAULT_RELAYER_EXECUTOR_CONFIG: RelayerExecutorConfig = {
  apiKey: '',
  apiSecret: '',
  address: '',
  minBalance: ethers.parseEther('0.1'), // 0.1 ETH
  maxPendingTransactions: 5,
  gasPolicy: {
    maxFeePerGas: undefined,
    maxPriorityFeePerGas: undefined,
  },
  maxQueueSize: 100,
  minConfirmations: 2,
  maxRetries: QUEUE_CONSTANTS.MAX_RETRIES,
  retryDelayMs: QUEUE_CONSTANTS.RETRY_DELAY,
  transferOutThreshold: ethers.parseEther('0.5'), // 0.5 ETH
  gasBoostPercentage: GAS_CONSTANTS.GAS_PRICE_BUFFER_PERCENT,
  concurrentTransactions: 3,
  defaultTipReceiver: '',
};

export const CONTRACT_CONSTANTS = {
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',
  MIN_SHARES_THRESHOLD: 1000n, // Minimum shares required for claiming
} as const;
