import { RewardAnalysis, ClaimBatch, ClaimResult } from './types';

export interface IGovLstClaimer {
  /**
   * Start the GovLst claimer
   */
  start(): Promise<void>;

  /**
   * Stop the GovLst claimer
   */
  stop(): Promise<void>;

  /**
   * Analyze rewards for a specific GovLst contract
   */
  analyzeRewards(govLstAddress: string): Promise<RewardAnalysis>;

  /**
   * Execute a batch of claims for a specific GovLst contract
   */
  executeClaimBatch(govLstAddress: string, batch: ClaimBatch): Promise<ClaimResult>;

  /**
   * Get the current status of the GovLst claimer
   */
  getStatus(): Promise<{
    isRunning: boolean;
    monitors: Record<string, {
      lastCheck: string;
      depositCount: number;
      pendingClaims: number;
    }>;
  }>;

  /**
   * Process all claimable rewards for all GovLst contracts
   */
  processClaimableRewards(): Promise<void>;
}
