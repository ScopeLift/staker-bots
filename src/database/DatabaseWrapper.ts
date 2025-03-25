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
import { ConsoleLogger, Logger } from '@/monitor/logging';

export type DatabaseConfig = {
  type: 'supabase' | 'json';
  jsonDbPath?: string;
  fallbackToJson?: boolean;
};

export class DatabaseWrapper implements IDatabase {
  private db: IDatabase;
  private fallbackDb: JsonDatabase | null = null;
  private usingFallback = false;
  private logger: Logger;
  private fallbackToJson: boolean;

  constructor(config: DatabaseConfig = { type: 'supabase', fallbackToJson: true }) {
    this.logger = new ConsoleLogger('info');
    this.fallbackToJson = config.fallbackToJson ?? true;

    if (config.type === 'json') {
      this.db = new JsonDatabase(config.jsonDbPath);
    } else {
      // Initialize with Supabase
      this.db = {
        getDepositsByDepositor: this.wrapWithFallback(supabaseDb.getDepositsByDepositor),
        createDeposit: this.wrapWithFallback(supabaseDb.createDeposit),
        updateDeposit: this.wrapWithFallback(supabaseDb.updateDeposit),
        getDeposit: this.wrapWithFallback(supabaseDb.getDeposit),
        getDepositsByDelegatee: this.wrapWithFallback(supabaseDb.getDepositsByDelegatee),
        getDepositsByOwner: this.wrapWithFallback(supabaseDb.getDepositsByOwner),
        getAllDeposits: this.wrapWithFallback(supabaseDb.getAllDeposits),
        updateCheckpoint: this.wrapWithFallback(supabaseCheckpoints.updateCheckpoint),
        getCheckpoint: this.wrapWithFallback(supabaseCheckpoints.getCheckpoint),

        // Processing Queue Operations
        createProcessingQueueItem: this.wrapWithFallback(
          supabaseProcessingQueue.createProcessingQueueItem
        ),
        updateProcessingQueueItem: this.wrapWithFallback(
          supabaseProcessingQueue.updateProcessingQueueItem
        ),
        getProcessingQueueItem: this.wrapWithFallback(
          supabaseProcessingQueue.getProcessingQueueItem
        ),
        getProcessingQueueItemsByStatus: this.wrapWithFallback(
          supabaseProcessingQueue.getProcessingQueueItemsByStatus
        ),
        getProcessingQueueItemByDepositId: this.wrapWithFallback(
          supabaseProcessingQueue.getProcessingQueueItemByDepositId
        ),
        getProcessingQueueItemsByDelegatee: this.wrapWithFallback(
          supabaseProcessingQueue.getProcessingQueueItemsByDelegatee
        ),
        deleteProcessingQueueItem: this.wrapWithFallback(
          supabaseProcessingQueue.deleteProcessingQueueItem
        ),

        // Transaction Queue Operations
        createTransactionQueueItem: this.wrapWithFallback(
          supabaseTransactionQueue.createTransactionQueueItem
        ),
        updateTransactionQueueItem: this.wrapWithFallback(
          supabaseTransactionQueue.updateTransactionQueueItem
        ),
        getTransactionQueueItem: this.wrapWithFallback(
          supabaseTransactionQueue.getTransactionQueueItem
        ),
        getTransactionQueueItemsByStatus: this.wrapWithFallback(
          supabaseTransactionQueue.getTransactionQueueItemsByStatus
        ),
        getTransactionQueueItemByDepositId: this.wrapWithFallback(
          supabaseTransactionQueue.getTransactionQueueItemByDepositId
        ),
        getTransactionQueueItemsByHash: this.wrapWithFallback(
          supabaseTransactionQueue.getTransactionQueueItemsByHash
        ),
        deleteTransactionQueueItem: this.wrapWithFallback(
          supabaseTransactionQueue.deleteTransactionQueueItem
        ),

        // GovLst Deposit Operations
        createGovLstDeposit: this.wrapWithFallback(supabaseGovLstRewards.createGovLstDeposit),
        updateGovLstDeposit: this.wrapWithFallback(supabaseGovLstRewards.updateGovLstDeposit),
        getGovLstDeposit: this.wrapWithFallback(supabaseGovLstRewards.getGovLstDeposit),
        getGovLstDepositsByAddress: this.wrapWithFallback(supabaseGovLstRewards.getGovLstDepositsByAddress),
        getAllGovLstDeposits: this.wrapWithFallback(supabaseGovLstRewards.getAllGovLstDeposits),

        // GovLst Claim History Operations
        createGovLstClaimHistory: this.wrapWithFallback(supabaseGovLstRewards.createGovLstClaimHistory),
        getGovLstClaimHistory: this.wrapWithFallback(supabaseGovLstRewards.getGovLstClaimHistory),
        getGovLstClaimHistoryByAddress: this.wrapWithFallback(supabaseGovLstRewards.getGovLstClaimHistoryByAddress),
        updateGovLstClaimHistory: this.wrapWithFallback(supabaseGovLstRewards.updateGovLstClaimHistory),
      };
    }
  }

  private getFallbackDb(): JsonDatabase {
    if (!this.fallbackDb) {
      this.logger.warn('Initializing fallback JsonDatabase');
      this.fallbackDb = new JsonDatabase();
    }
    return this.fallbackDb;
  }

  private wrapWithFallback<T extends (...args: any[]) => Promise<any>>(
    fn: T
  ): T {
    return (async (...args: Parameters<T>): Promise<ReturnType<T>> => {
      if (this.usingFallback) {
        // Already using fallback, call the equivalent method on fallbackDb
        const fallbackDb = this.getFallbackDb();
        const methodName = fn.name;
        // @ts-ignore - Dynamic method call
        return fallbackDb[methodName](...args);
      }

      try {
        return await fn(...args);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('Supabase client is not available') &&
          this.fallbackToJson
        ) {
          // Supabase is not available, switch to fallback
          if (!this.usingFallback) {
            this.logger.warn('Supabase not available, switching to JsonDatabase fallback', { error });
            this.usingFallback = true;
          }

          const fallbackDb = this.getFallbackDb();
          const methodName = fn.name;
          // @ts-ignore - Dynamic method call
          return fallbackDb[methodName](...args);
        }
        throw error;
      }
    }) as T;
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
    return this.db.getAllDeposits();
  }

  async getDepositsByDepositor(depositorAddress: string): Promise<Deposit[]> {
    return this.db.getDepositsByDepositor(depositorAddress);
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
