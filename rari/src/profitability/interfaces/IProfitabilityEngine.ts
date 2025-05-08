import {
  GovLstDeposit,
  GovLstProfitabilityCheck,
  GovLstBatchAnalysis,
} from './types';
import { Deposit, ProcessingQueueItem } from '../../database/interfaces/types'
import { ProfitabilityQueueBatchResult, ProfitabilityQueueResult } from './types'

export interface ProfitabilityEngineConfig {
  gasPriceBuffer: number;
  minProfitMargin: number;
}

export interface IGovLstProfitabilityEngine {
  config: ProfitabilityEngineConfig;
  /**
   * Start the profitability engine
   */
  start(): Promise<void>;

  /**
   * Stop the profitability engine
   */
  stop(): Promise<void>;

  /**
   * Get the current status of the profitability engine
   */
  getStatus(): Promise<{
    isRunning: boolean;
    lastGasPrice: bigint;
    lastUpdateTimestamp: number;
    queueSize: number;
    groupCount: number;
  }>;

  /**
   * Check if a group of deposits can be profitably claimed
   * @param deposits Array of deposits to check
   * @returns Profitability analysis for the deposit group
   */
  checkGroupProfitability(
    deposits: GovLstDeposit[],
  ): Promise<GovLstProfitabilityCheck>;

  /**
   * Analyze all deposits and group them into profitable batches
   * @param deposits Array of all deposits to analyze
   * @returns Analysis of deposit groups with profitability metrics
   */
  analyzeAndGroupDeposits(
    deposits: GovLstDeposit[],
  ): Promise<GovLstBatchAnalysis>;

  /**
   * Handle score event updates for a delegatee
   * @param delegatee The delegatee address
   * @param score The new score value
   */
  onScoreEvent(delegatee: string, score: bigint): Promise<void>;
}

export interface IProfitabilityEngine {
  /**
   * Process a single item from the processing queue
   */
  processItem({ item }: { item: ProcessingQueueItem }): Promise<ProfitabilityQueueResult>

  /**
   * Process a batch of deposits for profitability analysis
   */
  processDepositsBatch({
    deposits,
  }: {
    deposits: Deposit[]
  }): Promise<ProfitabilityQueueBatchResult>

  /**
   * Handle score event updates for a delegatee
   * @param delegatee The delegatee address
   * @param score The new score value
   */
  onScoreEvent(delegatee: string, score: bigint): Promise<void>
}
