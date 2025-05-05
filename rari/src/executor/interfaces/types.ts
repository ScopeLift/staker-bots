import { GovLstProfitabilityCheck } from '@/profitability/interfaces/types';
import { TransactionType } from '@/database/interfaces/types';

export interface WalletConfig {
  privateKey: string;
  minBalance: bigint;
  maxPendingTransactions: number;
}

// OpenZeppelin Defender Relayer configuration
export interface RelayerConfig {
  apiKey: string;
  apiSecret: string;
  address: string;
  minBalance: bigint;
  maxPendingTransactions: number;
  gasPolicy?: {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  };
}

export interface QueuedTransaction {
  id: string;
  depositIds: bigint[];
  profitability: GovLstProfitabilityCheck;
  status: TransactionStatus;
  createdAt: Date;
  executedAt?: Date;
  hash?: string;
  gasPrice?: bigint;
  gasLimit?: bigint;
  error?: Error;
  tx_data?: string;
  metadata?: {
    queueItemId?: string;
    depositIds?: string[];
    [key: string]: string | string[] | undefined;
  };
}

export enum TransactionStatus {
  QUEUED = 'QUEUED',
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
}

export interface ExecutorConfig {
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
  staleTransactionThresholdMinutes?: number;
}

export interface RelayerExecutorConfig {
  apiKey: string;
  apiSecret: string;
  address: string;
  minBalance: bigint;
  maxPendingTransactions: number;
  gasPolicy?: {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
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
  staleTransactionThresholdMinutes?: number;
}

export interface TransactionReceipt {
  hash: string;
  blockNumber: number;
  gasUsed: bigint;
  gasPrice: bigint;
  status: number;
  logs: Array<{
    address: string;
    topics: Array<string>;
    data: string;
  }>;
}

export interface QueueItemStats {
  total: number;
  pending: number;
  submitted: number;
  confirmed: number;
  failed: number;
  averageGasPrice?: bigint;
  averageGasLimit?: bigint;
  totalProfits?: bigint;
}

export interface QueueStats {
  totalItems: number;
  pendingItems: number;
  failedItems: number;
  byType: Record<TransactionType, QueueItemStats>;
}

export interface GovLstExecutorError extends Error {
  context?: Record<string, unknown>;
}

// Type guard for GovLstExecutorError
export function isGovLstExecutorError(
  error: unknown,
): error is GovLstExecutorError {
  return error instanceof Error && 'context' in error;
}

// Type for ethers.js v6 TransactionReceipt
export interface EthersTransactionReceipt {
  to: string;
  from: string;
  contractAddress: string | null;
  transactionIndex: number;
  gasUsed: bigint;
  logsBloom: string;
  blockHash: string;
  transactionHash: string;
  logs: Array<{
    transactionIndex: number;
    blockNumber: number;
    transactionHash: string;
    address: string;
    topics: Array<string>;
    data: string;
    logIndex: number;
    blockHash: string;
    removed: boolean;
  }>;
  blockNumber: number;
  confirmations: number;
  cumulativeGasUsed: bigint;
  effectiveGasPrice: bigint;
  status: number;
  type: number;
  byzantium: boolean;
}

// Add Defender API error interfaces
export interface DefenderErrorResponse {
  status: number;
  statusText: string;
  data: {
    error?: {
      code: string;
      message: string;
      suggestedNonce?: number;
      suggestedGasLimit?: string;
    };
  };
}

export interface DefenderErrorConfig {
  method?: string;
  url?: string;
  data?: unknown;
}

export interface DefenderError extends Error {
  response?: DefenderErrorResponse;
  config?: DefenderErrorConfig;
}

// Add gas estimation error interface
export interface GasEstimationError extends Error {
  data?: unknown;
}