import { ethers } from 'ethers';
import { Logger } from '@/monitor/logging';
import { SimplifiedLogger } from './SimplifiedLogger';

export interface RewardTrackerConfig {
  /** Expected rewards per accumulation period (in wei) */
  expectedRewardsPerPeriod: bigint;
  /** Accumulation period in hours */
  accumulationPeriodHours: number;
  /** Minimum ratio of rewards to payout amount to proceed (0.0 - 1.0) */
  minimumProfitableRatio: number;
  /** How often to sample reward levels (in minutes) */
  sampleIntervalMinutes: number;
  /** Maximum number of samples to keep for rate calculation */
  maxSamples: number;
  /** Default pause duration when no data available (in hours) */
  defaultPauseDurationHours: number;
  /** Buffer factor for calculated pause time (0.5 = 50% of calculated time) */
  pauseBufferFactor: number;
  /** Maximum pause duration in hours */
  maxPauseDurationHours: number;
  /** Minimum pause duration in hours */
  minPauseDurationHours: number;
  /** High profit threshold ratio to skip pausing */
  highProfitThreshold: number;
  /** Hours after successful transaction before auto-pause is allowed */
  cooldownHoursAfterSuccess: number;
}

/**
 * Tracks reward accumulation patterns and determines when to pause operations
 * to avoid wasting CUs when rewards are insufficient
 */
export class RewardAccumulationTracker {
  private readonly logger: Logger;
  private readonly simpleLogger: SimplifiedLogger;
  private readonly config: RewardTrackerConfig;
  
  // Reward accumulation tracking
  private lastSuccessfulTransaction: number = 0;
  private rewardAccumulationRate: number = 0; // Rewards per hour
  private totalRewardsSample: Array<{ timestamp: number; totalRewards: bigint }> = [];
  private pauseUntil: number = 0;
  
  constructor(logger: Logger, config: RewardTrackerConfig) {
    this.logger = logger;
    this.simpleLogger = new SimplifiedLogger(logger, 'RewardTracker');
    this.config = config;
  }
  
  /**
   * Check if operations should be paused based on reward accumulation
   */
  shouldPauseOperations(): boolean {
    const now = Date.now();
    
    if (now < this.pauseUntil) {
      const minutesRemaining = Math.ceil((this.pauseUntil - now) / 1000 / 60);
      this.simpleLogger.debug(`Operations paused for ${minutesRemaining} more minutes`);
      return true;
    }
    
    return false;
  }
  
  /**
   * Record a successful transaction and reset accumulation tracking
   */
  recordSuccessfulTransaction(totalRewards: bigint, payoutAmount: bigint): void {
    const now = Date.now();
    this.lastSuccessfulTransaction = now;
    
    this.simpleLogger.critical(`💰 Transaction executed: ${ethers.formatEther(totalRewards)} ETH rewards, ${ethers.formatEther(payoutAmount)} ETH payout`);
    
    // Don't pause if we just started or if this was a large transaction
    const rewardRatio = Number(totalRewards) / Number(payoutAmount);
    if (rewardRatio > this.config.highProfitThreshold) {
      this.simpleLogger.critical(`🚀 High-profit transaction completed, continuing operations`);
      return;
    }
    
    // Calculate pause duration based on reward accumulation rate
    this.calculateOptimalPauseDuration(payoutAmount);
  }
  
  /**
   * Track reward levels to understand accumulation patterns
   */
  trackRewardLevels(totalRewards: bigint, payoutAmount: bigint): void {
    const now = Date.now();
    
    // Add sample for tracking accumulation
    this.totalRewardsSample.push({ timestamp: now, totalRewards });
    
    // Keep only recent samples
    if (this.totalRewardsSample.length > this.config.maxSamples) {
      this.totalRewardsSample = this.totalRewardsSample.slice(-this.config.maxSamples);
    }
    
    // Update accumulation rate if we have enough samples
    this.updateAccumulationRate();
    
    // Check if we should pause due to insufficient rewards
    const rewardRatio = Number(totalRewards) / Number(payoutAmount);
    
    if (rewardRatio < this.config.minimumProfitableRatio) {
      this.simpleLogger.critical(`⏸️ Insufficient rewards: ${ethers.formatEther(totalRewards)} ETH (${(rewardRatio * 100).toFixed(1)}% of payout)`);
      
      // Always pause when rewards are insufficient, regardless of recent transaction history
      // This saves CUs immediately when we know there aren't enough rewards
      this.calculateOptimalPauseDuration(payoutAmount);
    }
  }
  
  /**
   * Force a pause for a specific duration (when user manually triggers)
   */
  forcePause(durationHours: number, reason: string): void {
    const now = Date.now();
    this.pauseUntil = now + (durationHours * 60 * 60 * 1000);
    
    this.simpleLogger.critical(`⏸️ Operations paused for ${durationHours}h: ${reason}`);
  }
  
  /**
   * Calculate optimal pause duration based on reward accumulation patterns
   */
  private calculateOptimalPauseDuration(payoutAmount: bigint): void {
    const now = Date.now();
    
    // If we don't have enough data, use conservative estimate
    if (this.rewardAccumulationRate === 0) {
      this.pauseUntil = now + (this.config.defaultPauseDurationHours * 60 * 60 * 1000);
      
      this.simpleLogger.critical(`⏸️ Pausing for ${this.config.defaultPauseDurationHours}h (default - insufficient data)`);
      return;
    }
    
    // Calculate how long until we have enough rewards
    const neededRewards = Number(payoutAmount) * this.config.minimumProfitableRatio;
    const currentRewards = this.totalRewardsSample.length > 0 
      ? Number(this.totalRewardsSample[this.totalRewardsSample.length - 1]?.totalRewards)
      : 0;
    
    const rewardDeficit = Math.max(0, neededRewards - currentRewards);
    const hoursToAccumulate = rewardDeficit / this.rewardAccumulationRate;
    
    // Apply buffer factor and clamp to min/max bounds
    const rawPauseHours = hoursToAccumulate * this.config.pauseBufferFactor;
    const pauseHours = Math.min(
      this.config.maxPauseDurationHours, 
      Math.max(this.config.minPauseDurationHours, rawPauseHours)
    );
    
    this.pauseUntil = now + (pauseHours * 60 * 60 * 1000);
    
    this.simpleLogger.critical(`⏸️ Pausing for ${pauseHours.toFixed(1)}h (calculated: ${rawPauseHours.toFixed(1)}h, rate: ${this.rewardAccumulationRate.toFixed(0)}/hour)`);
  }
  
  /**
   * Update reward accumulation rate based on recent samples
   */
  private updateAccumulationRate(): void {
    if (this.totalRewardsSample.length < 2) return;
    
    // Use samples from the configured accumulation period to calculate rate
    const now = Date.now();
    const periodAgo = now - (this.config.accumulationPeriodHours * 60 * 60 * 1000);
    
    const recentSamples = this.totalRewardsSample.filter(s => s.timestamp > periodAgo);
    if (recentSamples.length < 2) return;
    
    const oldestSample = recentSamples[0];
    const newestSample = recentSamples[recentSamples.length - 1];
    
    const rewardIncrease = Number((newestSample?.totalRewards || 0n) - (oldestSample?.totalRewards || 0n));
    const timeSpanHours = ((newestSample?.timestamp || 0) - (oldestSample?.timestamp || 0)) / (1000 * 60 * 60);
    
    if (timeSpanHours > 0) {
      this.rewardAccumulationRate = rewardIncrease / timeSpanHours;
    }
  }
  
  /**
   * Get current status and statistics
   */
  getStatus(): {
    isPaused: boolean;
    pauseRemainingMinutes: number;
    rewardAccumulationRate: number;
    lastTransactionMinutesAgo: number;
    samples: number;
  } {
    const now = Date.now();
    const isPaused = now < this.pauseUntil;
    const pauseRemainingMinutes = isPaused ? Math.ceil((this.pauseUntil - now) / 1000 / 60) : 0;
    const lastTransactionMinutesAgo = this.lastSuccessfulTransaction > 0 
      ? (now - this.lastSuccessfulTransaction) / 1000 / 60 
      : Infinity;
    
    return {
      isPaused,
      pauseRemainingMinutes,
      rewardAccumulationRate: this.rewardAccumulationRate,
      lastTransactionMinutesAgo,
      samples: this.totalRewardsSample.length
    };
  }
  
  /**
   * Override pause (for manual resume)
   */
  resumeOperations(): void {
    this.pauseUntil = 0;
    this.simpleLogger.critical(`▶️ Operations resumed manually`);
  }
}