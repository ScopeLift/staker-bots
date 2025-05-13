import { config } from 'dotenv';
import { ethers } from 'ethers';
import { IDatabase } from '@/database';
import { ConfigurationError } from './errors';

// Load environment variables
config();

// Required environment variables
const REQUIRED_ENV_VARS = [
  'RPC_URL',
  'STAKER_CONTRACT_ADDRESS',
  'CHAIN_ID',
  'LST_ADDRESS',
  'TENDERLY_ACCESS_KEY',
  'TENDERLY_ACCOUNT',
  'TENDERLY_PROJECT',
] as const;

// Validate required environment variables
for (const envVar of REQUIRED_ENV_VARS) {
  if (!process.env[envVar]) {
    throw new ConfigurationError(`Missing required environment variable: ${envVar}`);
  }
}

// Configuration object
export const CONFIG = {
  supabase: {
    url: process.env.SUPABASE_URL || '',
    key: process.env.SUPABASE_KEY || '',
  },
  monitor: {
    defaultDelegatee: process.env.DEFAULT_DELEGATEE || '',
    networkName: process.env.NETWORK_NAME || 'arbitrum',
    rpcUrl: process.env.RPC_URL!,
    chainId: parseInt(process.env.CHAIN_ID || '42161'),
    stakerAddress: process.env.STAKER_CONTRACT_ADDRESS!,
    arbTokenAddress: process.env.ARB_TOKEN_ADDRESS || '',
    arbTestTokenAddress: process.env.ARB_TEST_TOKEN_ADDRESS || '',
    arbRealTokenAddress: process.env.ARB_TOKEN_ADDRESS || '',
    rewardCalculatorAddress: process.env.REWARD_CALCULATOR_ADDRESS || '',
    rewardNotifierAddress: process.env.REWARD_NOTIFIER_ADDRESS || '',
    startBlock: parseInt(process.env.START_BLOCK || '0'),
    logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
    database: {} as IDatabase,
  },
  tenderly: {
    accessKey: process.env.TENDERLY_ACCESS_KEY!,
    accountName: process.env.TENDERLY_ACCOUNT!,
    projectName: process.env.TENDERLY_PROJECT!,
  },
  relayer: {
    apiKey: process.env.RELAYER_API_KEY || '',
    apiSecret: process.env.RELAYER_API_SECRET || '',
    address: process.env.RELAYER_ADDRESS || '',
  },
  executor: {
    chainId: parseInt(process.env.CHAIN_ID || '42161'),
    gasBoostPercentage: parseInt(process.env.GAS_BOOST_PERCENTAGE || '20'),
    maxPendingTransactions: parseInt(process.env.MAX_PENDING_TRANSACTIONS || '10'),
    maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
    retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || '5000'),
    confirmations: parseInt(process.env.CONFIRMATIONS || '3'),
  },
} as const; 