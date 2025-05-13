import { ProfitabilityCheck } from "@/profitability/interfaces/types";

export interface WalletConfig {
  privateKey: string;
  minBalance: bigint;
  maxPendingTransactions: number;
}

// OpenZeppelin Defender Relayer configuration
export interface RelayerConfig {
  apiKey: string;
  apiSecret: string;
  minBalance: bigint;
  maxPendingTransactions: number;
  gasPolicy?: {
    maxPriorityFeePerGas?: bigint;
    maxFeePerGas?: bigint;
  };
}

export interface QueuedTransaction {
  id: string;
  depositIds: bigint[];
  depositId?: bigint; // For backward compatibility
  profitability: ProfitabilityCheck;
  status: TransactionStatus;
  error?: Error;
  tx_data?: string;
  metadata?: {
    queueItemId?: string;
    depositIds?: string[];
  };
  gasPrice?: bigint;
  createdAt: Date;
  executedAt?: Date;
  hash?: string;
  retryCount?: number;
}

export enum TransactionStatus {
  QUEUED = 'QUEUED',
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
}

export interface ExecutorConfig {
  chainId: number;
  wallet: {
    privateKey: string;
    minBalance: bigint;
    maxPendingTransactions: number;
  };
  maxQueueSize: number;
  minConfirmations: number;
  maxRetries: number;
  retryDelayMs: number;
  transferOutThreshold: bigint;
  gasBoostPercentage: number;
  concurrentTransactions: number;
  defaultTipReceiver: string;
  minProfitMargin: number;
  staleTransactionThresholdMinutes: number;
}

export interface RelayerExecutorConfig {
  chainId: number;
  relayer: {
    apiKey: string;
    apiSecret: string;
    address: string;
    maxPendingTransactions?: number;
    gasPolicy?: {
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
    };
  };
  gasBoostPercentage?: number;
  maxPendingTransactions?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  confirmations?: number;
  maxQueueSize?: number;
  minConfirmations?: number;
  concurrentTransactions?: number;
}

export interface TransactionReceipt {
  hash: string;
  blockNumber: number;
  gasUsed: bigint;
  gasPrice: bigint;
  status: boolean;
  logs: TransactionLog[];
  effectiveGasPrice?: bigint;
}

export interface QueueStats {
  totalTransactions: number;
  pendingTransactions: number;
  confirmedTransactions: number;
  failedTransactions: number;
  averageGasUsed?: bigint;
  totalGasUsed?: bigint;
  totalQueued: number;
  totalPending: number;
  totalConfirmed: number;
  totalFailed: number;
  averageExecutionTime: number;
  averageGasPrice: bigint;
  totalProfits: bigint;
}

export interface TransactionLog {
  address: string;
  topics: string[];
  data: string;
}

export interface EthersTransactionReceipt {
  transactionHash: string;
  blockNumber: number;
  gasUsed: bigint;
  status: number;
  logs: TransactionLog[];
}

export interface DefenderError extends Error {
  response?: {
    status: number;
    statusText: string;
    data?: {
      error?: {
        code: string;
        message: string;
        suggestedNonce?: number;
        suggestedGasLimit?: number;
      };
    };
  };
  config?: {
    method?: string;
    url?: string;
    data?: unknown;
  };
}

export interface GasEstimationError extends Error {
  data?: {
    code: string;
    message: string;
    details?: string;
  };
}
