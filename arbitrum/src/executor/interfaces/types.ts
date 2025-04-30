import { ProfitabilityCheck } from '@/profitability/interfaces/types';

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
  depositId: bigint;
  profitability: ProfitabilityCheck;
  status: TransactionStatus;
  hash?: string;
  error?: Error;
  createdAt: Date;
  executedAt?: Date;
  gasPrice?: bigint;
  gasLimit?: bigint;
  tx_data?: string;
  retryCount?: number;
}

export enum TransactionStatus {
  QUEUED = 'QUEUED',
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
}

export interface ExecutorConfig {
  wallet: WalletConfig;
  maxQueueSize: number;
  minConfirmations: number;
  maxRetries: number;
  retryDelayMs: number;
  transferOutThreshold: bigint;
  gasBoostPercentage: number;
  concurrentTransactions: number;
  defaultTipReceiver?: string;
}

export interface RelayerExecutorConfig extends Omit<ExecutorConfig, 'wallet'> {
  relayer: RelayerConfig;
}

export interface TransactionReceipt {
  hash: string;
  status: boolean;
  blockNumber: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

export interface QueueStats {
  totalQueued: number;
  totalPending: number;
  totalConfirmed: number;
  totalFailed: number;
  averageExecutionTime: number;
  averageGasPrice: bigint;
  totalProfits: bigint;
}
