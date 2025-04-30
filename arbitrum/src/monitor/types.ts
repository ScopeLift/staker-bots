import { BigNumberish, ethers } from 'ethers';
import { IDatabase, ProcessingCheckpoint } from '@/database';

export interface MonitorConfig {
  provider: ethers.Provider;
  stakerAddress: string;
  arbTokenAddress: string;
  rewardCalculatorAddress: string;
  rewardNotifierAddress: string;
  networkName: string;
  chainId: number;
  startBlock: number;
  pollInterval: number;
  database: IDatabase;
  maxBlockRange: number;
  maxRetries: number;
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
