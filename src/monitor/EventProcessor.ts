import { IDatabase } from '@/database';
import {
  ProcessingResult,
  StakeDepositedEvent,
  StakeWithdrawnEvent,
  DelegateeAlteredEvent,
  DepositUpdatedEvent,
} from './types';
import { Logger } from './logging';
import { EVENT_TYPES } from './constants';
import { EventProcessingError, DepositNotFoundError } from './errors';

/**
 * Processes blockchain events related to staking operations.
 * Handles deposit creation/updates, withdrawals, and delegatee changes.
 */
export class EventProcessor {
  constructor(
    private readonly db: IDatabase,
    private readonly logger: Logger,
  ) {}

  /**
   * Processes a StakeDeposited event by creating or updating a deposit record
   */
  async processStakeDeposited(
    event: StakeDepositedEvent,
  ): Promise<ProcessingResult> {
    try {
      const existingDeposit = await this.db.getDeposit(event.depositId);
      const newAmount = existingDeposit
        ? BigInt(existingDeposit.amount) + BigInt(event.amount.toString())
        : BigInt(event.amount.toString());

      const depositData = {
        owner_address: event.ownerAddress,
        depositor_address: event.depositorAddress,
        delegatee_address: event.delegateeAddress,
        amount: newAmount.toString(),
      };

      if (existingDeposit) {
        await this.db.updateDeposit(event.depositId, depositData);
        this.logger.info('Updated existing deposit', {
          depositId: event.depositId,
          newAmount: newAmount.toString(),
        });
      } else {
        await this.db.createDeposit({
          deposit_id: event.depositId,
          ...depositData,
        });
        this.logger.info('Created new deposit', {
          depositId: event.depositId,
          amount: newAmount.toString(),
        });
      }

      return this.createSuccessResult(event);
    } catch (error) {
      throw new EventProcessingError(
        EVENT_TYPES.STAKE_DEPOSITED,
        error as Error,
        {
          depositId: event.depositId,
          amount: event.amount.toString(),
        },
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

      const remainingAmount = BigInt(deposit.amount) - event.withdrawnAmount;
      const depositData =
        remainingAmount <= 0
          ? { amount: '0', delegatee_address: deposit.owner_address }
          : { amount: remainingAmount.toString() };

      await this.db.updateDeposit(event.depositId, depositData);

      this.logger.info('Processed withdrawal', {
        depositId: event.depositId,
        remainingAmount: depositData.amount,
      });

      return this.createSuccessResult(event);
    } catch (error) {
      throw new EventProcessingError(
        EVENT_TYPES.STAKE_WITHDRAWN,
        error as Error,
        {
          depositId: event.depositId,
          withdrawnAmount: event.withdrawnAmount.toString(),
        },
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
      throw new EventProcessingError(
        EVENT_TYPES.DELEGATEE_ALTERED,
        error as Error,
        {
          depositId: event.depositId,
          oldDelegatee: event.oldDelegatee,
          newDelegatee: event.newDelegatee,
        },
      );
    }
  }

  /**
   * Processes a DepositUpdated event by updating the deposit mapping
   * This event is emitted when a user updates their stake deposit
   */
  async processDepositUpdated(
    event: DepositUpdatedEvent,
  ): Promise<ProcessingResult> {
    try {
      // Get the old deposit to copy over relevant data
      const oldDeposit = await this.db.getDeposit(
        event.oldDepositId.toString(),
      );
      if (!oldDeposit) {
        this.logger.warn(
          'Old deposit not found when processing DepositUpdated',
          {
            holder: event.holder,
            oldDepositId: event.oldDepositId.toString(),
            newDepositId: event.newDepositId.toString(),
          },
        );
      }

      // Create or update the new deposit with data from the old one
      const depositData = {
        owner_address: event.holder,
        depositor_address: event.holder,
        delegatee_address: oldDeposit?.delegatee_address || event.holder,
        amount: oldDeposit?.amount || '0',
      };

      await this.db.createDeposit({
        deposit_id: event.newDepositId.toString(),
        ...depositData,
      });

      // If old deposit exists, mark it as moved
      if (oldDeposit) {
        await this.db.updateDeposit(event.oldDepositId.toString(), {
          amount: '0',
          delegatee_address: event.holder,
        });
      }

      this.logger.info('Processed deposit update', {
        holder: event.holder,
        oldDepositId: event.oldDepositId.toString(),
        newDepositId: event.newDepositId.toString(),
      });

      return this.createSuccessResult(event);
    } catch (error) {
      throw new EventProcessingError(
        EVENT_TYPES.DEPOSIT_UPDATED,
        error as Error,
        {
          holder: event.holder,
          oldDepositId: event.oldDepositId.toString(),
          newDepositId: event.newDepositId.toString(),
        },
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
