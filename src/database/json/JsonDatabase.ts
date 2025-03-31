import fs from 'fs/promises';
import path from 'path';
import { IDatabase } from '../interfaces/IDatabase';
import {
  Deposit,
  ProcessingCheckpoint,
  ProcessingQueueItem,
  TransactionQueueItem,
  ProcessingQueueStatus,
  TransactionQueueStatus,
  GovLstDeposit,
  GovLstClaimHistory,
} from '../interfaces/types';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { v4 as uuidv4 } from 'uuid';

export class JsonDatabase implements IDatabase {
  private dbPath: string;
  private logger: Logger;
  public data: {
    deposits: Record<string, Deposit>;
    checkpoints: Record<string, ProcessingCheckpoint>;
    processing_queue: Record<string, ProcessingQueueItem>;
    transaction_queue: Record<string, TransactionQueueItem>;
    govlst_deposits: Record<string, GovLstDeposit>;
    govlst_claim_history: Record<string, GovLstClaimHistory>;
  };

  constructor(dbPath = 'staker-monitor-db.json') {
    this.dbPath = path.resolve(process.cwd(), dbPath);
    this.logger = new ConsoleLogger('info');
    this.data = {
      deposits: {},
      checkpoints: {},
      processing_queue: {},
      transaction_queue: {},
      govlst_deposits: {},
      govlst_claim_history: {},
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
        processing_queue: loadedData.processing_queue || {},
        transaction_queue: loadedData.transaction_queue || {},
        govlst_deposits: loadedData.govlst_deposits || {},
        govlst_claim_history: loadedData.govlst_claim_history || {},
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

  async getDepositsByDepositor(depositorAddress: string): Promise<Deposit[]> {
    return Object.values(this.data.deposits).filter(
      (deposit) => deposit.depositor_address === depositorAddress,
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

  // Processing Queue methods
  async createProcessingQueueItem(
    item: Omit<
      ProcessingQueueItem,
      'id' | 'created_at' | 'updated_at' | 'attempts'
    >,
  ): Promise<ProcessingQueueItem> {
    const id = uuidv4();
    const now = new Date().toISOString();
    const newItem: ProcessingQueueItem = {
      id,
      ...item,
      attempts: 0,
      created_at: now,
      updated_at: now,
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
      throw new Error(`Processing queue item ${id} not found`);
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
    return this.data.processing_queue[id] || null;
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
    if (items.length === 0) return null;
    // Sort by updated_at descending to get the most recent item
    const sortedItems = items.sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    return sortedItems[0] ?? null;
  }

  async getProcessingQueueItemsByDelegatee(
    delegatee: string,
  ): Promise<ProcessingQueueItem[]> {
    return Object.values(this.data.processing_queue).filter(
      (item) => item.delegatee === delegatee,
    );
  }

  async deleteProcessingQueueItem(id: string): Promise<void> {
    delete this.data.processing_queue[id];
    await this.saveToFile();
  }

  // Transaction Queue methods
  async createTransactionQueueItem(
    item: Omit<
      TransactionQueueItem,
      'id' | 'created_at' | 'updated_at' | 'attempts'
    >,
  ): Promise<TransactionQueueItem> {
    const id = uuidv4();
    const now = new Date().toISOString();
    const newItem: TransactionQueueItem = {
      id,
      ...item,
      attempts: 0,
      created_at: now,
      updated_at: now,
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
      throw new Error(`Transaction queue item ${id} not found`);
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
    return this.data.transaction_queue[id] || null;
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
    if (items.length === 0) return null;
    // Sort by updated_at descending to get the most recent item
    const sortedItems = items.sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    return sortedItems[0] ?? null;
  }

  async getTransactionQueueItemsByHash(
    hash: string,
  ): Promise<TransactionQueueItem[]> {
    return Object.values(this.data.transaction_queue).filter(
      (item) => item.hash === hash,
    );
  }

  async deleteTransactionQueueItem(id: string): Promise<void> {
    delete this.data.transaction_queue[id];
    await this.saveToFile();
  }

  // GovLst Deposit Operations
  async createGovLstDeposit(deposit: GovLstDeposit): Promise<void> {
    this.data.govlst_deposits[deposit.deposit_id] = {
      ...deposit,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await this.saveToFile();
  }

  async updateGovLstDeposit(
    depositId: string,
    update: Partial<Omit<GovLstDeposit, 'deposit_id'>>,
  ): Promise<void> {
    const existing = this.data.govlst_deposits[depositId];
    if (!existing) {
      throw new Error(`GovLst deposit not found: ${depositId}`);
    }

    this.data.govlst_deposits[depositId] = {
      ...existing,
      ...update,
      updated_at: new Date().toISOString(),
    };

    await this.saveToFile();
  }

  async getGovLstDeposit(depositId: string): Promise<GovLstDeposit | null> {
    return this.data.govlst_deposits[depositId] || null;
  }

  async getGovLstDepositsByAddress(
    govLstAddress: string,
  ): Promise<GovLstDeposit[]> {
    return Object.values(this.data.govlst_deposits).filter(
      (deposit) => deposit.govlst_address === govLstAddress,
    );
  }

  async getAllGovLstDeposits(): Promise<GovLstDeposit[]> {
    return Object.values(this.data.govlst_deposits);
  }

  // GovLst Claim History Operations
  async createGovLstClaimHistory(
    claim: GovLstClaimHistory,
  ): Promise<GovLstClaimHistory> {
    const id = claim.id || uuidv4();
    const newClaim = {
      ...claim,
      id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    this.data.govlst_claim_history[id] = newClaim;
    await this.saveToFile();

    return newClaim;
  }

  async getGovLstClaimHistory(id: string): Promise<GovLstClaimHistory | null> {
    return this.data.govlst_claim_history[id] || null;
  }

  async getGovLstClaimHistoryByAddress(
    govLstAddress: string,
  ): Promise<GovLstClaimHistory[]> {
    return Object.values(this.data.govlst_claim_history).filter(
      (claim) => claim.govlst_address === govLstAddress,
    );
  }

  async updateGovLstClaimHistory(
    id: string,
    update: Partial<
      Omit<GovLstClaimHistory, 'id' | 'created_at' | 'updated_at'>
    >,
  ): Promise<void> {
    const existing = this.data.govlst_claim_history[id];
    if (!existing) {
      throw new Error(`GovLst claim history not found: ${id}`);
    }

    this.data.govlst_claim_history[id] = {
      ...existing,
      ...update,
      updated_at: new Date().toISOString(),
    };

    await this.saveToFile();
  }

  // Don't forget to implement getDepositsByOwner if it doesn't exist
  async getDepositsByOwner(ownerAddress: string): Promise<Deposit[]> {
    return Object.values(this.data.deposits).filter(
      (deposit) => deposit.owner_address === ownerAddress,
    );
  }
}
