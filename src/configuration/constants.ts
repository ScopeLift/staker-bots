import { ethers } from 'ethers';

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
