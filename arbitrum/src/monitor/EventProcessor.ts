import { IDatabase } from "@/database";
import {
  ProcessingResult,
  StakeDepositedEvent,
  StakeWithdrawnEvent,
  DelegateeAlteredEvent,
  EarningPowerBumpedEvent,
} from "./types";
import { Logger } from "./logging";
import { EVENT_TYPES } from "./constants";
import { EventProcessingError, DepositNotFoundError } from "./errors";
import { ErrorLogger } from "@/configuration/errorLogger";

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

      this.logger.info("Created new deposit", {
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
          context: "process-stake-deposited",
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
          ? { amount: "0", delegatee_address: deposit.owner_address }
          : { amount: remainingAmount.toString() };

      await this.db.updateDeposit(event.depositId, depositData);

      this.logger.info("Processed withdrawal", {
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
          context: "process-stake-withdrawn",
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

      this.logger.info("Updated delegatee", {
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
          context: "process-delegatee-altered",
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
   * Processes an EarningPowerBumped event by updating the score event for the delegatee
   */
  async processEarningPowerBumped(
    event: EarningPowerBumpedEvent,
  ): Promise<ProcessingResult> {
    this.logger.info("Processing EarningPowerBumped event", {
      depositId: event.depositId,
      oldEarningPower: event.oldEarningPower.toString(),
      newEarningPower: event.newEarningPower.toString(),
      blockNumber: event.blockNumber,
    });

    try {
      const deposit = await this.db.getDeposit(event.depositId);
      if (!deposit) {
        const error = new DepositNotFoundError(event.depositId);
        this.logger.error("Deposit not found for EarningPowerBumped event", {
          depositId: event.depositId,
          error: error.message,
        });
        throw error;
      }

      // Update or create a score event for the delegatee
      const delegatee = deposit.delegatee_address || deposit.owner_address;
      const newScore = event.newEarningPower.toString();

      this.logger.info(
        "Updating score for delegatee from EarningPowerBumped event",
        {
          depositId: event.depositId,
          delegatee,
          isOwnerDelegatee: delegatee === deposit.owner_address,
          oldEarningPower: event.oldEarningPower.toString(),
          newEarningPower: newScore,
          blockNumber: event.blockNumber,
        },
      );

      // Check if a score event already exists for this block
      const existingEvent = await this.db.getScoreEvent(
        delegatee,
        event.blockNumber,
      );

      if (existingEvent) {
        this.logger.info("Updating existing score event", {
          delegatee,
          blockNumber: event.blockNumber,
          oldScore: existingEvent.score,
          newScore,
          scoreDifference: (
            BigInt(newScore) - BigInt(existingEvent.score)
          ).toString(),
        });

        // Update the existing score event with the earning power from this event
        await this.db.updateScoreEvent(delegatee, event.blockNumber, {
          score: newScore,
          updated_at: new Date().toISOString(),
        });
      } else {
        this.logger.info("Creating new score event from earning power", {
          delegatee,
          blockNumber: event.blockNumber,
          score: newScore,
        });

        // Create a new score event with the earning power from this event
        await this.db.createScoreEvent({
          delegatee,
          score: newScore,
          block_number: event.blockNumber,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }

      // Try to get the latest score event after update to verify
      const latestScoreEvent = await this.db.getLatestScoreEvent(delegatee);

      this.logger.info(
        "Latest score event after update from EarningPowerBumped",
        {
          depositId: event.depositId,
          delegatee,
          latestScoreEvent: latestScoreEvent
            ? {
                blockNumber: latestScoreEvent.block_number,
                score: latestScoreEvent.score,
                created_at: latestScoreEvent.created_at,
                updated_at: latestScoreEvent.updated_at,
              }
            : "No score event found",
        },
      );

      this.logger.info("Successfully processed earning power for delegatee", {
        depositId: event.depositId,
        delegatee,
        oldEarningPower: event.oldEarningPower.toString(),
        newEarningPower: newScore,
        bumper: event.bumper,
      });

      return this.createSuccessResult(event);
    } catch (error) {
      this.logger.error("Failed to process EarningPowerBumped event", {
        error,
        depositId: event.depositId,
        oldEarningPower: event.oldEarningPower.toString(),
        newEarningPower: event.newEarningPower.toString(),
      });

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: "process-earning-power-bumped",
          depositId: event.depositId,
        });
      }

      throw new EventProcessingError(
        EVENT_TYPES.EARNING_POWER_BUMPED,
        error as Error,
        {
          depositId: event.depositId,
          oldEarningPower: event.oldEarningPower.toString(),
          newEarningPower: event.newEarningPower.toString(),
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
