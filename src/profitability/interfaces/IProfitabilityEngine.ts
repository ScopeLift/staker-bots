import {
  GovLstDeposit,
  GovLstProfitabilityCheck,
  GovLstBatchAnalysis,
} from './types';

export interface IGovLstProfitabilityEngine {
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
}
