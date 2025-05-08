import { ethers } from "ethers";
import { IDatabase } from "@/database";
import { ConsoleLogger } from "@/monitor/logging";
import { CONFIG } from "@/configuration/constants";
import { REWARD_CALCULATOR_ABI, MAX_SCORE_CACHE_SIZE } from "../constants";
import { ICalculatorStrategy } from "../interfaces/ICalculatorStrategy";
import { IRewardCalculator, ScoreEvent } from "../interfaces/types";
import { ProfitabilityEngineWrapper } from "@/profitability/ProfitabilityEngineWrapper";

// Default hash for empty blocks
const DEFAULT_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Creates a binary eligibility oracle calculator for calculating earning power
 */
function createBinaryEligibilityOracleCalculator(
  db: IDatabase,
  provider: ethers.Provider,
): ICalculatorStrategy {
  const logger = new ConsoleLogger("info");
  const scoreCache = new Map<string, bigint>();
  const profitabilityEngine: ProfitabilityEngineWrapper | null = null;

  // Initialize contract
  if (!CONFIG.monitor.rewardCalculatorAddress) {
    throw new Error("REWARD_CALCULATOR_ADDRESS is not configured");
  }

  const contract = new ethers.Contract(
    CONFIG.monitor.rewardCalculatorAddress,
    REWARD_CALCULATOR_ABI,
    provider,
  ) as unknown as IRewardCalculator;

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
      logger.error("Error getting earning power from contract:", {
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
      const [newEarningPower, isBumpable] = await contract.getNewEarningPower(
        amountStaked,
        staker,
        delegatee,
        oldEarningPower,
      );
      return [BigInt(newEarningPower.toString()), isBumpable];
    } catch (error) {
      logger.error("Error getting new earning power from contract:", {
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
      logger.info("Querying score events from contract", {
        fromBlock,
        toBlock,
        contractAddress: CONFIG.monitor.rewardCalculatorAddress,
      });

      // Get events from blockchain
      const filter = contract.filters.DelegateeScoreUpdated();

      // Query events for the exact block range
      const events = await contract.queryFilter(filter, fromBlock, toBlock);

      logger.info("Processing score events", {
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
        typeof block.hash === "string" ? block.hash : DEFAULT_HASH;

      // Update processing checkpoint
      await db.updateCheckpoint({
        component_type: "calculator",
        last_block_number: toBlock,
        block_hash: blockHash,
        last_update: new Date().toISOString(),
      });

      logger.info("Score events processed successfully", {
        processedEvents: events.length,
        fromBlock,
        toBlock,
        blockHash,
      });
    } catch (error) {
      logger.error("Error processing score events:", {
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
      });

      if (profitabilityEngine) {
        try {
          await profitabilityEngine.onScoreEvent(event.delegatee, event.score);
        } catch (notifyError) {
          logger.error("Error notifying profitability engine:", {
            error: notifyError,
            delegatee: event.delegatee,
            score: event.score.toString(),
          });
        }
      }
    } catch (error) {
      logger.error("Error processing score event:", {
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
  };
}

export { createBinaryEligibilityOracleCalculator };
