import { config } from 'dotenv';
import { ethers } from 'ethers';

// Load environment variables
config();

// Required environment variables
const REQUIRED_ENV_VARS = [
  'RPC_URL',
  'STAKER_CONTRACT_ADDRESS',
  'CHAIN_ID',
  'LST_ADDRESS',
] as const;

// Validate required environment variables
for (const envVar of REQUIRED_ENV_VARS) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
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
    minGasCost: process.env.MIN_GAS_COST || '20.0',
    maxGasCost: process.env.MAX_GAS_COST || '450.0',
    avgGasCost: process.env.AVG_GAS_COST || '200.0',
    approvalAmount:
      process.env.EXECUTOR_APPROVAL_AMOUNT || '1000000000000000000000000',
    executorType: process.env.EXECUTOR_TYPE || '',
    privateKey: process.env.PRIVATE_KEY || '',
    tipReceiver:
      process.env.TIP_RECEIVER || '0x0000000000000000000000000000000000000000',
    staleTransactionThresholdMinutes: parseInt(
      process.env.EXECUTOR_STALE_TX_THRESHOLD_MINUTES || '5',
      10,
    ),
    swap: {
      enabled: process.env.EXECUTOR_SWAP_TO_ETH === 'true',
      uniswapRouterAddress: process.env.UNISWAP_ROUTER_ADDRESS || '',
      slippageTolerance: parseFloat(
        process.env.SWAP_SLIPPAGE_TOLERANCE || '0.5',
      ),
      deadlineMinutes: parseInt(process.env.SWAP_DEADLINE_MINUTES || '10'),
      minAmountIn: process.env.SWAP_MIN_AMOUNT_IN
        ? BigInt(process.env.SWAP_MIN_AMOUNT_IN)
        : ethers.parseUnits('1', 18), // Default 1 token
      maxAmountIn: process.env.SWAP_MAX_AMOUNT_IN
        ? BigInt(process.env.SWAP_MAX_AMOUNT_IN)
        : ethers.parseUnits('1000', 18), // Default 1000 tokens
      tokenDecimals: parseInt(process.env.SWAP_TOKEN_DECIMALS || '18'),
    },
  },
  defender: {
    mainKey: process.env.DEFENDER_MAIN_KEY || '',
    mainSecret: process.env.DEFENDER_MAIN_SECRET || '',
    apiKey: process.env.DEFENDER_API_KEY || '',
    secretKey: process.env.DEFENDER_SECRET_KEY || '',
    address: process.env.PUBLIC_ADDRESS_DEFENDER || '',
    relayer: {
      isPrivate: process.env.RELAYER_PRIVATE_TRANSACTIONS === 'true',
      minBalance: process.env.DEFENDER_MIN_BALANCE
        ? BigInt(process.env.DEFENDER_MIN_BALANCE)
        : ethers.parseEther('0.0000001'),
      maxPendingTransactions: parseInt(
        process.env.DEFENDER_MAX_PENDING_TXS || '5',
      ),
      gasPolicy: {
        // Default max fee is ~3 Gwei (base fee ~2.257 Gwei + 25% buffer)
        maxFeePerGas: process.env.DEFENDER_MAX_FEE
          ? BigInt(process.env.DEFENDER_MAX_FEE)
          : BigInt(3000000000),
        // Default priority fee is ~0.2 Gwei (tip ~0.158 Gwei + 25% buffer)
        maxPriorityFeePerGas: process.env.DEFENDER_PRIORITY_FEE
          ? BigInt(process.env.DEFENDER_PRIORITY_FEE)
          : BigInt(200000000),
      },
    },
  },
  priceFeed: {
    coinmarketcap: {
      rewardTokenAddress: process.env.REWARD_TOKEN_ADDRESS || '',
      apiKey: process.env.COINMARKETCAP_API_KEY || '',
      baseUrl: 'https://pro-api.coinmarketcap.com/v2',
      timeout: 5000,
      retries: 3,
    },
  },
  profitability: {
    includeGasCost: process.env.PROFITABILITY_INCLUDE_GAS_COST === 'true',
    rewardCheckInterval: parseInt(
      process.env.PROFITABILITY_REWARD_CHECK_INTERVAL || '60000',
    ), // 1 minute
    minProfitMargin: parseFloat(
      process.env.PROFITABILITY_MIN_PROFIT_MARGIN_PERCENT || '1',
    ), // 10% minimum profit margin by default
    gasPriceBuffer: 50, // 50% buffer for gas price volatility
    maxBatchSize: 10,
    defaultTipReceiver: process.env.TIP_RECEIVER_ADDRESS || '',
    rewardTokenAddress: process.env.REWARD_TOKEN_ADDRESS || '',
    priceFeed: {
      tokenAddress: process.env.PRICE_FEED_TOKEN_ADDRESS || '',
      cacheDuration: 10 * 60 * 1000, // 10 minutes
    },
  },
  govlst: {
    address: process.env.LST_ADDRESS || '',
    payoutAmount: BigInt(process.env.GOVLST_PAYOUT_AMOUNT || 0),
    minProfitMargin: parseFloat(
      process.env.PROFITABILITY_MIN_PROFIT_MARGIN_PERCENT || '10',
    ), // 10% minimum profit margin by default
    maxBatchSize: parseInt(process.env.GOVLST_MAX_BATCH_SIZE || '10', 10),
    claimInterval: parseInt(process.env.GOVLST_CLAIM_INTERVAL || '3600', 10), // 1 hour default
    gasPriceBuffer: parseFloat(process.env.GOVLST_GAS_PRICE_BUFFER || '1.25'), // 25% buffer
    minEarningPower: BigInt(process.env.GOVLST_MIN_EARNING_POWER || 10000), // Minimum earning power threshold
    rewardTokenDecimals: parseInt(
      process.env.GOVLST_REWARD_TOKEN_DECIMALS || '18',
      10,
    ), // Default to 18 decimals
  },
  tenderly: {
    useSimulation: process.env.TENDERLY_USE_SIMULATE === 'true',
    skipSimulationBelowPayout: process.env.TENDERLY_SKIP_SIMULATION_BELOW_PAYOUT !== 'false', // Default to true
    accessKey: process.env.TENDERLY_ACCESS_KEY || '',
    accountName: process.env.TENDERLY_ACCOUNT_NAME || '',
    projectName: process.env.TENDERLY_PROJECT_NAME || '',
    networkId: process.env.TENDERLY_NETWORK_ID || '1', // Default to mainnet (1)
  },
} as const;

// Helper to create provider
export function createProvider() {
  return new ethers.JsonRpcProvider(
    CONFIG.monitor.rpcUrl,
    CONFIG.monitor.chainId,
  );
}

// Re-export everything from constants and abis
export * from './constants';
export * from './abis';
export * from './errors';
