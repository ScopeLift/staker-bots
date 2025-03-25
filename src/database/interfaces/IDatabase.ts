import {
  Deposit,
  ProcessingCheckpoint,
  ScoreEvent,
  ProcessingQueueItem,
  TransactionQueueItem,
  ProcessingQueueStatus,
  TransactionQueueStatus,
} from './types';

export interface IDatabase {
  // Deposits
  createDeposit(deposit: Deposit): Promise<void>;
  updateDeposit(
    depositId: string,
    update: Partial<Omit<Deposit, 'deposit_id'>>,
  ): Promise<void>;
  getDeposit(depositId: string): Promise<Deposit | null>;
  getDepositsByDelegatee(delegateeAddress: string): Promise<Deposit[]>;
  getAllDeposits(): Promise<Deposit[]>;
  // Checkpoints
  updateCheckpoint(checkpoint: ProcessingCheckpoint): Promise<void>;
  getCheckpoint(componentType: string): Promise<ProcessingCheckpoint | null>;
  // Score Events
  createScoreEvent(event: ScoreEvent): Promise<void>;
  updateScoreEvent(
    delegatee: string,
    blockNumber: number,
    update: Partial<ScoreEvent>,
  ): Promise<void>;
  deleteScoreEvent(delegatee: string, blockNumber: number): Promise<void>;
  getScoreEvent(
    delegatee: string,
    blockNumber: number,
  ): Promise<ScoreEvent | null>;
  getLatestScoreEvent(delegatee: string): Promise<ScoreEvent | null>;
  getScoreEventsByBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<ScoreEvent[]>;
  deleteScoreEventsByBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<void>;
  // Processing Queue
  createProcessingQueueItem(
    item: Omit<
      ProcessingQueueItem,
      'id' | 'created_at' | 'updated_at' | 'attempts'
    >,
  ): Promise<ProcessingQueueItem>;
  updateProcessingQueueItem(
    id: string,
    update: Partial<
      Omit<ProcessingQueueItem, 'id' | 'created_at' | 'updated_at'>
    >,
  ): Promise<void>;
  getProcessingQueueItem(id: string): Promise<ProcessingQueueItem | null>;
  getProcessingQueueItemsByStatus(
    status: ProcessingQueueStatus,
  ): Promise<ProcessingQueueItem[]>;
  getProcessingQueueItemByDepositId(
    depositId: string,
  ): Promise<ProcessingQueueItem | null>;
  getProcessingQueueItemsByDelegatee(
    delegatee: string,
  ): Promise<ProcessingQueueItem[]>;
  deleteProcessingQueueItem(id: string): Promise<void>;
  // Transaction Queue
  createTransactionQueueItem(
    item: Omit<
      TransactionQueueItem,
      'id' | 'created_at' | 'updated_at' | 'attempts'
    >,
  ): Promise<TransactionQueueItem>;
  updateTransactionQueueItem(
    id: string,
    update: Partial<
      Omit<TransactionQueueItem, 'id' | 'created_at' | 'updated_at'>
    >,
  ): Promise<void>;
  getTransactionQueueItem(id: string): Promise<TransactionQueueItem | null>;
  getTransactionQueueItemsByStatus(
    status: TransactionQueueStatus,
  ): Promise<TransactionQueueItem[]>;
  getTransactionQueueItemByDepositId(
    depositId: string,
  ): Promise<TransactionQueueItem | null>;
  getTransactionQueueItemsByHash(hash: string): Promise<TransactionQueueItem[]>;
  deleteTransactionQueueItem(id: string): Promise<void>;
}
