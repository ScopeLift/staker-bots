import { ethers } from 'ethers';
import { IDatabase } from '@/database';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { ExecutorWrapper } from '@/executor';
import { IGovLstClaimer } from './interfaces/IGovLstClaimer';
import { ClaimBatch, ClaimResult, GovLstClaimerConfig, RewardAnalysis } from './interfaces/types';
import { BaseGovLstClaimer } from './strategies/BaseGovLstClaimer';
import { CONFIG } from '@/config';
import { DEFAULT_GOVLST_CLAIMER_CONFIG } from './constants';

export class GovLstClaimerWrapper implements IGovLstClaimer {
  private strategy: IGovLstClaimer;
  private logger: Logger;

  constructor(
    db: IDatabase,
    provider: ethers.Provider,
    executor: ExecutorWrapper,
    config: GovLstClaimerConfig = CONFIG.govlst
  ) {
    this.logger = new ConsoleLogger('info');

    // Merge default config with provided config
    const fullConfig: GovLstClaimerConfig = {
      ...DEFAULT_GOVLST_CLAIMER_CONFIG,
      ...config,
    };

    // Create the strategy
    this.strategy = new BaseGovLstClaimer(db, provider, executor, fullConfig);

    this.logger.info('GovLst Claimer initialized', {
      addresses: fullConfig.addresses,
      payoutAmount: fullConfig.payoutAmount.toString(),
      minProfitMargin: fullConfig.minProfitMargin.toString(),
      maxBatchSize: fullConfig.maxBatchSize,
      claimInterval: fullConfig.claimInterval,
    });
  }

  async start(): Promise<void> {
    return this.strategy.start();
  }

  async stop(): Promise<void> {
    return this.strategy.stop();
  }

  async analyzeRewards(govLstAddress: string): Promise<RewardAnalysis> {
    return this.strategy.analyzeRewards(govLstAddress);
  }

  async executeClaimBatch(govLstAddress: string, batch: ClaimBatch): Promise<ClaimResult> {
    return this.strategy.executeClaimBatch(govLstAddress, batch);
  }

  async getStatus(): Promise<{
    isRunning: boolean;
    monitors: Record<string, {
      lastCheck: string;
      depositCount: number;
      pendingClaims: number;
    }>;
  }> {
    return this.strategy.getStatus();
  }

  async processClaimableRewards(): Promise<void> {
    return this.strategy.processClaimableRewards();
  }
}
