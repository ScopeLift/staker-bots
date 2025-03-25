import { IDatabase } from './interfaces/IDatabase';
import {
  Deposit,
  ProcessingCheckpoint,
  ScoreEvent,
  ProcessingQueueItem,
  TransactionQueueItem,
  ProcessingQueueStatus,
  TransactionQueueStatus,
} from './interfaces/types';
import * as supabaseDb from './supabase/deposits';
import * as supabaseCheckpoints from './supabase/checkpoints';
import * as supabaseScoreEvents from './supabase/score_events';
import * as supabaseProcessingQueue from './supabase/processing_queue';
import * as supabaseTransactionQueue from './supabase/transaction_queue';
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
        getAllDeposits: supabaseDb.getAllDeposits,
        updateCheckpoint: supabaseCheckpoints.updateCheckpoint,
        getCheckpoint: supabaseCheckpoints.getCheckpoint,
        createScoreEvent: supabaseScoreEvents.createScoreEvent,
        updateScoreEvent: supabaseScoreEvents.updateScoreEvent,
        deleteScoreEvent: supabaseScoreEvents.deleteScoreEvent,
        getScoreEvent: supabaseScoreEvents.getScoreEvent,
        getLatestScoreEvent: supabaseScoreEvents.getLatestScoreEvent,
        getScoreEventsByBlockRange:
          supabaseScoreEvents.getScoreEventsByBlockRange,
        deleteScoreEventsByBlockRange:
          supabaseScoreEvents.deleteScoreEventsByBlockRange,

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

  // Score Events
  async createScoreEvent(event: ScoreEvent): Promise<void> {
    return this.db.createScoreEvent(event);
  }

  async updateScoreEvent(
    delegatee: string,
    blockNumber: number,
    update: Partial<ScoreEvent>,
  ): Promise<void> {
    return this.db.updateScoreEvent(delegatee, blockNumber, update);
  }

  async deleteScoreEvent(
    delegatee: string,
    blockNumber: number,
  ): Promise<void> {
    return this.db.deleteScoreEvent(delegatee, blockNumber);
  }

  async getScoreEvent(
    delegatee: string,
    blockNumber: number,
  ): Promise<ScoreEvent | null> {
    return this.db.getScoreEvent(delegatee, blockNumber);
  }

  async getLatestScoreEvent(delegatee: string): Promise<ScoreEvent | null> {
    return this.db.getLatestScoreEvent(delegatee);
  }

  async getScoreEventsByBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<ScoreEvent[]> {
    return this.db.getScoreEventsByBlockRange(fromBlock, toBlock);
  }

  async deleteScoreEventsByBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    return this.db.deleteScoreEventsByBlockRange(fromBlock, toBlock);
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
}
