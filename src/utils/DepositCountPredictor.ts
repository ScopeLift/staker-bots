import { ethers } from 'ethers';
import { Logger } from '@/monitor/logging';
import { SimplifiedLogger } from './SimplifiedLogger';

/**
 * Tracks deposit count growth by sampling every 5 minutes and extrapolating
 * to reduce unnecessary API calls during profitability analysis
 */
export class DepositCountPredictor {
  private readonly contract: ethers.Contract;
  private readonly logger: Logger;
  private readonly simpleLogger: SimplifiedLogger;
  
  // Sample history - store recent measurements
  private samples: Array<{ timestamp: number; maxDepositId: number }> = [];
  
  // Prediction settings
  private readonly SAMPLE_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_SAMPLES = 12; // Keep last 12 samples (1 hour of history)
  private readonly SAFETY_BUFFER = 50; // Extra deposits to scan beyond prediction
  
  constructor(contract: ethers.Contract, logger: Logger) {
    this.contract = contract;
    this.logger = logger;
    this.simpleLogger = new SimplifiedLogger(logger, 'DepositPredictor');
  }
  
  /**
   * Get the predicted upper bound for deposit IDs to scan
   * Returns the estimated max deposit ID plus safety buffer
   */
  async getPredictedScanLimit(): Promise<number> {
    const now = Date.now();
    
    // Check if we need a new sample
    await this.maybeTakeSample(now);
    
    // If we have less than 2 samples, take a full scan
    if (this.samples.length < 2) {
      const currentMax = await this.findCurrentMaxDepositId();
      this.samples.push({ timestamp: now, maxDepositId: currentMax });
      return currentMax + this.SAFETY_BUFFER;
    }
    
    // Extrapolate based on recent growth
    return this.extrapolateMaxDepositId(now) + this.SAFETY_BUFFER;
  }
  
  /**
   * Take a sample if enough time has passed since the last one
   */
  private async maybeTakeSample(now: number): Promise<void> {
    const lastSampleTime = this.samples.length > 0 
      ? this.samples[this.samples.length - 1]?.timestamp 
      : 0;
    
    if (now && lastSampleTime && now - lastSampleTime >= this.SAMPLE_INTERVAL) {
      try {
        const currentMax = await this.findCurrentMaxDepositId();
        
        // Add new sample
        this.samples.push({ timestamp: now, maxDepositId: currentMax });
        
        // Keep only recent samples
        if (this.samples.length > this.MAX_SAMPLES) {
          this.samples = this.samples.slice(-this.MAX_SAMPLES);
        }
        
        // Log growth info if we have previous sample
        if (this.samples.length >= 2) {
          const prevSample = this.samples[this.samples.length - 2];
          const growth = currentMax - (prevSample?.maxDepositId || 0);
          const timeElapsed = (now - (prevSample?.timestamp || 0)) / 1000 / 60; // minutes
          const growthPerMinute = growth / timeElapsed;
          
          this.simpleLogger.critical(
            `📊 Deposit growth: +${growth} deposits in ${timeElapsed.toFixed(1)}min (${growthPerMinute.toFixed(2)}/min)`
          );
        }
        
      } catch (error) {
        this.simpleLogger.error('Failed to take deposit sample', error);
      }
    }
  }
  
  /**
   * Find the current maximum deposit ID by scanning
   */
  private async findCurrentMaxDepositId(): Promise<number> {
    // Start from the last known position if we have samples
    const startId = this.samples.length > 0 
      ? Math.max(1, (this.samples[this.samples.length - 1]?.maxDepositId || 0) - 5)  // Go back 5 for safety
      : 1;
    
    let currentId = startId;
    let emptyCounter = 0;
    const MAX_EMPTY_TO_STOP = 10;
    let lastValidId = startId;
    
    while (emptyCounter < MAX_EMPTY_TO_STOP) {
      try {
        const deposit = await this.contract.deposits?.(currentId);
        
        const owner = deposit[0] || ethers.ZeroAddress;
        const amount = deposit[1] || BigInt(0);
        const earningPower = deposit[2] || BigInt(0);
        const delegatee = deposit[3] || ethers.ZeroAddress;
        
        const isCompletelyEmpty = 
          owner === ethers.ZeroAddress &&
          amount === BigInt(0) &&
          earningPower === BigInt(0) &&
          delegatee === ethers.ZeroAddress;
        
        if (isCompletelyEmpty) {
          emptyCounter++;
        } else {
          emptyCounter = 0; // Reset counter when we find a deposit
          lastValidId = currentId;
        }
        
        currentId++;
        
      } catch (error) {
        // If we hit an error, assume we've reached the end
        break;
      }
    }
    
    return lastValidId;
  }
  
  /**
   * Extrapolate maximum deposit ID based on recent growth trends
   */
  private extrapolateMaxDepositId(currentTime: number): number {
    if (this.samples.length < 2) {
      return this.samples[0]?.maxDepositId || 1;
    }
    
    // Use the most recent two samples for linear extrapolation
    const latestSample = this.samples[this.samples.length - 1];
    const previousSample = this.samples[this.samples.length - 2];
    
    const timeDiff = (latestSample?.timestamp || 0) - (previousSample?.timestamp || 0); // milliseconds
    const depositDiff = (latestSample?.maxDepositId || 0) - (previousSample?.maxDepositId || 0);
    
    // Calculate growth rate (deposits per millisecond)
    const growthRate = depositDiff / timeDiff;
    
    // Extrapolate based on time elapsed since last sample
    const timeElapsed = currentTime - (latestSample?.timestamp || 0);
    const predictedGrowth = growthRate * timeElapsed;
    
    return Math.ceil((latestSample?.maxDepositId || 0) + predictedGrowth);
  }
  
  /**
   * Get deposit count statistics for monitoring
   */
  getStats(): {
    currentScanLimit: number;
    lastKnownMax: number;
    samples: number;
    avgGrowthPerMinute: number;
    lastSampleMinutesAgo: number;
  } {
    const now = Date.now();
    const currentScanLimit = this.samples.length >= 2 
      ? this.extrapolateMaxDepositId(now) + this.SAFETY_BUFFER
      : (this.samples[0]?.maxDepositId || 0) + this.SAFETY_BUFFER;
    
    const lastKnownMax = this.samples.length > 0 
      ? this.samples[this.samples.length - 1]?.maxDepositId || 0
      : 0;
    
    // Calculate average growth rate from all samples
    let avgGrowthPerMinute = 0;
    if (this.samples.length >= 2) {
      const firstSample = this.samples[0];
      const lastSample = this.samples[this.samples.length - 1];
      const totalGrowth = (lastSample?.maxDepositId || 0) - (firstSample?.maxDepositId || 0);
      const totalTime = ((lastSample?.timestamp || 0) - (firstSample?.timestamp || 0)) / 1000 / 60; // minutes
      avgGrowthPerMinute = totalTime > 0 ? totalGrowth / totalTime : 0;
    }
    
    const lastSampleMinutesAgo = this.samples.length > 0
      ? (now - (this.samples[this.samples.length - 1]?.timestamp || 0)) / 1000 / 60
      : Infinity;
    
    return {
      currentScanLimit,
      lastKnownMax,
      samples: this.samples.length,
      avgGrowthPerMinute,
      lastSampleMinutesAgo
    };
  }
}