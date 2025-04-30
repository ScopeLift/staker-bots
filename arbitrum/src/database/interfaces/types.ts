export interface Deposit {
  deposit_id: string;
  owner_address: string;
  amount: string;
  delegatee_address: string | null;
  created_at?: string;
  updated_at?: string;
}

export type ScoreEvent = {
  delegatee: string;
  score: string; // Using string for NUMERIC DB type
  block_number: number;
  created_at?: string;
  updated_at?: string;
};

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
