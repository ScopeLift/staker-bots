import { ethers } from 'ethers';
import { MonitorConfig } from './types';
import { IDatabase } from '@/database';
import { CONFIG } from '@/config';

// ABI fragments
export const STAKER_ABI = [
  'event StakeDeposited(address owner, uint256 indexed depositId, uint256 amount, uint256 depositBalance, uint256 earningPower)',
  'event StakeWithdrawn(address owner, uint256 indexed depositId, uint256 amount, uint256 depositBalance, uint256 earningPower)',
  'event DelegateeAltered(uint256 indexed depositId, address oldDelegatee, address newDelegatee, uint256 earningPower)',
];

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
