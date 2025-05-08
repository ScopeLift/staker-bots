import { ICalculatorStrategy } from '../interfaces/ICalculatorStrategy';
import { ScoreEvent, IRewardCalculator } from '../interfaces/types';
import { IDatabase } from '@/database';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { ethers } from 'ethers';
import { CONFIG } from '@/configuration';
import { REWARD_CALCULATOR_ABI } from '../constants';
import { IProfitabilityEngine } from '@/profitability/interfaces/IProfitabilityEngine';

export class BinaryEligibilityOracleEarningPowerCalculator
  implements ICalculatorStrategy
{
  private db: IDatabase;
  private logger: Logger;
  private scoreCache: Map<string, bigint>;
  private readonly contract: IRewardCalculator;
  private readonly provider: ethers.Provider;
  private profitabilityEngine: IProfitabilityEngine | null = null;

  constructor(db: IDatabase, provider: ethers.Provider) {
    this.db = db;
    this.provider = provider;
    this.logger = new ConsoleLogger('info');
    this.scoreCache = new Map();

    // Initialize contract
    if (!CONFIG.monitor.rewardCalculatorAddress) {
      throw new Error('REWARD_CALCULATOR_ADDRESS is not configured');
    }
    this.contract = new ethers.Contract(
      CONFIG.monitor.rewardCalculatorAddress,
      REWARD_CALCULATOR_ABI,
      provider,
    ) as unknown as IRewardCalculator;
  }

  /**
   * Set the profitability engine for score event notifications
   */
  setProfitabilityEngine(engine: IProfitabilityEngine): void {
    this.profitabilityEngine = engine;
    this.logger.info(
      'Profitability engine registered for score event notifications',
    );
  }

  async getEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string,
  ): Promise<bigint> {
    try {
      const earningPower = await this.contract.getEarningPower(
        amountStaked,
        staker,
        delegatee,
      );
      return BigInt(earningPower.toString());
    } catch (error) {
      this.logger.error('Error getting earning power from contract:', {
        error,
        staker,
        delegatee,
        amountStaked: amountStaked.toString(),
      });
      throw error;
    }
  }

  async getNewEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string,
    oldEarningPower: bigint,
  ): Promise<[bigint, boolean]> {
    try {
      // First try to get the latest score event from the database for this delegatee
      let latestScoreEvent = null;

      try {
        latestScoreEvent = await this.db.getLatestScoreEvent(delegatee);
        if (latestScoreEvent) {
          this.logger.info(
            'Using latest score event from database for getNewEarningPower',
            {
              delegatee,
              score: latestScoreEvent.score,
              blockNumber: latestScoreEvent.block_number,
            },
          );
        } else {
          this.logger.info(
            'No latest score event found in database for delegatee',
            {
              delegatee,
            },
          );
        }
      } catch (dbError) {
        this.logger.warn('Error getting latest score event from database', {
          error: dbError,
          delegatee,
        });
      }

      // Call the contract's getNewEarningPower method
      const [newEarningPower, isBumpable] =
        await this.contract.getNewEarningPower(
          amountStaked,
          staker,
          delegatee,
          oldEarningPower,
        );

      this.logger.info('Contract getNewEarningPower results', {
        delegatee,
        newEarningPower: newEarningPower.toString(),
        isBumpable,
        oldEarningPower: oldEarningPower.toString(),
        hasLatestScoreEvent: !!latestScoreEvent,
      });

      // If we have a latest score event from the database, use it to make the final decision
      if (latestScoreEvent) {
        // Convert the score from string to bigint
        const latestScore = BigInt(latestScoreEvent.score);

        // A deposit is bumpable if the contract's newEarningPower matches the latest score in the database
        // This means the earning power would be updated to the latest score
        const updatedBumpable = newEarningPower === latestScore;

        if (updatedBumpable !== isBumpable) {
          this.logger.info(
            'Overriding bumpable decision based on latest score event',
            {
              delegatee,
              contractNewEarningPower: newEarningPower.toString(),
              latestScore: latestScore.toString(),
              contractIsBumpable: isBumpable,
              updatedIsBumpable: updatedBumpable,
            },
          );
        }

        return [BigInt(latestScore.toString()), updatedBumpable];
      }

      return [BigInt(newEarningPower.toString()), isBumpable];
    } catch (error) {
      this.logger.error('Error getting new earning power from contract:', {
        error,
        staker,
        delegatee,
        amountStaked: amountStaked.toString(),
        oldEarningPower: oldEarningPower.toString(),
      });
      throw error;
    }
  }

  async processScoreEvents(fromBlock: number, toBlock: number): Promise<void> {
    try {
      const contractAddress = (this.contract as unknown as { address: string })
        .address;

      this.logger.info('Querying score events from contract', {
        fromBlock,
        toBlock,
        contractAddress,
      });

      // Get events from blockchain
      const filter = this.contract.filters.DelegateeScoreUpdated();

      this.logger.info('Event filter details:', {
        address: contractAddress,
        topics: filter.topics,
        fromBlock,
        toBlock,
      });

      // Query events for the exact block range
      const events = await this.contract.queryFilter(
        filter,
        fromBlock,
        toBlock,
      );

      this.logger.info('Processing score events', {
        eventCount: events.length,
        fromBlock,
        toBlock,
        contractAddress,
        hasProfitabilityEngine: this.profitabilityEngine !== null,
      });

      // Process events in batch
      for (const event of events) {
        const typedEvent = event as ethers.EventLog;
        const { delegatee, newScore } = typedEvent.args;
        await this.processScoreEvent({
          delegatee,
          score: BigInt(newScore.toString()),
          block_number: typedEvent.blockNumber,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }

      // Get block hash for checkpoint
      const block = await this.provider.getBlock(toBlock);
      if (!block) {
        throw new Error(`Block ${toBlock} not found`);
      }

      // Update processing checkpoint
      await this.db.updateCheckpoint({
        component_type: 'calculator',
        last_block_number: toBlock,
        block_hash:
          block.hash ??
          '0x0000000000000000000000000000000000000000000000000000000000000000',
        last_update: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error processing score events:', {
        error,
        fromBlock,
        toBlock,
        contractAddress: (this.contract as unknown as { address: string })
          .address,
      });
      throw error;
    }
  }

  private async processScoreEvent(event: ScoreEvent): Promise<void> {
    try {
      // Update score cache first
      this.scoreCache.set(event.delegatee, event.score);

      // Store in database
      await this.db.createScoreEvent({
        ...event,
        score: event.score.toString(), // Convert bigint to string for database
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Notify profitability engine about the score event if it's set
      if (this.profitabilityEngine) {
        try {
          this.logger.info('Forwarding score event to profitability engine', {
            delegatee: event.delegatee,
            score: event.score.toString(),
            blockNumber: event.block_number,
          });

          await this.profitabilityEngine.onScoreEvent(
            event.delegatee,
            event.score,
          );

          this.logger.info(
            'Successfully forwarded score event to profitability engine',
            {
              delegatee: event.delegatee,
            },
          );
        } catch (error) {
          this.logger.error(
            'Error notifying profitability engine of score event:',
            {
              error,
              event,
            },
          );
          // Continue processing even if notification fails
        }
      } else {
        this.logger.warn(
          'No profitability engine set, score event not forwarded',
          {
            delegatee: event.delegatee,
            score: event.score.toString(),
          },
        );
      }

      this.logger.debug('Score event processed', {
        delegatee: event.delegatee,
        score: event.score.toString(),
        blockNumber: event.block_number,
      });
    } catch (error) {
      this.logger.error('Error processing score event:', {
        error,
        event,
      });
      throw error;
    }
  }
}
