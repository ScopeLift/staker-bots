import { config } from 'dotenv';
import { ethers } from 'ethers';

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
    rpcUrl: process.env.RPC_URL!,
    chainId: parseInt(process.env.CHAIN_ID || '42161'),
    stakerAddress: process.env.STAKER_CONTRACT_ADDRESS!,
    arbTestTokenAddress: process.env.ARB_TEST_TOKEN_ADDRESS || '',
    arbRealTokenAddress: process.env.ARB_TOKEN_ADDRESS || '',
    rewardCalculatorAddress: process.env.REWARD_CALCULATOR_ADDRESS || '',
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
} as const;

// Helper to create provider
export const createProvider = () => {
  return new ethers.JsonRpcProvider(
    CONFIG.monitor.rpcUrl,
    CONFIG.monitor.chainId,
  );
};
