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
      // Enhanced logging for deposit event processing
      this.logger.info('PROCESSING DEPOSIT EVENT IN EVENT PROCESSOR', {
        depositId: event.depositId,
        delegateeAddress: event.delegateeAddress,
        isDefaultDelegatee: event.delegateeAddress === "0x0000000000000000000000000000000000000b01"
      });

      // Check if deposit already exists
      const existingDeposit = await this.db.getDeposit(event.depositId);

      if (existingDeposit) {
        // Calculate the new total amount (accumulate instead of overwrite)
        const currentAmount = BigInt(existingDeposit.amount);
        const newAmount = currentAmount + BigInt(event.amount.toString());

        // Log details about existing deposit and delegatee
        this.logger.info('UPDATING EXISTING DEPOSIT - DELEGATEE INFO', {
          depositId: event.depositId,
          currentDelegatee: existingDeposit.delegatee_address,
          newDelegatee: event.delegateeAddress,
          delegateeChanged: existingDeposit.delegatee_address !== event.delegateeAddress,
          isDefaultDelegatee: event.delegateeAddress === "0x0000000000000000000000000000000000000b01"
        });

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
        // Log new deposit creation with delegatee info
        this.logger.info('CREATING NEW DEPOSIT - DELEGATEE INFO', {
          depositId: event.depositId,
          delegateeAddress: event.delegateeAddress,
          isDefaultDelegatee: event.delegateeAddress === "0x0000000000000000000000000000000000000b01"
        });

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

      // Log final state after processing
      this.logger.info('DEPOSIT PROCESSING COMPLETED', {
        depositId: event.depositId,
        delegateeAddress: event.delegateeAddress,
        success: true
      });

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
      // Enhanced logging for delegatee alteration processing
      this.logger.info('PROCESSING DELEGATEE ALTERED EVENT', {
        depositId: event.depositId,
        oldDelegatee: event.oldDelegatee,
        newDelegatee: event.newDelegatee,
        isDefaultDelegatee: event.newDelegatee === "0x0000000000000000000000000000000000000b01"
      });

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

      // Log details about deposit before updating delegatee
      this.logger.info('UPDATING DELEGATEE FOR DEPOSIT', {
        depositId: event.depositId,
        owner: deposit.owner_address,
        depositor: deposit.depositor_address,
        currentDelegatee: deposit.delegatee_address,
        newDelegatee: event.newDelegatee,
        isDefaultDelegatee: event.newDelegatee === "0x0000000000000000000000000000000000000b01"
      });

      await this.db.updateDeposit(event.depositId, {
        delegatee_address: event.newDelegatee,
      });

      // Log final state after updating
      this.logger.info('DELEGATEE UPDATE COMPLETED', {
        depositId: event.depositId,
        newDelegatee: event.newDelegatee,
        success: true
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
