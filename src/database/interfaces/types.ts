export interface Deposit {
  id?: string;
  deposit_id: string;
  owner_address: string;
  depositor_address?: string;
  amount: string;
  delegatee_address: string;
  earning_power?: string;
  created_at: string;
  updated_at: string;
}

export type ProcessingCheckpoint = {
  component_type: string;
  last_block_number: number;
  block_hash: string;
  last_update: string;
};

export enum ProcessingQueueStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export type ProcessingQueueItem = {
  id: string;
  deposit_id: string;
  status: ProcessingQueueStatus;
  delegatee: string;
  created_at: string;
  updated_at: string;
  error?: string;
  attempts: number;
  last_profitability_check?: string; // JSON stringified profitability result
};

export enum TransactionQueueStatus {
  PENDING = 'pending',
  SUBMITTED = 'submitted',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
}

export type TransactionQueueItem = {
  id: string;
  deposit_id: string;
  status: TransactionQueueStatus;
  hash?: string;
  created_at: string;
  updated_at: string;
  error?: string;
  tx_data: string; // JSON stringified transaction data
  gas_price?: string;
  tip_amount?: string;
  tip_receiver?: string;
  attempts: number;
};

export enum TransactionDetailsStatus {
  PENDING = 'pending',
  SUBMITTED = 'submitted',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
}

export type TransactionDetails = {
  id?: string;
  transaction_id: string; // ID from the executor
  transaction_hash?: string; // Transaction hash once submitted
  tx_queue_item_id?: string; // Reference to queue item ID
  status: TransactionDetailsStatus;
  deposit_ids: string[]; // Array of deposit IDs included in this transaction
  recipient_address: string; // Recipient address
  min_expected_reward: string; // Minimum expected reward
  payout_amount: string; // Payout amount from contract
  profit_margin_amount: string; // Amount added for profit margin
  gas_cost_estimate: string; // Gas cost estimate in reward tokens
  gas_cost_eth?: string; // Gas cost in ETH
  gas_limit: string; // Gas limit used
  gas_used?: string; // Actual gas used
  gas_price?: string; // Gas price paid
  max_fee_per_gas?: string; // Max fee per gas
  max_priority_fee_per_gas?: string; // Max priority fee per gas
  reward_token_price_usd?: string; // Reward token price in USD
  eth_price_usd?: string; // ETH price in USD
  expected_profit: string; // Expected profit in reward tokens
  actual_profit?: string; // Actual profit in reward tokens
  start_time?: string; // Transaction start time
  end_time?: string; // Transaction completion time
  duration_ms?: number; // Duration in milliseconds
  error?: string; // Error message if failed
  contract_address: string; // Contract address
  network_id: string; // Network ID
  created_at?: string;
  updated_at?: string;
};

export type GovLstClaimHistory = {
  id?: string;
  govlst_address: string;
  deposit_ids: string[];
  claimed_reward: string;
  payout_amount: string;
  profit: string;
  transaction_hash?: string;
  gas_used?: string;
  gas_price?: string;
  created_at?: string;
  updated_at?: string;
};

export type ErrorLog = {
  id?: string;
  service_name: string;
  error_message: string;
  stack_trace?: string;
  severity: 'info' | 'warn' | 'error' | 'fatal';
  meta?: Record<string, unknown>;
  context?: Record<string, unknown>;
  created_at?: string;
};
