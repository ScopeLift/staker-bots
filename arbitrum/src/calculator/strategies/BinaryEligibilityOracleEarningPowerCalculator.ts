import { ICalculatorStrategy } from '../interfaces/ICalculatorStrategy';
import { ScoreEvent, IRewardCalculator } from '../interfaces/types';
import { IDatabase } from '@/database';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { ethers } from 'ethers';
import { CONFIG } from '@/config';
import { REWARD_CALCULATOR_ABI } from '../constants';
import { ProfitabilityEngineWrapper } from '@/profitability/ProfitabilityEngineWrapper';

export class BinaryEligibilityOracleEarningPowerCalculator
  implements ICalculatorStrategy
{
  private db: IDatabase;
  private logger: Logger;
  private scoreCache: Map<string, bigint>;
  private readonly contract: IRewardCalculator;
  private readonly provider: ethers.Provider;
  private lastProcessedBlock: number;
  private profitabilityEngine: ProfitabilityEngineWrapper | null = null;

  constructor(db: IDatabase, provider: ethers.Provider) {
    this.db = db;
    this.provider = provider;
    this.logger = new ConsoleLogger('info');
    this.scoreCache = new Map();
    this.lastProcessedBlock = 0;

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
  setProfitabilityEngine(engine: ProfitabilityEngineWrapper): void {
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
      const [newEarningPower, isBumpable] =
        await this.contract.getNewEarningPower(
          amountStaked,
          staker,
          delegatee,
          oldEarningPower,
        );
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
      this.logger.info('Querying score events from contract', {
        fromBlock,
        toBlock,
        contractAddress: CONFIG.monitor.rewardCalculatorAddress,
      });

      // Get events from blockchain
      const filter = this.contract.filters.DelegateeScoreUpdated();

      this.logger.info('Event filter details:', {
        address: CONFIG.monitor.rewardCalculatorAddress,
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

      this.logger.info('Raw events from contract:', {
        eventCount: events.length,
        events: events.map((e) => ({
          address: e.address?.toLowerCase(),
          topics: e.topics,
          data: e.data,
          blockNumber: e.blockNumber,
        })),
      });

      this.logger.info('Processing score events', {
        eventCount: events.length,
        fromBlock,
        toBlock,
        contractAddress: CONFIG.monitor.rewardCalculatorAddress,
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

      this.lastProcessedBlock = toBlock;
      this.logger.info('Score events processed successfully', {
        processedEvents: events.length,
        fromBlock,
        toBlock,
        blockHash: block.hash,
      });
    } catch (error) {
      this.logger.error('Error processing score events:', {
        error,
        fromBlock,
        toBlock,
        contractAddress: CONFIG.monitor.rewardCalculatorAddress,
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

  private async getDelegateeScore(delegatee: string): Promise<bigint> {
    const cachedScore = this.scoreCache.get(delegatee);
    if (cachedScore) return cachedScore;

    const latestEvent = await this.getLatestScoreEvent(delegatee);
    if (!latestEvent?.score) return BigInt(0);

    const score = BigInt(latestEvent.score);
    this.scoreCache.set(delegatee, score);
    return score;
  }

  private async getLatestScoreEvent(
    delegatee: string,
  ): Promise<ScoreEvent | null> {
    const dbEvent = await this.db.getLatestScoreEvent(delegatee);
    return dbEvent ? { ...dbEvent, score: BigInt(dbEvent.score) } : null;
  }

  private async getScoreEvents(
    fromBlock: number,
    toBlock: number,
  ): Promise<ScoreEvent[]> {
    const dbEvents = await this.db.getScoreEventsByBlockRange(
      fromBlock,
      toBlock,
    );
    return dbEvents.map((e) => ({ ...e, score: BigInt(e.score) }));
  }
}
