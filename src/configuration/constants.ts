import { ethers } from 'ethers';
import {
  ExecutorConfig,
  RelayerExecutorConfig,
} from '@/executor/interfaces/types';
import { MonitorConfig } from '@/monitor/types';
import { IDatabase } from '@/database';
import { CONFIG } from '@/configuration';

// Network and Chain Constants
export const NETWORK_CONSTANTS = {
  MAINNET_CHAIN_ID: 1,
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

// GovLst Constants
export const GOVLST_CONSTANTS = {
  BIPS: 10000,
  MAX_FEE_BIPS: 1000, // 10%
  MAX_OVERRIDE_TIP_CAP: ethers.parseEther('1000'),
  MIN_QUALIFYING_EARNING_POWER_BIPS_CAP: 10000,
  SHARE_SCALE_FACTOR: ethers.parseEther('1'),
} as const;

// Export all constants in a single object
export const CONSTANTS = {
  NETWORK: NETWORK_CONSTANTS,
  TIME: TIME_CONSTANTS,
  GAS: GAS_CONSTANTS,
  PROFITABILITY: PROFITABILITY_CONSTANTS,
  DATABASE: DATABASE_CONSTANTS,
  CIRCUIT_BREAKER: CIRCUIT_BREAKER_CONSTANTS,
  GOVLST: GOVLST_CONSTANTS,
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

// Executor Constants
export const EXECUTOR = {
  EVENTS: {
    TRANSACTION_QUEUED: 'Transaction queued for execution',
    TRANSACTION_STARTED: 'Started executing transaction',
    TRANSACTION_CONFIRMED: 'Transaction confirmed',
    TRANSACTION_FAILED: 'Transaction failed',
    QUEUE_PROCESSED: 'Processed transaction queue',
    TIPS_TRANSFERRED: 'Transferred accumulated tips',
    ERROR: 'Executor error occurred',
  },

  GAS: {
    GAS_PRICE_UPDATE_INTERVAL: 60_000, // 1 minute
    GAS_PRICE_BUFFER_PERCENT: 25, // 25%
    BASE_GAS_PER_DEPOSIT: 30_000n, // Base cost per deposit
    ADDITIONAL_GAS_PER_DEPOSIT: 10_000n, // Additional overhead per extra deposit
    MIN_GAS_LIMIT: 300_000n, // Minimum gas limit for reward claims
    MAX_GAS_LIMIT: 5_000_000n, // Maximum gas limit for reward claims
    GAS_LIMIT_BUFFER: 1.25, // 25% buffer on gas estimates
    REENTRANCY_THRESHOLD: 20, // Number of deposits where we start adding reentrancy protection buffer
    REENTRANCY_BUFFER: 1.25, // 25% additional buffer for reentrancy protection
  },

  QUEUE: {
    QUEUE_PROCESSOR_INTERVAL: 15000, // 15 seconds (increased from 3 seconds for CU optimization)
    MAX_BATCH_SIZE: 100, // Maximum number of deposits per batch
    MIN_BATCH_SIZE: 1, // Minimum number of deposits per batch
    MAX_RETRIES: 3, // Maximum number of retries per transaction
    RETRY_DELAY: 5000, // 5 seconds between retries
  },

  CONTRACT: {
    ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',
    MIN_SHARES_THRESHOLD: 1000n, // Minimum shares required for claiming
  },

  DEFAULT_CONFIG: {
    wallet: {
      privateKey: '',
      minBalance: ethers.parseEther('0.1'), // 0.1 ETH
      maxPendingTransactions: 5,
    },
    maxQueueSize: 100,
    minConfirmations: 2,
    maxRetries: 3,
    retryDelayMs: 5000,
    transferOutThreshold: ethers.parseEther('0.5'), // 0.5 ETH
    gasBoostPercentage: 25,
    concurrentTransactions: 3,
    defaultTipReceiver: '',
    minProfitMargin: 10,
    staleTransactionThresholdMinutes: 5, // Clean up stale transactions after 5 minutes
  } as ExecutorConfig,

  DEFAULT_RELAYER_CONFIG: {
    apiKey: '',
    apiSecret: '',
    address: '',
    minBalance: ethers.parseEther('0.1'), // 0.1 ETH
    maxPendingTransactions: 5,
    gasPolicy: {
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
    },
    maxQueueSize: 100,
    minConfirmations: 2,
    maxRetries: 3,
    retryDelayMs: 5000,
    transferOutThreshold: ethers.parseEther('0.5'), // 0.5 ETH
    gasBoostPercentage: 25,
    concurrentTransactions: 3,
    defaultTipReceiver: '',
    minProfitMargin: 10,
    staleTransactionThresholdMinutes: 5, // Clean up stale transactions after 5 minutes
    isPrivate: false,
  } as RelayerExecutorConfig,
} as const;

// Monitor Config Helper
export const createMonitorConfig = (
  provider: ethers.Provider,
  database: IDatabase,
): MonitorConfig => ({
  provider,
  database,
  tokenAddress: CONFIG.monitor.obolTokenAddress,
  ...CONFIG.monitor,
});
