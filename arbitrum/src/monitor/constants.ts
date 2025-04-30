import { ethers } from 'ethers';
import { MonitorConfig } from './types';
import { IDatabase } from '@/database';
import { CONFIG } from '@/configuration/constants';

/**
 * Processing component type
 */
export const PROCESSING_COMPONENT = {
  TYPE: 'staker-monitor',
  INITIAL_BLOCK_HASH: '0x0000000000000000000000000000000000000000000000000000000000000000',
} as const;

/**
 * Event names for monitor events
 */
export const MONITOR_EVENTS = {
  DEPOSIT_CREATED: 'deposit-created',
  DEPOSIT_UPDATED: 'deposit-updated',
  DEPOSIT_WITHDRAWN: 'deposit-withdrawn',
  DELEGATEE_CHANGED: 'delegatee-changed',
} as const;

/**
 * Event types for blockchain events
 */
export const EVENT_TYPES = {
  STAKE_DEPOSITED: 'StakeDeposited',
  STAKE_WITHDRAWN: 'StakeWithdrawn',
  DELEGATEE_ALTERED: 'DelegateeAltered',
} as const;

/**
 * Creates a monitor configuration object by combining provider, database, and config values
 */
export const createMonitorConfig = (
  provider: ethers.Provider,
  database: IDatabase,
): MonitorConfig => ({
  provider,
  database,
  networkName: 'arbitrum',
  arbTokenAddress: CONFIG.monitor.arbTestTokenAddress,
  ...CONFIG.monitor,
});
