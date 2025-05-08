import { BatchAnalysis, Deposit, ProfitabilityCheck } from "./types";

export interface ProfitabilityEngineConfig {
  gasPriceBuffer: number;
  minProfitMargin: bigint;
  maxBatchSize: number;
}

export interface IProfitabilityEngine {
  config: ProfitabilityEngineConfig;

  /**
   * Check if a single deposit can be profitably bumped
   * @param deposit The deposit to check
   * @returns Profitability analysis for the deposit
   */
  checkProfitability(deposit: Deposit): Promise<ProfitabilityCheck>;

  /**
   * Analyze a batch of deposits for optimal profitability
   * @param deposits Array of deposits to analyze
   * @returns Batch profitability analysis with recommendations
   */
  analyzeBatchProfitability(deposits: Deposit[]): Promise<BatchAnalysis>;

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
   * @returns Object containing engine status information
   */
  getStatus(): Promise<{
    isRunning: boolean;
    lastGasPrice: bigint;
    lastUpdateTimestamp: number;
    queueSize: number;
    delegateeCount: number;
  }>;

  /**
   * Get statistics about the processing queue
   * @returns Object containing queue statistics
   */
  getQueueStats(): Promise<{
    pendingCount: number;
    processingCount: number;
    completedCount: number;
    failedCount: number;
  }>;
}
