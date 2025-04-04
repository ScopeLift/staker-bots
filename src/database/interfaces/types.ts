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

export type GovLstDeposit = {
  deposit_id: string;
  govlst_address: string;
  last_reward_check?: string;
  last_unclaimed_reward?: string;
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
