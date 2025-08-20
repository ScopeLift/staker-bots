import { ethers } from 'ethers';
import { IDatabase } from '@/database';
import { ConsoleLogger } from '@/monitor/logging';
import { CONFIG } from '@/configuration';
import { REWARD_CALCULATOR_ABI, MAX_SCORE_CACHE_SIZE } from '../constants';
import { ICalculatorStrategy } from '../interfaces/ICalculatorStrategy';
import { IRewardCalculator, ScoreEvent } from '../interfaces/types';
import { GovLstProfitabilityEngineWrapper } from '@/profitability/ProfitabilityEngineWrapper';

// Default hash for empty blocks
const DEFAULT_HASH =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Creates a binary eligibility oracle calculator for calculating earning power
 */
function createBinaryEligibilityOracleCalculator(
  db: IDatabase,
  provider: ethers.Provider,
): ICalculatorStrategy {
  const logger = new ConsoleLogger('info');
  const scoreCache = new Map<string, bigint>();

  let profitabilityEngine: GovLstProfitabilityEngineWrapper | null = null;

  // Initialize contract
  if (!CONFIG.monitor.rewardCalculatorAddress) {
    throw new Error('REWARD_CALCULATOR_ADDRESS is not configured');
  }

  const contract = new ethers.Contract(
    CONFIG.monitor.rewardCalculatorAddress,
    REWARD_CALCULATOR_ABI,
    provider,
  ) as unknown as IRewardCalculator;

  /**
   * Set the profitability engine for score event notifications
   */
  function setProfitabilityEngine(engine: GovLstProfitabilityEngineWrapper): void {
    profitabilityEngine = engine;
    logger.info(
      'Profitability engine registered for score event notifications',
    );
  }

  /**
   * Calculates the earning power for a stake
   */
  async function getEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string,
  ): Promise<bigint> {
    try {
      const earningPower = await contract.getEarningPower(
        amountStaked,
        staker,
        delegatee,
      );
      return BigInt(earningPower.toString());
    } catch (error) {
      logger.error('Error getting earning power from contract:', {
        error,
        staker,
        delegatee,
        amountStaked: amountStaked.toString(),
      });
      throw error;
    }
  }

  /**
   * Calculates the new earning power for a stake
   */
  async function getNewEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string,
    oldEarningPower: bigint,
  ): Promise<[bigint, boolean]> {
    try {
      // First try to get the latest score event from the database for this delegatee
      let latestScoreEvent = null;

      try {
        latestScoreEvent = await db.getLatestScoreEvent(delegatee);
        if (latestScoreEvent) {
          logger.info(
            'Using latest score event from database for getNewEarningPower',
            {
              delegatee,
              score: latestScoreEvent.score,
              blockNumber: latestScoreEvent.block_number,
            },
          );
        } else {
          logger.info(
            'No latest score event found in database for delegatee',
            {
              delegatee,
            },
          );
        }
      } catch (dbError) {
        logger.warn('Error getting latest score event from database', {
          error: dbError,
          delegatee,
        });
      }

      // Call the contract's getNewEarningPower method
      const [newEarningPower, isBumpable] = await contract.getNewEarningPower(
        amountStaked,
        staker,
        delegatee,
        oldEarningPower,
      );

      logger.info('Contract getNewEarningPower results', {
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
          logger.info(
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
      logger.error('Error getting new earning power from contract:', {
        error,
        staker,
        delegatee,
        amountStaked: amountStaked.toString(),
        oldEarningPower: oldEarningPower.toString(),
      });
      throw error;
    }
  }

  /**
   * Processes delegatee score events from the blockchain
   */
  async function processScoreEvents(
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    try {
      logger.info('Querying score events from contract', {
        fromBlock,
        toBlock,
        contractAddress: CONFIG.monitor.rewardCalculatorAddress,
      });

      // Get events from blockchain
      const filter = contract.filters.DelegateeScoreUpdated();

      // Query events for the exact block range
      const events = await contract.queryFilter(filter, fromBlock, toBlock);

      logger.info('Processing score events', {
        eventCount: events.length,
        fromBlock,
        toBlock,
      });

      // Process events in batch
      for (const event of events) {
        const typedEvent = event as ethers.EventLog;
        const { delegatee, newScore } = typedEvent.args;
        await processScoreEvent({
          delegatee,
          score: BigInt(newScore.toString()),
          block_number: typedEvent.blockNumber,
        });
      }

      // Get block hash for checkpoint
      const block = await provider.getBlock(toBlock);
      if (!block) {
        throw new Error(`Block ${toBlock} not found`);
      }

      // Extract the hash safely, defaulting if undefined
      const blockHash =
        typeof block.hash === 'string' ? block.hash : DEFAULT_HASH;

      // Update processing checkpoint
      await db.updateCheckpoint({
        component_type: 'calculator',
        last_block_number: toBlock,
        block_hash: blockHash,
        last_update: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error processing score events:', {
        error,
        fromBlock,
        toBlock,
      });
      throw error;
    }
  }

  /**
   * Processes a single score event
   */
  async function processScoreEvent(event: ScoreEvent): Promise<void> {
    try {
      // Update score cache first (with LRU-like behavior to limit size)
      if (scoreCache.size >= MAX_SCORE_CACHE_SIZE) {
        // Remove random entry to prevent unlimited growth
        const firstKey = scoreCache.keys().next().value;
        scoreCache.delete(firstKey!);
      }

      scoreCache.set(event.delegatee, event.score);

      // Store in database
      await db.createScoreEvent({
        delegatee: event.delegatee,
        score: event.score.toString(), // Convert bigint to string for database
        block_number: event.block_number,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Notify profitability engine about the score event if it's set
      if (profitabilityEngine) {
        try {
          logger.info('Forwarding score event to profitability engine', {
            delegatee: event.delegatee,
            score: event.score.toString(),
            blockNumber: event.block_number,
          });

          await profitabilityEngine.onScoreEvent(event.delegatee, event.score);

          logger.info(
            'Successfully forwarded score event to profitability engine',
            {
              delegatee: event.delegatee,
            },
          );
        } catch (notifyError) {
          logger.error(
            'Error notifying profitability engine of score event:',
            {
              error: notifyError,
              event,
            },
          );
          // Continue processing even if notification fails
        }
      } else {
        logger.warn(
          'No profitability engine set, score event not forwarded',
          {
            delegatee: event.delegatee,
            score: event.score.toString(),
          },
        );
      }
    } catch (error) {
      logger.error('Error processing score event:', {
        error,
        delegatee: event.delegatee,
        score: event.score.toString(),
      });
      throw error;
    }
  }

  return {
    getEarningPower,
    getNewEarningPower,
    processScoreEvents,
    setProfitabilityEngine,
  };
}

export { createBinaryEligibilityOracleCalculator };
