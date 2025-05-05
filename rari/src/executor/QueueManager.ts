import { DatabaseWrapper } from '@/database';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import {
  TransactionType,
  TransactionQueueItem,
  TransactionQueueStatus,
} from '@/database/interfaces/types';
import { GovLstProfitabilityCheck } from '@/profitability/interfaces/types';
import { v4 as uuidv4 } from 'uuid';

interface QueueItemStats {
  total: number;
  pending: number;
  submitted: number;
  confirmed: number;
  failed: number;
}

export class QueueManager {
  private logger: Logger;

  constructor(
    private readonly type: TransactionType,
    private readonly db: DatabaseWrapper,
  ) {
    this.logger = new ConsoleLogger('info');
  }

  async addTransaction(
    depositIds: bigint[],
    profitability: GovLstProfitabilityCheck,
    txData?: string,
  ): Promise<TransactionQueueItem> {
    if (depositIds.length === 0) {
      throw new Error('At least one deposit ID is required');
    }

    const firstDepositId = depositIds[0];
    if (!firstDepositId) {
      throw new Error('Invalid deposit ID');
    }

    const now = new Date().toISOString();
    
    const item: Omit<TransactionQueueItem, 'id' | 'created_at' | 'updated_at' | 'attempts'> = {
      transaction_type: this.type,
      deposit_id: firstDepositId.toString(),
      status: TransactionQueueStatus.PENDING,
      tx_data: txData || JSON.stringify({ depositIds: depositIds.map(String), profitability }),
      profitability_check: JSON.stringify(profitability),
    };

    try {
      const queueItem = await this.db.createTransactionQueueItem(item);
      this.logger.info('Added transaction to queue', {
        type: this.type,
        depositIds: depositIds.map(String),
        queueItemId: queueItem.id,
      });
      return queueItem;
    } catch (error) {
      this.logger.error('Failed to add transaction to queue', {
        error: error instanceof Error ? error.message : String(error),
        type: this.type,
        depositIds: depositIds.map(String),
      });
      throw error;
    }
  }

  async getNextTransaction(): Promise<TransactionQueueItem | null> {
    try {
      const pendingItems = await this.db.getTransactionQueueItemsByStatus(
        TransactionQueueStatus.PENDING,
      );

      // Filter by type and sort by created_at to get the oldest first
      const sortedItems = pendingItems
        .filter((item) => item.transaction_type === this.type)
        .sort((a, b) => 
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );

      return sortedItems[0] || null;
    } catch (error) {
      this.logger.error('Failed to get next transaction', {
        error: error instanceof Error ? error.message : String(error),
        type: this.type,
      });
      throw error;
    }
  }

  async getQueueStats(): Promise<QueueItemStats> {
    try {
      // Get all items regardless of status
      const allItems = await this.db.getTransactionQueueItemsByStatus(
        TransactionQueueStatus.PENDING,
      );
      const typeItems = allItems.filter((item) => item.transaction_type === this.type);
      
      return {
        total: typeItems.length,
        pending: typeItems.filter(item => item.status === TransactionQueueStatus.PENDING).length,
        submitted: typeItems.filter(item => item.status === TransactionQueueStatus.SUBMITTED).length,
        confirmed: typeItems.filter(item => item.status === TransactionQueueStatus.CONFIRMED).length,
        failed: typeItems.filter(item => item.status === TransactionQueueStatus.FAILED).length,
      };
    } catch (error) {
      this.logger.error('Failed to get queue stats', {
        error: error instanceof Error ? error.message : String(error),
        type: this.type,
      });
      throw error;
    }
  }

  async updateTransaction(
    id: string,
    update: Partial<Omit<TransactionQueueItem, 'id' | 'created_at' | 'updated_at'>>,
  ): Promise<void> {
    try {
      await this.db.updateTransactionQueueItem(id, update);
      this.logger.debug('Updated transaction', {
        type: this.type,
        id,
        update,
      });
    } catch (error) {
      this.logger.error('Failed to update transaction', {
        error: error instanceof Error ? error.message : String(error),
        type: this.type,
        id,
      });
      throw error;
    }
  }

  async clearQueue(): Promise<void> {
    try {
      // Get all items regardless of status
      const items = await this.db.getTransactionQueueItemsByStatus(
        TransactionQueueStatus.PENDING,
      );
      const typeItems = items.filter((item) => item.transaction_type === this.type);
      
      await Promise.all(
        typeItems.map((item) => this.db.deleteTransactionQueueItem(item.id)),
      );
      this.logger.info('Cleared queue', { type: this.type });
    } catch (error) {
      this.logger.error('Failed to clear queue', {
        error: error instanceof Error ? error.message : String(error),
        type: this.type,
      });
      throw error;
    }
  }
} 