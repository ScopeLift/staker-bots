import {
  Deposit,
  ProcessingCheckpoint,
  ProcessingQueueItem,
  TransactionQueueItem,
  ProcessingQueueStatus,
  TransactionQueueStatus,
  GovLstDeposit,
  GovLstClaimHistory,
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
  getDepositsByOwner(ownerAddress: string): Promise<Deposit[]>;
  getDepositsByDepositor(depositorAddress: string): Promise<Deposit[]>;
  getAllDeposits(): Promise<Deposit[]>;
  // Checkpoints
  updateCheckpoint(checkpoint: ProcessingCheckpoint): Promise<void>;
  getCheckpoint(componentType: string): Promise<ProcessingCheckpoint | null>;
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

  // GovLst Deposits
  createGovLstDeposit(deposit: GovLstDeposit): Promise<void>;
  updateGovLstDeposit(
    depositId: string,
    update: Partial<Omit<GovLstDeposit, 'deposit_id'>>,
  ): Promise<void>;
  getGovLstDeposit(depositId: string): Promise<GovLstDeposit | null>;
  getGovLstDepositsByAddress(govLstAddress: string): Promise<GovLstDeposit[]>;
  getAllGovLstDeposits(): Promise<GovLstDeposit[]>;

  // GovLst Claim History
  createGovLstClaimHistory(
    claim: GovLstClaimHistory,
  ): Promise<GovLstClaimHistory>;
  getGovLstClaimHistory(id: string): Promise<GovLstClaimHistory | null>;
  getGovLstClaimHistoryByAddress(
    govLstAddress: string,
  ): Promise<GovLstClaimHistory[]>;
  updateGovLstClaimHistory(
    id: string,
    update: Partial<
      Omit<GovLstClaimHistory, 'id' | 'created_at' | 'updated_at'>
    >,
  ): Promise<void>;
}
