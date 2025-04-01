import { config } from 'dotenv';
import { ethers } from 'ethers';

export const PRODUCTION_CONFIG = {
  profitability: {
    checkInterval: 300, // 5 minutes
    maxBatchSize: 50,
    minProfitMargin: 0.15, // 15%
    gasPriceBuffer: 1.2, // 20% buffer for gas price fluctuations
    retryDelay: 60, // 1 minute
    maxRetries: 3
  },
  monitor: {
    confirmations: 12,
    maxBlockRange: 5000,
    pollInterval: 13, // seconds
    healthCheckInterval: 60, // 1 minute
    maxReorgDepth: 100
  },
  executor: {
    queuePollInterval: 60, // seconds
    minExecutorBalance: ethers.parseEther('0.1'),
    maxPendingTransactions: 10,
    gasLimitBuffer: 1.3, // 30% buffer for gas limit
    maxBatchSize: 50,
    retryDelay: 60, // 1 minute
    maxRetries: 3
  },
  database: {
    batchTimeout: 3600, // 1 hour
    maxQueueSize: 1000,
    pruneInterval: 86400, // 24 hours
    maxArchiveAge: 604800 // 7 days
  },
  circuit_breaker: {
    maxFailedTransactions: 3,
    cooldownPeriod: 1800, // 30 minutes
    minSuccessRate: 0.8 // 80% success rate required
  }
} as const

export type ProductionConfig = typeof PRODUCTION_CONFIG

// Load environment variables
config();

// Validate required environment variables
const requiredEnvVars = [
  'RPC_URL',
  'STAKER_CONTRACT_ADDRESS',
  'CHAIN_ID',
] as const;

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

export const CONFIG = {
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
  },
  monitor: {
    defaultDelegatee: process.env.DEFAULT_DELEGATEE || '',
    networkName: process.env.NETWORK_NAME || 'mainnet',
    rpcUrl: process.env.RPC_URL!,
    chainId: parseInt(process.env.CHAIN_ID || '1'),
    stakerAddress: process.env.STAKER_CONTRACT_ADDRESS!,
    obolTokenAddress: process.env.OBOL_TOKEN_ADDRESS || '',
    lstAddress: process.env.LST_ADDRESS || '',
    rewardNotifierAddress: process.env.REWARD_NOTIFIER_ADDRESS || '',
    startBlock: parseInt(process.env.START_BLOCK || '0'),
    logLevel: (process.env.LOG_LEVEL || 'info') as
      | 'debug'
      | 'info'
      | 'warn'
      | 'error',
    databaseType: (process.env.DB || 'json') as 'json' | 'supabase',
    pollInterval: parseInt(process.env.POLL_INTERVAL || '15'),
    maxBlockRange: parseInt(process.env.MAX_BLOCK_RANGE || '2000'),
    maxRetries: parseInt(process.env.MAX_RETRIES || '5'),
    reorgDepth: parseInt(process.env.REORG_DEPTH || '64'),
    confirmations: parseInt(process.env.CONFIRMATIONS || '20'),
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '60'),
  },
  executor: {
    privateKey: process.env.PRIVATE_KEY || '',
    tipReceiver:
      process.env.TIP_RECEIVER || '0x0000000000000000000000000000000000000000',
  },
  defender: {
    apiKey: process.env.DEFENDER_API_KEY || '',
    secretKey: process.env.DEFENDER_SECRET_KEY || '',
    address: process.env.PUBLIC_ADDRESS_DEFENDER || '',
    relayer: {
      minBalance: process.env.DEFENDER_MIN_BALANCE
        ? BigInt(process.env.DEFENDER_MIN_BALANCE)
        : ethers.parseEther('0.01'),
      maxPendingTransactions: parseInt(
        process.env.DEFENDER_MAX_PENDING_TXS || '5',
      ),
      gasPolicy: {
        maxFeePerGas: process.env.DEFENDER_MAX_FEE
          ? BigInt(process.env.DEFENDER_MAX_FEE)
          : undefined,
        maxPriorityFeePerGas: process.env.DEFENDER_PRIORITY_FEE
          ? BigInt(process.env.DEFENDER_PRIORITY_FEE)
          : undefined,
      },
    },
  },
  priceFeed: {
    coinmarketcap: {
      apiKey: process.env.COINMARKETCAP_API_KEY || '',
      baseUrl: 'https://pro-api.coinmarketcap.com/v2',
      timeout: 5000,
      retries: 3,
    },
  },
  profitability: {
    minProfitMargin: ethers.parseEther('0'), // 0 tokens minimum profit
    gasPriceBuffer: 50, // 50% buffer for gas price volatility (increased from 20%)
    maxBatchSize: 10,
    defaultTipReceiver: process.env.TIP_RECEIVER_ADDRESS || '',
    rewardTokenAddress: process.env.REWARD_TOKEN_ADDRESS || '',
    priceFeed: {
      tokenAddress: process.env.PRICE_FEED_TOKEN_ADDRESS || '',
      cacheDuration: 10 * 60 * 1000, // 10 minutes
    },
  },
  govlst: {
    addresses: process.env.GOVLST_ADDRESSES?.split(',') || [],
    payoutAmount: BigInt(process.env.GOVLST_PAYOUT_AMOUNT || 0),
    minProfitMargin: BigInt(process.env.GOVLST_MIN_PROFIT_MARGIN || 1000), // 10% minimum profit margin
    maxBatchSize: parseInt(process.env.GOVLST_MAX_BATCH_SIZE || '10', 10),
    claimInterval: parseInt(process.env.GOVLST_CLAIM_INTERVAL || '3600', 10), // 1 hour default
    gasPriceBuffer: parseFloat(process.env.GOVLST_GAS_PRICE_BUFFER || '1.2'), // 20% buffer
    minEarningPower: BigInt(process.env.GOVLST_MIN_EARNING_POWER || 10000), // Minimum earning power threshold
  },
} as const;

// Helper to create provider
export const createProvider = () => {
  return new ethers.JsonRpcProvider(
    CONFIG.monitor.rpcUrl,
    CONFIG.monitor.chainId,
  );
};
