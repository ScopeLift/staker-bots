import { BigNumberish, ethers } from 'ethers';
import { IDatabase, ProcessingCheckpoint } from '@/database';

export interface MonitorConfig {
  provider: ethers.Provider;
  stakerAddress: string;
  tokenAddress: string;
  rewardCalculatorAddress?: string;
  rewardNotifierAddress: string;
  networkName: string;
  chainId: number;
  startBlock: number;
  pollInterval: number;
  database: IDatabase;
  maxBlockRange: number;
  maxRetries: number;
  lstAddress: string;
  reorgDepth: number;
  confirmations: number;
  healthCheckInterval: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  databaseType: 'json' | 'supabase';
}

export interface StakeDepositedEvent {
  depositId: string;
  ownerAddress: string;
  delegateeAddress: string;
  depositorAddress: string;
  amount: BigNumberish;
  blockNumber: number;
  transactionHash: string;
}

export interface StakeWithdrawnEvent {
  depositId: string;
  blockNumber: number;
  transactionHash: string;
  withdrawnAmount: bigint;
}

export interface DelegateeAlteredEvent {
  depositId: string;
  oldDelegatee: string;
  newDelegatee: string;
  blockNumber: number;
  transactionHash: string;
}

export interface ProcessingResult {
  success: boolean;
  error?: Error;
  retryable: boolean;
  blockNumber: number;
  eventHash: string;
}

export interface MonitorStatus {
  isRunning: boolean;
  lastProcessedBlock: number;
  currentChainBlock: number;
  processingLag: number;
  lastCheckpoint: ProcessingCheckpoint;
  networkStatus: {
    chainId: number;
    networkName: string;
    isConnected: boolean;
  };
}

export interface EventGroup {
  deposited?: ethers.EventLog;
  lstDeposited?: ethers.EventLog;
  altered?: ethers.EventLog;
  stakedWithAttribution?: ethers.EventLog;
  unstaked?: ethers.EventLog;
  depositInitialized?: ethers.EventLog;
  depositUpdated?: ethers.EventLog;
}

export interface TransactionEntry {
  txHash: string;
  events: EventGroup;
  blockNumber: number;
}

export interface GovLstContractInfo {
  depositId?: string;
  defaultDelegatee?: string;
  isDefaultDelegatee?: boolean;
}

export interface StakedWithAttributionEvent {
  depositId: string;
  amount: BigNumberish;
  referrer: string;
  blockNumber: number;
  transactionHash: string;
}

export interface UnstakedEvent {
  account: string;
  amount: BigNumberish;
  blockNumber: number;
  transactionHash: string;
}

export interface DepositInitializedEvent {
  delegatee: string;
  depositId: string;
  blockNumber: number;
  transactionHash: string;
}

export interface DepositUpdatedEvent {
  holder: string;
  oldDepositId: string;
  newDepositId: string;
  blockNumber: number;
  transactionHash: string;
}
