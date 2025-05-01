import { BigNumberish, ethers } from 'ethers';
import { IDatabase, ProcessingCheckpoint } from '@/database';

/**
 * Configuration for the monitor component
 */
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

/**
 * Event data for StakeDeposited events
 */
export interface StakeDepositedEvent {
  depositId: string;
  ownerAddress: string;
  delegateeAddress: string;
  amount: BigNumberish;
  blockNumber: number;
  transactionHash: string;
}

/**
 * Event data for StakeWithdrawn events
 */
export interface StakeWithdrawnEvent {
  depositId: string;
  withdrawnAmount: BigNumberish;
  blockNumber: number;
  transactionHash: string;
}

/**
 * Event data for DelegateeAltered events
 */
export interface DelegateeAlteredEvent {
  depositId: string;
  oldDelegatee: string;
  newDelegatee: string;
  blockNumber: number;
  transactionHash: string;
}

/**
 * Event data for EarningPowerBumped events
 */
export interface EarningPowerBumpedEvent {
  depositId: string;
  oldEarningPower: BigNumberish;
  newEarningPower: BigNumberish;
  bumper: string;
  tipReceiver: string;
  tipAmount: BigNumberish;
  blockNumber: number;
  transactionHash: string;
}

/**
 * Status of the monitor component
 */
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

/**
 * Result of processing an event
 */
export interface ProcessingResult {
  success: boolean;
  blockNumber: number;
  eventHash: string;
  error?: Error;
  retryable: boolean;
}

/**
 * A group of related events from the same transaction
 */
export interface EventGroup {
  deposited?: ethers.Log;
  altered?: ethers.Log;
}

/**
 * Entry for a transaction containing related events
 */
export interface TransactionEntry {
  transactionHash: string;
  blockNumber: number;
  events: EventGroup;
}
