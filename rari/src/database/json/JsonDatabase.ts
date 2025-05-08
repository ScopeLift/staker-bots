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
  GovLstClaimHistory,
  ErrorLog,
  ScoreEvent,
  TransactionType,
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
    govlst_claim_history: Record<string, GovLstClaimHistory>;
    errors: Record<string, ErrorLog>;
    score_events: ScoreEvent[];
  };

  constructor(dbPath = 'staker-monitor-db.json') {
    // Ensure absolute path and create directory if needed
    this.dbPath = path.isAbsolute(dbPath)
      ? dbPath
      : path.resolve(process.cwd(), dbPath);

    // Ensure directory exists
    const dbDir = path.dirname(this.dbPath);
    fs.mkdir(dbDir, { recursive: true }).catch((error) => {
      this.logger.error('Failed to create database directory:', {
        error: error instanceof Error ? error.message : String(error),
        path: dbDir,
      });
    });

    this.logger = new ConsoleLogger('info');
    this.data = {
      deposits: {},
      checkpoints: {},
      processing_queue: {},
      transaction_queue: {},
      govlst_claim_history: {},
      errors: {},
      score_events: [],
    };

    this.logger.info('JsonDatabase initializing at:', { path: this.dbPath });
    this.initializeDb().catch((error) => {
      this.logger.error('Failed to initialize database:', {
        error: error instanceof Error ? error.message : String(error),
        path: this.dbPath,
      });
    });
  }

  private async initializeDb() {
    try {
      // Check if file exists first
      try {
        await fs.access(this.dbPath);
      } catch (accessError) {
        // File doesn't exist, create it with empty data
        await this.saveToFile();
        this.logger.info('Created new database file:', { path: this.dbPath });
        return;
      }

      // File exists, try to read it with retries
      let retries = 3;
      let lastError;

      while (retries > 0) {
        try {
          const fileContent = await fs.readFile(this.dbPath, 'utf-8');
          const loadedData = JSON.parse(fileContent);

          // Ensure all required sections exist with existing data
          this.data = {
            deposits: loadedData.deposits || {},
            checkpoints: loadedData.checkpoints || {},
            processing_queue: loadedData.processing_queue || {},
            transaction_queue: loadedData.transaction_queue || {},
            govlst_claim_history: loadedData.govlst_claim_history || {},
            errors: loadedData.errors || {},
            score_events: loadedData.score_events || [],
          };

          this.logger.info('Successfully loaded existing database:', {
            deposits: Object.keys(this.data.deposits).length,
            checkpoints: Object.keys(this.data.checkpoints).length,
            processing_queue: Object.keys(this.data.processing_queue).length,
            transaction_queue: Object.keys(this.data.transaction_queue).length,
            govlst_claim_history: Object.keys(this.data.govlst_claim_history)
              .length,
          });
          return;
        } catch (error) {
          lastError = error;
          retries--;
          if (retries > 0) {
            // Wait for 1 second before retrying
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }

      // If we get here, all retries failed
      this.logger.error('Failed to load database after retries:', {
        error: lastError,
        path: this.dbPath,
      });
      throw lastError;
    } catch (error) {
      this.logger.error('Database initialization error:', {
        error: error instanceof Error ? error.message : String(error),
        path: this.dbPath,
      });
      throw error;
    }
  }

  private async saveToFile() {
    let retries = 3;
    let lastError;

    while (retries > 0) {
      try {
        // Create a temporary file first
        const tempPath = `${this.dbPath}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(this.data, null, 2));

        // Rename temp file to actual file (atomic operation)
        await fs.rename(tempPath, this.dbPath);

        this.logger.debug('Successfully saved database to file:', {
          path: this.dbPath,
          deposits: Object.keys(this.data.deposits).length,
          checkpoints: Object.keys(this.data.checkpoints).length,
        });
        return;
      } catch (error) {
        lastError = error;
        retries--;
        if (retries > 0) {
          // Wait for 1 second before retrying
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }

    // If we get here, all retries failed
    this.logger.error('Failed to save database after retries:', {
      error: lastError,
      path: this.dbPath,
    });
    throw lastError;
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

  // Error Logs methods
  async createErrorLog(errorLog: ErrorLog): Promise<ErrorLog> {
    const id = uuidv4();
    const now = new Date().toISOString();
    const newErrorLog: ErrorLog = {
      id,
      ...errorLog,
      created_at: now,
    };
    this.data.errors[id] = newErrorLog;
    await this.saveToFile();
    return newErrorLog;
  }

  async getErrorLogs(limit = 50, offset = 0): Promise<ErrorLog[]> {
    const errors = Object.values(this.data.errors);
    // Sort by created_at in descending order (newest first)
    errors.sort((a, b) => {
      const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return dateB - dateA;
    });
    return errors.slice(offset, offset + limit);
  }

  async getErrorLogsByService(
    serviceName: string,
    limit = 50,
    offset = 0,
  ): Promise<ErrorLog[]> {
    const errors = Object.values(this.data.errors).filter(
      (error) => error.service_name === serviceName,
    );
    // Sort by created_at in descending order (newest first)
    errors.sort((a, b) => {
      const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return dateB - dateA;
    });
    return errors.slice(offset, offset + limit);
  }

  async getErrorLogsBySeverity(
    severity: string,
    limit = 50,
    offset = 0,
  ): Promise<ErrorLog[]> {
    const errors = Object.values(this.data.errors).filter(
      (error) => error.severity === severity,
    );
    // Sort by created_at in descending order (newest first)
    errors.sort((a, b) => {
      const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return dateB - dateA;
    });
    return errors.slice(offset, offset + limit);
  }

  async deleteErrorLog(id: string): Promise<void> {
    delete this.data.errors[id];
    await this.saveToFile();
  }

  // Score Events
  async createScoreEvent(event: ScoreEvent): Promise<void> {
    if (!this.data.score_events) {
      this.data.score_events = [];
    }
    this.data.score_events.push({
      ...event,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await this.saveToFile();
  }

  async getLatestScoreEvent(delegatee: string): Promise<ScoreEvent | null> {
    if (!this.data.score_events) {
      return null;
    }
    const events = this.data.score_events
      .filter((event: ScoreEvent) => event.delegatee === delegatee)
      .sort((a: ScoreEvent, b: ScoreEvent) => b.block_number - a.block_number);
    return events[0] || null;
  }

  async getTransactionQueueItemsByType(
    type: TransactionType,
    status?: TransactionQueueStatus,
  ): Promise<TransactionQueueItem[]> {
    const items = Object.values(this.data.transaction_queue).filter(
      (item) => item.transaction_type === type,
    );

    if (status) {
      return items.filter((item) => item.status === status);
    }

    return items;
  }

  async getTransactionQueueItemsByTypeAndStatus(
    type: TransactionType,
    status: TransactionQueueStatus,
  ): Promise<TransactionQueueItem[]> {
    return Object.values(this.data.transaction_queue).filter(
      (item) => item.transaction_type === type && item.status === status,
    );
  }
}
