import { ethers } from 'ethers';
import { MonitorConfig } from './types';
import { IDatabase } from '@/database';
import { CONFIG } from '@/configuration';

export const createMonitorConfig = (
  provider: ethers.Provider,
  database: IDatabase,
): MonitorConfig => ({
  provider,
  database,
  tokenAddress: CONFIG.monitor.obolTokenAddress,
  ...CONFIG.monitor,
});

// Default addresses
export const DEFAULT_DELEGATEE_ADDRESS =
  '0x0000000000000000000000000000000000000B01';

// Event names for type safety
export const MONITOR_EVENTS = {
  DELEGATE_EVENT: 'delegateEvent',
  ERROR: 'error',
  STAKE_WITH_ATTRIBUTION: 'stakedWithAttribution',
  UNSTAKED: 'unstaked',
  DEPOSIT_INITIALIZED: 'depositInitialized',
  DEPOSIT_UPDATED: 'depositUpdated',
  CLAIMER_ALTERED: 'claimerAltered',
  REWARD_CLAIMED: 'rewardClaimed',
  DEPOSIT_SUBSIDIZED: 'depositSubsidized',
  EARNING_POWER_BUMPED: 'earningPowerBumped',
} as const;

// Processing constants
export const PROCESSING_COMPONENT = {
  TYPE: 'staker-monitor',
  INITIAL_BLOCK_HASH:
    '0x0000000000000000000000000000000000000000000000000000000000000000',
} as const;

// GovLst contract ABI
export const GOVLST_ABI = [
  {
    inputs: [{ internalType: 'address', name: '_delegatee', type: 'address' }],
    name: 'depositForDelegatee',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'defaultDelegatee',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: '_holder', type: 'address' }],
    name: 'depositIdForHolder',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: '_holder', type: 'address' }],
    name: 'delegateeForHolder',
    outputs: [{ internalType: 'address', name: '_delegatee', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const MONITOR_CONSTANTS = {
  // Default delegatee address
  DEFAULT_DELEGATEE: DEFAULT_DELEGATEE_ADDRESS,

  // Database operation constants
  DB_BATCH_SIZE: 100,
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000,

  // Event processing constants
  MAX_EVENTS_PER_BATCH: 50,

  // Error messages
  ERRORS: {
    DEPOSIT_NOT_FOUND: 'Deposit not found',
    INVALID_AMOUNT: 'Invalid amount',
    PROCESSING_FAILED: 'Event processing failed',
    DB_OPERATION_FAILED: 'Database operation failed',
  },
} as const;

export const EVENT_TYPES = {
  STAKE_DEPOSITED: 'StakeDeposited',
  STAKE_WITHDRAWN: 'StakeWithdrawn',
  DELEGATEE_ALTERED: 'DelegateeAltered',
  STAKED: 'Staked',
  UNSTAKED: 'Unstaked',
  DEPOSIT_INITIALIZED: 'DepositInitialized',
  DEPOSIT_UPDATED: 'DepositUpdated',
  CLAIMER_ALTERED: 'ClaimerAltered',
  REWARD_CLAIMED: 'RewardClaimed',
  DEPOSIT_SUBSIDIZED: 'DepositSubsidized',
  EARNING_POWER_BUMPED: 'EarningPowerBumped',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
