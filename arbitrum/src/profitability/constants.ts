import { stakerAbi } from '@/configuration/abis';

// Gas and Transaction Constants
export const GAS_CONSTANTS = {
  FALLBACK_GAS_ESTIMATE: BigInt(150000),
  DEFAULT_GAS_BUFFER: 20, // 20% buffer
  GAS_PRICE_UPDATE_INTERVAL: 60_000, // 1 minute in ms
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000, // 1 second in ms
} as const;

// Queue Processing Constants
export const QUEUE_CONSTANTS = {
  PROCESSOR_INTERVAL: 60_000, // 1 minute in ms
  MAX_BATCH_SIZE: 10, // Default max batch size
  MIN_BATCH_SIZE: 1,
} as const;

// Contract Constants
export const CONTRACT_CONSTANTS = {
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',
} as const;

// Error Messages
export const ERROR_MESSAGES = {
  DEPOSIT_NOT_FOUND: (id: string) => `Deposit ${id} not found`,
  GAS_ESTIMATION_FAILED: 'Gas estimation failed, using fallback estimate',
  QUEUE_PROCESSING_ERROR: 'Error processing queue',
  CONTRACT_INTERACTION_FAILED: 'Failed to interact with staker contract',
} as const;

// Event Names
export const EVENTS = {
  ENGINE_STARTED: 'engine_started',
  ENGINE_STOPPED: 'engine_stopped',
  QUEUE_PROCESSED: 'queue_processed',
  BATCH_NOT_PROFITABLE: 'batch_not_profitable',
  ITEMS_REQUEUED: 'items_requeued',
} as const;

/**
 * Profitability-specific ABI fragments that extend the base staker ABI
 */
export const STAKER_ABI = [
  ...stakerAbi,
  'function bumpEarningPower(uint256 depositId, address tipReceiver, uint256 tip) returns (uint256)',
  'function unclaimedReward(uint256 depositId) view returns (uint256)',
  'function maxBumpTip() view returns (uint256)',
];
