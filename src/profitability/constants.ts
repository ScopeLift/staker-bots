// Gas and Transaction Constants
export const GAS_CONSTANTS = {
  FALLBACK_GAS_ESTIMATE: BigInt(150000),
  DEFAULT_GAS_BUFFER: 10, // 10% buffer
  GAS_PRICE_UPDATE_INTERVAL: 60_000, // 1 minute in ms
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000, // 1 second in ms
} as const;

// Queue Processing Constants
export const QUEUE_CONSTANTS = {
  PROCESSOR_INTERVAL: 60_000, // 1 minute in ms
  MAX_BATCH_SIZE: 50,
  MIN_BATCH_SIZE: 1,
} as const;

// Contract Constants
export const CONTRACT_CONSTANTS = {
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',
  MIN_SHARES_THRESHOLD: BigInt(0),
} as const;

// Error Messages
export const ERROR_MESSAGES = {
  DEPOSIT_NOT_FOUND: (id: string) => `Deposit ${id} not found`,
  GAS_ESTIMATION_FAILED: 'Gas estimation failed, using fallback estimate',
  QUEUE_PROCESSING_ERROR: 'Error processing queue',
} as const;

// Event Names
export const EVENTS = {
  ENGINE_STARTED: 'engine_started',
  ENGINE_STOPPED: 'engine_stopped',
  QUEUE_PROCESSED: 'queue_processed',
  GROUP_NOT_PROFITABLE: 'group_not_profitable',
  ITEMS_REQUEUED: 'items_requeued',
} as const;
