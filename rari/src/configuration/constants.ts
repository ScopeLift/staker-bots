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
  GAS_PRICE_BUFFER: 1.2, // 20% buffer
  GAS_LIMIT_BUFFER: 1.3, // 30% buffer
  MIN_EXECUTOR_BALANCE: ethers.parseEther('0'),
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

// Rari Chain Configuration
export const RARI_CONSTANTS = {
  // Contracts
  STAKER_CONTRACT_ADDRESS: process.env.STAKER_CONTRACT_ADDRESS || '0x8B7610ef891d40745d70e6b9C8Ae92DfF7a01B7a',
  EARNING_POWER_CALCULATOR_ADDRESS: process.env.EARNING_POWER_CALCULATOR_ADDRESS || '0xD7213a45bE3fAd1B0715412BDAaAdf1EadD554d1',
  RARI_TOKEN_ADDRESS: process.env.RARI_TOKEN_ADDRESS || '0xBcBA0785b51ad5305E5c19471eeE9e87f6d6D976',
  REWARD_NOTIFIER_ADDRESS: process.env.REWARD_NOTIFIER_ADDRESS || '0xDA5b7BCcFF23eEdceB7C963CA1972F1EEe5fbe0B',
  AUTO_DELEGATE_ADDRESS: process.env.AUTO_DELEGATE_ADDRESS || '0x63B7806b32d7cff30a680D869E1FA372cd05B764',
  RSTRARI_ADDRESS: process.env.RSTRARI_ADDRESS || '0xFB2CAA6c18422a714CAF0e9C62457B696D74e07f',
  LST_ADDRESS: process.env.LST_ADDRESS || '0xbEFe5bEe763af472DE88ACbcA5fF326C14e6D2Da',
  
  // Bump Earning Power Bot Configuration
  MIN_TIP_AMOUNT: process.env.MIN_TIP_AMOUNT || '1000000000000000', // 0.001 ETH in wei
  MAX_TIP_AMOUNT: process.env.MAX_TIP_AMOUNT || '10000000000000000', // 0.01 ETH in wei
  TIP_INCREMENT: process.env.TIP_INCREMENT || '1000000000000000', // 0.001 ETH in wei
  BUMP_GAS_LIMIT: process.env.BUMP_GAS_LIMIT || '300000',
  REWARD_RATE_PER_BLOCK: process.env.REWARD_RATE_PER_BLOCK || '1000000000000000', // 0.001 ETH in wei
  EXPECTED_BLOCKS_BEFORE_NEXT_BUMP: process.env.EXPECTED_BLOCKS_BEFORE_NEXT_BUMP || '40320', // ~1 week at 15s blocks
  
  // Claim and Distribute Bot Configuration
  CLAIM_GAS_LIMIT: process.env.CLAIM_GAS_LIMIT || '500000',
  CLAIM_PROFIT_THRESHOLD: process.env.CLAIM_PROFIT_THRESHOLD || '1000000000000000', // 0.001 ETH in wei
}

// Export all constants in a single object
export const CONSTANTS = {
  NETWORK: NETWORK_CONSTANTS,
  TIME: TIME_CONSTANTS,
  GAS: GAS_CONSTANTS,
  PROFITABILITY: PROFITABILITY_CONSTANTS,
  DATABASE: DATABASE_CONSTANTS,
  CIRCUIT_BREAKER: CIRCUIT_BREAKER_CONSTANTS,
  GOVLST: GOVLST_CONSTANTS,
  RARI: RARI_CONSTANTS,
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
    GAS_PRICE_BUFFER_PERCENT: 30, // 30%
    MIN_GAS_LIMIT: 300_000n, // Minimum gas limit for reward claims
    MAX_GAS_LIMIT: 1_000_000n, // Maximum gas limit for reward claims
    GAS_LIMIT_BUFFER: 1.5, // 50% buffer on gas estimates
  },

  QUEUE: {
    QUEUE_PROCESSOR_INTERVAL: 60000, // 1 minute
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
      minBalance: ethers.parseEther('0'), // 0 ETH
      maxPendingTransactions: 5,
    },
    maxQueueSize: 100,
    minConfirmations: 2,
    maxRetries: 3,
    retryDelayMs: 5000,
    transferOutThreshold: ethers.parseEther('0.5'), // 0.5 ETH
    gasBoostPercentage: 30,
    concurrentTransactions: 3,
    defaultTipReceiver: '',
    minProfitMargin: 10,
    staleTransactionThresholdMinutes: 5, // Clean up stale transactions after 5 minutes
  } as ExecutorConfig,

  DEFAULT_RELAYER_CONFIG: {
    apiKey: '',
    apiSecret: '',
    address: '',
    minBalance: ethers.parseEther('0'), // 0 ETH
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
    gasBoostPercentage: 30,
    concurrentTransactions: 3,
    defaultTipReceiver: '',
    minProfitMargin: 10,
    staleTransactionThresholdMinutes: 5, // Clean up stale transactions after 5 minutes
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
