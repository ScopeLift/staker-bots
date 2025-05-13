import { config } from "dotenv";
import { ethers } from "ethers";
import { MonitorConfig } from '@/monitor/types';
import { IDatabase } from '@/database';

// Load environment variables
config();

/**
 * Validates required environment variables
 * @throws Error if any required variables are missing
 */
function validateEnvVars() {
  const requiredEnvVars = [
    "RPC_URL",
    "STAKER_CONTRACT_ADDRESS",
    "CHAIN_ID",
  ] as const;

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }
}

// Validate environment variables
validateEnvVars();

/**
 * Central configuration object for the application
 */
export const CONFIG = {
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
  },
  monitor: {
    rpcUrl: process.env.RPC_URL!,
    chainId: parseInt(process.env.CHAIN_ID || "42161"),
    networkName: process.env.NETWORK_NAME || "arbitrum",
    stakerAddress: process.env.STAKER_CONTRACT_ADDRESS!,
    arbTokenAddress: process.env.ARB_TOKEN_ADDRESS || "",
    arbTestTokenAddress: process.env.ARB_TEST_TOKEN_ADDRESS || "",
    arbRealTokenAddress: process.env.ARB_TOKEN_ADDRESS || "",
    rewardCalculatorAddress: process.env.REWARD_CALCULATOR_ADDRESS || "",
    rewardNotifierAddress: process.env.REWARD_NOTIFIER_ADDRESS || "",
    startBlock: parseInt(process.env.START_BLOCK || "0"),
    logLevel: (process.env.LOG_LEVEL || "info") as
      | "debug"
      | "info"
      | "warn"
      | "error",
    databaseType: (process.env.DB || "json") as "json" | "supabase",
    pollInterval: parseInt(process.env.POLL_INTERVAL || "15"),
    maxBlockRange: parseInt(process.env.MAX_BLOCK_RANGE || "2000"),
    maxRetries: parseInt(process.env.MAX_RETRIES || "5"),
    reorgDepth: parseInt(process.env.REORG_DEPTH || "64"),
    confirmations: parseInt(process.env.CONFIRMATIONS || "20"),
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || "60"),
  },
  tenderly: {
    projectId: process.env.TENDERLY_PROJECT_ID || "",
    projectName: process.env.TENDERLY_PROJECT_NAME || "",
    accessToken: process.env.TENDERLY_ACCESS_TOKEN || "",
    network: process.env.TENDERLY_NETWORK || "arbitrum",
    accessKey: process.env.TENDERLY_ACCESS_KEY || "",
    accountName: process.env.TENDERLY_ACCOUNT_NAME || "",
    forkId: process.env.TENDERLY_FORK_ID || "",
    forkName: process.env.TENDERLY_FORK_NAME || "",
    forkDescription: process.env.TENDERLY_FORK_DESCRIPTION || "",
  },
  executor: {
    privateKey: process.env.PRIVATE_KEY || "",
    tipReceiver:
      process.env.TIP_RECEIVER || "0x0000000000000000000000000000000000000000",
    minBalance: ethers.parseEther("0.0001"),
    maxPendingTransactions: 5,
    maxQueueSize: 100,
    retryDelayMs: 5000,
    transferOutThreshold: ethers.parseEther("0.5"),
    gasBoostPercentage: 30,
    concurrentTransactions: 3,
  },
  priceFeed: {
    coinmarketcap: {
      apiKey: process.env.COINMARKETCAP_API_KEY || "",
      baseUrl: "https://pro-api.coinmarketcap.com/v2",
      timeout: 5000,
      retries: 3,
    },
  },
  profitability: {
    minProfitMargin: ethers.parseEther("0"), // 0 tokens minimum profit
    gasPriceBuffer: 50, // 50% buffer for gas price volatility
    maxBatchSize: 10,
    defaultTipReceiver: process.env.TIP_RECEIVER_ADDRESS || "",
    rewardTokenAddress: process.env.REWARD_TOKEN_ADDRESS || "",
    priceFeed: {
      tokenAddress: process.env.PRICE_FEED_TOKEN_ADDRESS || "",
      cacheDuration: 10 * 60 * 1000, // 10 minutes
    },
  },
} as const;

/**
 * Default delegatee address when none is provided
 */
export const DEFAULT_DELEGATEE_ADDRESS =
  "0x0000000000000000000000000000000000000000";

/**
 * Constants for processing components
 */
export const PROCESSING_COMPONENT = {
  MONITOR: "staker-monitor",
  PROFITABILITY: "profitability-engine",
  EXECUTOR: "transaction-executor",
  INITIAL_BLOCK_HASH:
    "0x0000000000000000000000000000000000000000000000000000000000000000",
} as const;

// Network and Chain Constants
export const NETWORK_CONSTANTS = {
  ARBITRUM_CHAIN_ID: 42161,
  DEFAULT_CONFIRMATIONS: 12,
  MAX_BLOCK_RANGE: 5000,
  MAX_REORG_DEPTH: 100,
} as const;

// Time Constants (in seconds)
export const TIME_CONSTANTS = {
  MINUTE: 60,
  HOUR: 3600,
  DAY: 86400,
  WEEK: 604800,
} as const;

// Gas and Transaction Constants
export const GAS_CONSTANTS = {
  GAS_PRICE_BUFFER: 1.25, // 25% buffer
  GAS_LIMIT_BUFFER: 1.25, // 25% buffer
  MIN_EXECUTOR_BALANCE: ethers.parseEther('0.001'),
  MAX_PENDING_TRANSACTIONS: 10,
} as const;

// Profitability Constants
export const PROFITABILITY_CONSTANTS = {
  MIN_PROFIT_MARGIN: 0.15, // 15%
  MAX_BATCH_SIZE: 50,
  MAX_RETRIES: 3,
} as const;

// Database Constants
export const DATABASE_CONSTANTS = {
  MAX_QUEUE_SIZE: 1000,
  BATCH_TIMEOUT: TIME_CONSTANTS.HOUR,
  PRUNE_INTERVAL: TIME_CONSTANTS.DAY,
  MAX_ARCHIVE_AGE: TIME_CONSTANTS.WEEK,
} as const;

// Circuit Breaker Constants
export const CIRCUIT_BREAKER_CONSTANTS = {
  MAX_FAILED_TRANSACTIONS: 3,
  COOLDOWN_PERIOD: 1800, // 30 minutes
  MIN_SUCCESS_RATE: 0.8, // 80%
} as const;

// Simulation Constants
export const SIMULATION_CONSTANTS = {
  DEFAULT_GAS_LIMIT: 5000000,
  GAS_BUFFER_PERCENT: 30, // 30% buffer on simulated gas
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000,
  ERROR_CODES: {
    INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
    EXECUTION_REVERTED: 'EXECUTION_REVERTED',
    GAS_LIMIT_EXCEEDED: 'GAS_LIMIT_EXCEEDED',
    SIMULATION_FAILED: 'SIMULATION_FAILED',
  },
} as const;

// Export all constants in a single object
export const CONSTANTS = {
  NETWORK: NETWORK_CONSTANTS,
  TIME: TIME_CONSTANTS,
  GAS: GAS_CONSTANTS,
  PROFITABILITY: PROFITABILITY_CONSTANTS,
  DATABASE: DATABASE_CONSTANTS,
  CIRCUIT_BREAKER: CIRCUIT_BREAKER_CONSTANTS,
  SIMULATION: SIMULATION_CONSTANTS,
} as const;

// Monitor Constants
export const MONITOR = {
  DEFAULT_DELEGATEE_ADDRESS: '0x0000000000000000000000000000000000000B01',

  EVENTS: {
    DELEGATE_EVENT: 'delegateEvent',
    ERROR: 'error',
    STAKE_WITH_ATTRIBUTION: 'stakedWithAttribution',
    UNSTAKED: 'unstaked',
    DEPOSIT_INITIALIZED: 'depositInitialized',
    DEPOSIT_UPDATED: 'depositUpdated',
  },

  PROCESSING: {
    TYPE: 'staker-monitor',
    INITIAL_BLOCK_HASH:
      '0x0000000000000000000000000000000000000000000000000000000000000000',
  },

  GOVLST_ABI: [
    {
      inputs: [
        { internalType: 'address', name: '_delegatee', type: 'address' },
      ],
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
      outputs: [
        { internalType: 'address', name: '_delegatee', type: 'address' },
      ],
      stateMutability: 'view',
      type: 'function',
    },
  ],

  CONSTANTS: {
    DEFAULT_DELEGATEE: '0x0000000000000000000000000000000000000B01',
    DB_BATCH_SIZE: 100,
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000,
    MAX_EVENTS_PER_BATCH: 50,
    ERRORS: {
      DEPOSIT_NOT_FOUND: 'Deposit not found',
      INVALID_AMOUNT: 'Invalid amount',
      PROCESSING_FAILED: 'Event processing failed',
      DB_OPERATION_FAILED: 'Database operation failed',
    },
  },

  EVENT_TYPES: {
    STAKE_DEPOSITED: 'StakeDeposited',
    STAKE_WITHDRAWN: 'StakeWithdrawn',
    DELEGATEE_ALTERED: 'DelegateeAltered',
    STAKED: 'Staked',
    UNSTAKED: 'Unstaked',
    DEPOSIT_INITIALIZED: 'DepositInitialized',
    DEPOSIT_UPDATED: 'DepositUpdated',
  },
} as const;

// Monitor Config Helper
export const createMonitorConfig = (
  provider: ethers.Provider,
  database: IDatabase,
): MonitorConfig => ({
  provider,
  database,
  ...CONFIG.monitor,
});
