import { IDatabase } from '@/database';
import {
  ProcessingResult,
  StakeDepositedEvent,
  StakeWithdrawnEvent,
  DelegateeAlteredEvent,
} from './types';
import { Logger } from './logging';

export class EventProcessor {
  constructor(
    private readonly db: IDatabase,
    private readonly logger: Logger,
  ) {}

  async processStakeDeposited(
    event: StakeDepositedEvent,
  ): Promise<ProcessingResult> {
    try {
      // Check if deposit already exists
      const existingDeposit = await this.db.getDeposit(event.depositId);

      if (existingDeposit) {
        // Calculate the new total amount (accumulate instead of overwrite)
        const currentAmount = BigInt(existingDeposit.amount);
        const newAmount = currentAmount + BigInt(event.amount.toString());

        this.logger.info('Updating existing deposit (accumulating amount)', {
          depositId: event.depositId,
          owner: event.ownerAddress,
          depositor: event.depositorAddress,
          originalAmount: existingDeposit.amount,
          depositAmount: event.amount.toString(),
          newTotalAmount: newAmount.toString(),
          blockNumber: event.blockNumber,
        });

        await this.db.updateDeposit(event.depositId, {
          owner_address: event.ownerAddress,
          depositor_address: event.depositorAddress,
          delegatee_address: event.delegateeAddress,
          amount: newAmount.toString(),
        });
      } else {
        // Create new deposit
        await this.db.createDeposit({
          deposit_id: event.depositId,
          owner_address: event.ownerAddress,
          depositor_address: event.depositorAddress,
          delegatee_address: event.delegateeAddress,
          amount: event.amount.toString(),
        });

        this.logger.info('Created new deposit', {
          depositId: event.depositId,
          owner: event.ownerAddress,
          depositor: event.depositorAddress,
          amount: event.amount.toString(),
        });
      }

      return {
        success: true,
        blockNumber: event.blockNumber,
        eventHash: event.transactionHash,
        retryable: false,
      };
    } catch (error) {
      this.logger.error('Failed to process StakeDeposited event', {
        error,
        event,
      });

      return {
        success: false,
        error: error as Error,
        blockNumber: event.blockNumber,
        eventHash: event.transactionHash,
        retryable: true,
      };
    }
  }

  async processStakeWithdrawn(
    event: StakeWithdrawnEvent,
  ): Promise<ProcessingResult> {
    try {
      const deposit = await this.db.getDeposit(event.depositId);
      if (!deposit) {
        throw new Error(`Deposit ${event.depositId} not found`);
      }

      const remainingAmount = BigInt(deposit.amount) - event.withdrawnAmount;

      if (remainingAmount <= 0) {
        // Instead of deleting, reset values and set delegatee to owner
        await this.db.updateDeposit(event.depositId, {
          amount: '0',
          delegatee_address: deposit.owner_address,
        });
      } else {
        await this.db.updateDeposit(event.depositId, {
          amount: remainingAmount.toString(),
        });
      }

      return {
        success: true,
        blockNumber: event.blockNumber,
        eventHash: event.transactionHash,
        retryable: false,
      };
    } catch (error) {
      this.logger.error('Failed to process StakeWithdrawn event', {
        error,
        event,
      });

      return {
        success: false,
        error: error as Error,
        blockNumber: event.blockNumber,
        eventHash: event.transactionHash,
        retryable: true,
      };
    }
  }

  async processDelegateeAltered(
    event: DelegateeAlteredEvent,
  ): Promise<ProcessingResult> {
    try {
      // Check if deposit exists first
      const deposit = await this.db.getDeposit(event.depositId);
      if (!deposit) {
        this.logger.warn(
          'Received DelegateeAltered event for non-existent deposit',
          {
            depositId: event.depositId,
            oldDelegatee: event.oldDelegatee,
            newDelegatee: event.newDelegatee,
            blockNumber: event.blockNumber,
          },
        );
        return {
          success: false,
          error: new Error(`Deposit ${event.depositId} not found`),
          blockNumber: event.blockNumber,
          eventHash: event.transactionHash,
          retryable: false, // Don't retry since deposit doesn't exist
        };
      }

      await this.db.updateDeposit(event.depositId, {
        delegatee_address: event.newDelegatee,
      });

      return {
        success: true,
        blockNumber: event.blockNumber,
        eventHash: event.transactionHash,
        retryable: false,
      };
    } catch (error) {
      this.logger.error('Failed to process DelegateeAltered event', {
        error,
        event,
      });

      return {
        success: false,
        error: error as Error,
        blockNumber: event.blockNumber,
        eventHash: event.transactionHash,
        retryable: true,
      };
    }
  }
}
