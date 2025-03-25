import fs from 'fs/promises';
import path from 'path';
import { IDatabase } from '../interfaces/IDatabase';
import {
  Deposit,
  ProcessingCheckpoint,
  ScoreEvent,
  ProcessingQueueItem,
  TransactionQueueItem,
  ProcessingQueueStatus,
  TransactionQueueStatus,
} from '../interfaces/types';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { v4 as uuidv4 } from 'uuid';

export class JsonDatabase implements IDatabase {
  private dbPath: string;
  private logger: Logger;
  public data: {
    deposits: Record<string, Deposit>;
    checkpoints: Record<string, ProcessingCheckpoint>;
    score_events: Record<string, Record<number, ScoreEvent>>;
    processing_queue: Record<string, ProcessingQueueItem>;
    transaction_queue: Record<string, TransactionQueueItem>;
  };

  constructor(dbPath = 'staker-monitor-db.json') {
    this.dbPath = path.resolve(process.cwd(), dbPath);
    this.logger = new ConsoleLogger('info');
    this.data = {
      deposits: {},
      checkpoints: {},
      score_events: {},
      processing_queue: {},
      transaction_queue: {},
    };
    this.logger.info('JsonDatabase initialized at:', { path: this.dbPath });
    this.initializeDb();
  }

  private async initializeDb() {
    try {
      const fileContent = await fs.readFile(this.dbPath, 'utf-8');
      const loadedData = JSON.parse(fileContent);

      // Ensure all required sections exist
      this.data = {
        deposits: loadedData.deposits || {},
        checkpoints: loadedData.checkpoints || {},
        score_events: loadedData.score_events || {},
        processing_queue: loadedData.processing_queue || {},
        transaction_queue: loadedData.transaction_queue || {},
      };

      this.logger.info('Loaded existing database');
    } catch (error) {
      // If file doesn't exist, create it with empty data
      await this.saveToFile();
      this.logger.info('Created new database file');
    }
  }

  private async saveToFile() {
    await fs.writeFile(this.dbPath, JSON.stringify(this.data, null, 2));
    this.logger.debug('Saved database to file');
  }

  // Deposits
  async createDeposit(deposit: Deposit): Promise<void> {
    const now = new Date().toISOString();
    this.data.deposits[deposit.deposit_id] = {
      ...deposit,
      created_at: now,
      updated_at: now,
    };
    await this.saveToFile();
  }

  async deleteDeposit(depositId: string): Promise<void> {
    if (!this.data.deposits[depositId]) {
      throw new Error(`Deposit ${depositId} not found`);
    }

    delete this.data.deposits[depositId];
    await this.saveToFile();
  }

  async updateDeposit(
    depositId: string,
    update: Partial<Omit<Deposit, 'deposit_id'>>,
  ): Promise<void> {
    const deposit = this.data.deposits[depositId];
    if (!deposit) {
      throw new Error(`Deposit ${depositId} not found`);
    }
    this.data.deposits[depositId] = {
      ...deposit,
      ...update,
    };
    await this.saveToFile();
  }

  async getDeposit(depositId: string): Promise<Deposit | null> {
    return this.data.deposits[depositId] || null;
  }

  async getDepositsByDelegatee(delegateeAddress: string): Promise<Deposit[]> {
    return Object.values(this.data.deposits).filter(
      (deposit) => deposit.delegatee_address === delegateeAddress,
    );
  }

  async getAllDeposits(): Promise<Deposit[]> {
    return Object.values(this.data.deposits);
  }

  // Checkpoints
  async updateCheckpoint(checkpoint: ProcessingCheckpoint): Promise<void> {
    this.data.checkpoints[checkpoint.component_type] = {
      ...checkpoint,
      last_update: new Date().toISOString(),
    };
    await this.saveToFile();
    this.logger.debug('Updated checkpoint:', { checkpoint });
  }

  async getCheckpoint(
    componentType: string,
  ): Promise<ProcessingCheckpoint | null> {
    this.logger.debug('Fetching checkpoint for component:', { componentType });
    const checkpoint = this.data.checkpoints[componentType] || null;
    this.logger.debug('Retrieved checkpoint:', { checkpoint });
    return checkpoint;
  }

  // Score Events
  async createScoreEvent(event: ScoreEvent): Promise<void> {
    if (!this.data.score_events[event.delegatee]) {
      this.data.score_events[event.delegatee] = {};
    }
    const delegateeEvents = this.data.score_events[event.delegatee]!; // Now safe to use !

    const now = new Date().toISOString();
    delegateeEvents[event.block_number] = {
      ...event,
      created_at: now,
      updated_at: now,
    };
    await this.saveToFile();
  }

  async updateScoreEvent(
    delegatee: string,
    blockNumber: number,
    update: Partial<ScoreEvent>,
  ): Promise<void> {
    const delegateeEvents = this.data.score_events[delegatee];
    const event = delegateeEvents?.[blockNumber];
    if (!event || !delegateeEvents) {
      throw new Error(
        `Score event not found for delegatee ${delegatee} at block ${blockNumber}`,
      );
    }

    delegateeEvents[blockNumber] = {
      ...event,
      ...update,
      updated_at: new Date().toISOString(),
    };
    await this.saveToFile();
  }

  async deleteScoreEvent(
    delegatee: string,
    blockNumber: number,
  ): Promise<void> {
    const delegateeEvents = this.data.score_events[delegatee];
    if (!delegateeEvents?.[blockNumber]) {
      throw new Error(
        `Score event not found for delegatee ${delegatee} at block ${blockNumber}`,
      );
    }

    delete delegateeEvents[blockNumber];
    if (Object.keys(delegateeEvents).length === 0) {
      delete this.data.score_events[delegatee];
    }
    await this.saveToFile();
  }

  async getScoreEvent(
    delegatee: string,
    blockNumber: number,
  ): Promise<ScoreEvent | null> {
    return this.data.score_events[delegatee]?.[blockNumber] || null;
  }

  async getLatestScoreEvent(delegatee: string): Promise<ScoreEvent | null> {
    const events = this.data.score_events[delegatee];
    if (!events) return null;

    const blockNumbers = Object.keys(events).map(Number);
    if (blockNumbers.length === 0) return null;

    const latestBlock = Math.max(...blockNumbers);
    return events[latestBlock] || null;
  }

  async getScoreEventsByBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<ScoreEvent[]> {
    const events: ScoreEvent[] = [];

    Object.values(this.data.score_events).forEach((delegateeEvents) => {
      Object.entries(delegateeEvents).forEach(([blockStr, event]) => {
        const blockNumber = Number(blockStr);
        if (blockNumber >= fromBlock && blockNumber <= toBlock) {
          events.push(event);
        }
      });
    });

    return events.sort((a, b) => a.block_number - b.block_number);
  }

  async deleteScoreEventsByBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    Object.entries(this.data.score_events).forEach(([delegatee, events]) => {
      Object.keys(events).forEach((blockStr) => {
        const blockNumber = Number(blockStr);
        if (blockNumber >= fromBlock && blockNumber <= toBlock) {
          delete events[blockNumber];
        }
      });
      // Clean up empty delegatee entries
      if (Object.keys(events).length === 0) {
        delete this.data.score_events[delegatee];
      }
    });
    await this.saveToFile();
  }

  // Processing Queue methods
  async createProcessingQueueItem(
    item: Omit<
      ProcessingQueueItem,
      'id' | 'created_at' | 'updated_at' | 'attempts'
    >,
  ): Promise<ProcessingQueueItem> {
    const now = new Date().toISOString();
    const id = uuidv4();

    const newItem: ProcessingQueueItem = {
      ...item,
      id,
      created_at: now,
      updated_at: now,
      attempts: 0,
    };

    this.data.processing_queue[id] = newItem;
    await this.saveToFile();

    return newItem;
  }

  async updateProcessingQueueItem(
    id: string,
    update: Partial<
      Omit<ProcessingQueueItem, 'id' | 'created_at' | 'updated_at'>
    >,
  ): Promise<void> {
    const item = this.data.processing_queue[id];

    if (!item) {
      throw new Error(`Processing queue item with id ${id} not found`);
    }

    this.data.processing_queue[id] = {
      ...item,
      ...update,
      updated_at: new Date().toISOString(),
    };

    await this.saveToFile();
  }

  async getProcessingQueueItem(
    id: string,
  ): Promise<ProcessingQueueItem | null> {
    return id in this.data.processing_queue
      ? this.data.processing_queue[id]!
      : null;
  }

  async getProcessingQueueItemsByStatus(
    status: ProcessingQueueStatus,
  ): Promise<ProcessingQueueItem[]> {
    return Object.values(this.data.processing_queue).filter(
      (item) => item.status === status,
    );
  }

  async getProcessingQueueItemByDepositId(
    depositId: string,
  ): Promise<ProcessingQueueItem | null> {
    const items = Object.values(this.data.processing_queue).filter(
      (item) => item.deposit_id === depositId,
    );

    // Return the most recently updated item if multiple exist
    if (items.length > 0) {
      return items.sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )[0]!;
    }

    return null;
  }

  async getProcessingQueueItemsByDelegatee(
    delegatee: string,
  ): Promise<ProcessingQueueItem[]> {
    return Object.values(this.data.processing_queue).filter(
      (item) => item.delegatee === delegatee,
    );
  }

  async deleteProcessingQueueItem(id: string): Promise<void> {
    if (this.data.processing_queue[id]) {
      delete this.data.processing_queue[id];
      await this.saveToFile();
    }
  }

  // Transaction Queue methods
  async createTransactionQueueItem(
    item: Omit<
      TransactionQueueItem,
      'id' | 'created_at' | 'updated_at' | 'attempts'
    >,
  ): Promise<TransactionQueueItem> {
    const now = new Date().toISOString();
    const id = uuidv4();

    const newItem: TransactionQueueItem = {
      ...item,
      id,
      created_at: now,
      updated_at: now,
      attempts: 0,
    };

    this.data.transaction_queue[id] = newItem;
    await this.saveToFile();

    return newItem;
  }

  async updateTransactionQueueItem(
    id: string,
    update: Partial<
      Omit<TransactionQueueItem, 'id' | 'created_at' | 'updated_at'>
    >,
  ): Promise<void> {
    const item = this.data.transaction_queue[id];

    if (!item) {
      throw new Error(`Transaction queue item with id ${id} not found`);
    }

    this.data.transaction_queue[id] = {
      ...item,
      ...update,
      updated_at: new Date().toISOString(),
    };

    await this.saveToFile();
  }

  async getTransactionQueueItem(
    id: string,
  ): Promise<TransactionQueueItem | null> {
    return id in this.data.transaction_queue
      ? this.data.transaction_queue[id]!
      : null;
  }

  async getTransactionQueueItemsByStatus(
    status: TransactionQueueStatus,
  ): Promise<TransactionQueueItem[]> {
    return Object.values(this.data.transaction_queue).filter(
      (item) => item.status === status,
    );
  }

  async getTransactionQueueItemByDepositId(
    depositId: string,
  ): Promise<TransactionQueueItem | null> {
    const items = Object.values(this.data.transaction_queue).filter(
      (item) => item.deposit_id === depositId,
    );

    // Return the most recently updated item if multiple exist
    if (items.length > 0) {
      return items.sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )[0]!;
    }

    return null;
  }

  async getTransactionQueueItemsByHash(
    hash: string,
  ): Promise<TransactionQueueItem[]> {
    return Object.values(this.data.transaction_queue).filter(
      (item) => item.hash === hash,
    );
  }

  async deleteTransactionQueueItem(id: string): Promise<void> {
    if (this.data.transaction_queue[id]) {
      delete this.data.transaction_queue[id];
      await this.saveToFile();
    }
  }
}
