import { IDatabase } from './interfaces/IDatabase';
import {
  Deposit,
  ProcessingCheckpoint,
  ProcessingQueueItem,
  TransactionQueueItem,
  ProcessingQueueStatus,
  TransactionQueueStatus,
  GovLstDeposit,
  GovLstClaimHistory,
} from './interfaces/types';
import * as supabaseDb from './supabase/deposits';
import * as supabaseCheckpoints from './supabase/checkpoints';
import * as supabaseProcessingQueue from './supabase/processing_queue';
import * as supabaseTransactionQueue from './supabase/transaction_queue';
import * as supabaseGovLstRewards from './supabase/govlst_rewards';
import { JsonDatabase } from './json/JsonDatabase';

export type DatabaseConfig = {
  type: 'supabase' | 'json';
  jsonDbPath?: string;
};

export class DatabaseWrapper implements IDatabase {
  private db: IDatabase;

  constructor(config: DatabaseConfig = { type: 'supabase' }) {
    if (config.type === 'json') {
      this.db = new JsonDatabase(config.jsonDbPath);
    } else {
      this.db = {
        createDeposit: supabaseDb.createDeposit,
        updateDeposit: supabaseDb.updateDeposit,
        getDeposit: supabaseDb.getDeposit,
        getDepositsByDelegatee: supabaseDb.getDepositsByDelegatee,
        getDepositsByOwner: supabaseDb.getDepositsByOwner,
        getAllDeposits: supabaseDb.getAllDeposits,
        updateCheckpoint: supabaseCheckpoints.updateCheckpoint,
        getCheckpoint: supabaseCheckpoints.getCheckpoint,

        // Processing Queue Operations
        createProcessingQueueItem:
          supabaseProcessingQueue.createProcessingQueueItem,
        updateProcessingQueueItem:
          supabaseProcessingQueue.updateProcessingQueueItem,
        getProcessingQueueItem: supabaseProcessingQueue.getProcessingQueueItem,
        getProcessingQueueItemsByStatus:
          supabaseProcessingQueue.getProcessingQueueItemsByStatus,
        getProcessingQueueItemByDepositId:
          supabaseProcessingQueue.getProcessingQueueItemByDepositId,
        getProcessingQueueItemsByDelegatee:
          supabaseProcessingQueue.getProcessingQueueItemsByDelegatee,
        deleteProcessingQueueItem:
          supabaseProcessingQueue.deleteProcessingQueueItem,

        // Transaction Queue Operations
        createTransactionQueueItem:
          supabaseTransactionQueue.createTransactionQueueItem,
        updateTransactionQueueItem:
          supabaseTransactionQueue.updateTransactionQueueItem,
        getTransactionQueueItem:
          supabaseTransactionQueue.getTransactionQueueItem,
        getTransactionQueueItemsByStatus:
          supabaseTransactionQueue.getTransactionQueueItemsByStatus,
        getTransactionQueueItemByDepositId:
          supabaseTransactionQueue.getTransactionQueueItemByDepositId,
        getTransactionQueueItemsByHash:
          supabaseTransactionQueue.getTransactionQueueItemsByHash,
        deleteTransactionQueueItem:
          supabaseTransactionQueue.deleteTransactionQueueItem,

        // GovLst Deposit Operations
        createGovLstDeposit: supabaseGovLstRewards.createGovLstDeposit,
        updateGovLstDeposit: supabaseGovLstRewards.updateGovLstDeposit,
        getGovLstDeposit: supabaseGovLstRewards.getGovLstDeposit,
        getGovLstDepositsByAddress: supabaseGovLstRewards.getGovLstDepositsByAddress,
        getAllGovLstDeposits: supabaseGovLstRewards.getAllGovLstDeposits,

        // GovLst Claim History Operations
        createGovLstClaimHistory: supabaseGovLstRewards.createGovLstClaimHistory,
        getGovLstClaimHistory: supabaseGovLstRewards.getGovLstClaimHistory,
        getGovLstClaimHistoryByAddress: supabaseGovLstRewards.getGovLstClaimHistoryByAddress,
        updateGovLstClaimHistory: supabaseGovLstRewards.updateGovLstClaimHistory,
      };
    }
  }

  // Deposits
  async createDeposit(deposit: Deposit): Promise<void> {
    return this.db.createDeposit(deposit);
  }

  async updateDeposit(
    depositId: string,
    update: Partial<Omit<Deposit, 'deposit_id'>>,
  ): Promise<void> {
    return this.db.updateDeposit(depositId, update);
  }

  async getDeposit(depositId: string): Promise<Deposit | null> {
    return this.db.getDeposit(depositId);
  }

  async getDepositsByDelegatee(delegateeAddress: string): Promise<Deposit[]> {
    return this.db.getDepositsByDelegatee(delegateeAddress);
  }

  async getAllDeposits(): Promise<Deposit[]> {
    if (this.db instanceof JsonDatabase) {
      return Object.values(this.db.data.deposits);
    } else {
      return await supabaseDb.getAllDeposits();
    }
  }

  // Checkpoints
  async updateCheckpoint(checkpoint: ProcessingCheckpoint): Promise<void> {
    return this.db.updateCheckpoint(checkpoint);
  }

  async getCheckpoint(
    componentType: string,
  ): Promise<ProcessingCheckpoint | null> {
    return this.db.getCheckpoint(componentType);
  }

  // Processing Queue methods
  async createProcessingQueueItem(
    item: Omit<
      ProcessingQueueItem,
      'id' | 'created_at' | 'updated_at' | 'attempts'
    >,
  ): Promise<ProcessingQueueItem> {
    return this.db.createProcessingQueueItem(item);
  }

  async updateProcessingQueueItem(
    id: string,
    update: Partial<
      Omit<ProcessingQueueItem, 'id' | 'created_at' | 'updated_at'>
    >,
  ): Promise<void> {
    return this.db.updateProcessingQueueItem(id, update);
  }

  async getProcessingQueueItem(
    id: string,
  ): Promise<ProcessingQueueItem | null> {
    return this.db.getProcessingQueueItem(id);
  }

  async getProcessingQueueItemsByStatus(
    status: ProcessingQueueStatus,
  ): Promise<ProcessingQueueItem[]> {
    return this.db.getProcessingQueueItemsByStatus(status);
  }

  async getProcessingQueueItemByDepositId(
    depositId: string,
  ): Promise<ProcessingQueueItem | null> {
    return this.db.getProcessingQueueItemByDepositId(depositId);
  }

  async getProcessingQueueItemsByDelegatee(
    delegatee: string,
  ): Promise<ProcessingQueueItem[]> {
    return this.db.getProcessingQueueItemsByDelegatee(delegatee);
  }

  async deleteProcessingQueueItem(id: string): Promise<void> {
    return this.db.deleteProcessingQueueItem(id);
  }

  // Transaction Queue methods
  async createTransactionQueueItem(
    item: Omit<
      TransactionQueueItem,
      'id' | 'created_at' | 'updated_at' | 'attempts'
    >,
  ): Promise<TransactionQueueItem> {
    return this.db.createTransactionQueueItem(item);
  }

  async updateTransactionQueueItem(
    id: string,
    update: Partial<
      Omit<TransactionQueueItem, 'id' | 'created_at' | 'updated_at'>
    >,
  ): Promise<void> {
    return this.db.updateTransactionQueueItem(id, update);
  }

  async getTransactionQueueItem(
    id: string,
  ): Promise<TransactionQueueItem | null> {
    return this.db.getTransactionQueueItem(id);
  }

  async getTransactionQueueItemsByStatus(
    status: TransactionQueueStatus,
  ): Promise<TransactionQueueItem[]> {
    return this.db.getTransactionQueueItemsByStatus(status);
  }

  async getTransactionQueueItemByDepositId(
    depositId: string,
  ): Promise<TransactionQueueItem | null> {
    return this.db.getTransactionQueueItemByDepositId(depositId);
  }

  async getTransactionQueueItemsByHash(
    hash: string,
  ): Promise<TransactionQueueItem[]> {
    return this.db.getTransactionQueueItemsByHash(hash);
  }

  async deleteTransactionQueueItem(id: string): Promise<void> {
    return this.db.deleteTransactionQueueItem(id);
  }

  // Add missing methods
  async getDepositsByOwner(ownerAddress: string): Promise<Deposit[]> {
    return this.db.getDepositsByOwner(ownerAddress);
  }

  // GovLst Deposit Operations
  async createGovLstDeposit(deposit: GovLstDeposit): Promise<void> {
    return this.db.createGovLstDeposit(deposit);
  }

  async updateGovLstDeposit(
    depositId: string,
    update: Partial<Omit<GovLstDeposit, 'deposit_id'>>
  ): Promise<void> {
    return this.db.updateGovLstDeposit(depositId, update);
  }

  async getGovLstDeposit(depositId: string): Promise<GovLstDeposit | null> {
    return this.db.getGovLstDeposit(depositId);
  }

  async getGovLstDepositsByAddress(govLstAddress: string): Promise<GovLstDeposit[]> {
    return this.db.getGovLstDepositsByAddress(govLstAddress);
  }

  async getAllGovLstDeposits(): Promise<GovLstDeposit[]> {
    return this.db.getAllGovLstDeposits();
  }

  // GovLst Claim History Operations
  async createGovLstClaimHistory(claim: GovLstClaimHistory): Promise<GovLstClaimHistory> {
    return this.db.createGovLstClaimHistory(claim);
  }

  async getGovLstClaimHistory(id: string): Promise<GovLstClaimHistory | null> {
    return this.db.getGovLstClaimHistory(id);
  }

  async getGovLstClaimHistoryByAddress(govLstAddress: string): Promise<GovLstClaimHistory[]> {
    return this.db.getGovLstClaimHistoryByAddress(govLstAddress);
  }

  async updateGovLstClaimHistory(
    id: string,
    update: Partial<Omit<GovLstClaimHistory, 'id' | 'created_at' | 'updated_at'>>
  ): Promise<void> {
    return this.db.updateGovLstClaimHistory(id, update);
  }
}
