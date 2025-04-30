import { IDatabase } from '@/database';
import {
  ProcessingResult,
  StakeDepositedEvent,
  StakeWithdrawnEvent,
  DelegateeAlteredEvent,
} from './types';
import { Logger } from './logging';
import { EVENT_TYPES } from './constants';
import {
  EventProcessingError,
  DepositNotFoundError,
} from './errors';
import { ErrorLogger } from '@/configuration/errorLogger';

/**
 * Processes blockchain events related to staking operations.
 * Handles deposit creation/updates, withdrawals, and delegatee changes.
 */
export class EventProcessor {
  constructor(
    private readonly db: IDatabase,
    private readonly logger: Logger,
    private readonly errorLogger?: ErrorLogger,
  ) {}

  /**
   * Processes a StakeDeposited event by creating a new deposit record
   */
  async processStakeDeposited(
    event: StakeDepositedEvent,
  ): Promise<ProcessingResult> {
    try {
      // Create new deposit directly, no need to check if it exists
      await this.db.createDeposit({
        deposit_id: event.depositId,
        owner_address: event.ownerAddress,
        delegatee_address: event.delegateeAddress,
        amount: event.amount.toString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      this.logger.info('Created new deposit', {
        depositId: event.depositId,
        owner: event.ownerAddress,
        amount: event.amount.toString(),
      });

      return this.createSuccessResult(event);
    } catch (error) {
      const context = {
        depositId: event.depositId,
        amount: event.amount.toString(),
      };

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'process-stake-deposited',
          ...context,
        });
      }

      throw new EventProcessingError(
        EVENT_TYPES.STAKE_DEPOSITED,
        error as Error,
        context,
      );
    }
  }

  /**
   * Processes a StakeWithdrawn event by updating the deposit amount
   */
  async processStakeWithdrawn(
    event: StakeWithdrawnEvent,
  ): Promise<ProcessingResult> {
    try {
      const deposit = await this.db.getDeposit(event.depositId);
      if (!deposit) throw new DepositNotFoundError(event.depositId);

      const withdrawnAmount = BigInt(event.withdrawnAmount.toString());
      const remainingAmount = BigInt(deposit.amount) - withdrawnAmount;
      const depositData =
        remainingAmount <= 0n
          ? { amount: '0', delegatee_address: deposit.owner_address }
          : { amount: remainingAmount.toString() };

      await this.db.updateDeposit(event.depositId, depositData);

      this.logger.info('Processed withdrawal', {
        depositId: event.depositId,
        remainingAmount: depositData.amount,
      });

      return this.createSuccessResult(event);
    } catch (error) {
      const context = {
        depositId: event.depositId,
        withdrawnAmount: event.withdrawnAmount.toString(),
      };

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'process-stake-withdrawn',
          ...context,
        });
      }

      throw new EventProcessingError(
        EVENT_TYPES.STAKE_WITHDRAWN,
        error as Error,
        context,
      );
    }
  }

  /**
   * Processes a DelegateeAltered event by updating the deposit's delegatee
   */
  async processDelegateeAltered(
    event: DelegateeAlteredEvent,
  ): Promise<ProcessingResult> {
    try {
      const deposit = await this.db.getDeposit(event.depositId);
      if (!deposit) throw new DepositNotFoundError(event.depositId);

      await this.db.updateDeposit(event.depositId, {
        delegatee_address: event.newDelegatee,
      });

      this.logger.info('Updated delegatee', {
        depositId: event.depositId,
        newDelegatee: event.newDelegatee,
      });

      return this.createSuccessResult(event);
    } catch (error) {
      const context = {
        depositId: event.depositId,
        oldDelegatee: event.oldDelegatee,
        newDelegatee: event.newDelegatee,
      };

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'process-delegatee-altered',
          ...context,
        });
      }

      throw new EventProcessingError(
        EVENT_TYPES.DELEGATEE_ALTERED,
        error as Error,
        context,
      );
    }
  }

  /**
   * Creates a success result object for event processing
   */
  private createSuccessResult(event: {
    blockNumber: number;
    transactionHash: string;
  }): ProcessingResult {
    return {
      success: true,
      blockNumber: event.blockNumber,
      eventHash: event.transactionHash,
      retryable: false,
    };
  }
}
