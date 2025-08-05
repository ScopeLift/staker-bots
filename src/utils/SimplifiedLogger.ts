import { Logger } from '@/monitor/logging';
import { AlchemyCUTracker } from './AlchemyCUTracker';

/**
 * Simplified logging wrapper that reduces verbosity and shows only critical information
 */
export class SimplifiedLogger {
  private readonly logger: Logger;
  private readonly component: string;
  private readonly cuTracker: AlchemyCUTracker;
  private lastSummaryTime = Date.now();
  private batchCounter = 0;
  private rewardCounter = 0;

  constructor(logger: Logger, component: string) {
    this.logger = logger;
    this.component = component;
    this.cuTracker = new AlchemyCUTracker(logger);
  }

  /**
   * Log critical information only
   */
  critical(message: string, data?: any): void {
    this.logger.info(`[${this.component}] ${message}`, data);
  }

  /**
   * Track batch operations silently - only count, don't log
   */
  trackBatch(operation: string, count: number, isMulticall = false): void {
    this.batchCounter++;
    
    if (isMulticall) {
      this.cuTracker.trackMulticall(count);
    } else {
      this.cuTracker.trackIndividualCalls(operation, count);
    }
    
    // No logging - just tracking
  }

  /**
   * Track rewards silently
   */
  trackRewards(nonZeroCount: number, totalValue: string): void {
    this.rewardCounter += nonZeroCount;
    // No logging - just counting
  }

  /**
   * Silent periodic maintenance
   */
  maybeSummary(): void {
    const now = Date.now();
    if (now - this.lastSummaryTime > 600000) { // 10 minutes
      // Only log if approaching CU limits
      const stats = this.cuTracker.getUsageStats();
      if (parseFloat(stats.percentUsed) > 75) {
        this.logger.warn(`[${this.component}] ⚠️ High CU usage: ${stats.percentUsed}% (${stats.dailyUsage.toLocaleString()} / ${stats.dailyLimit.toLocaleString()})`);
      }
      this.lastSummaryTime = now;
    }
  }

  /**
   * Stage analysis results - always log these as they're critical
   */
  stageResult(stage: string, success: boolean, data: any): void {
    this.logger.info(`[${this.component}] ${stage}`, { success, ...data });
  }

  /**
   * Error logging - always show errors
   */
  error(message: string, error: any): void {
    this.logger.error(`[${this.component}] ${message}`, error);
  }

  /**
   * Warning logging - always show warnings
   */
  warn(message: string, data?: any): void {
    this.logger.warn(`[${this.component}] ${message}`, data);
  }

  /**
   * Debug logging - only in development
   */
  debug(message: string, data?: any): void {
    if (process.env.NODE_ENV === 'development') {
      this.logger.debug(`[${this.component}] ${message}`, data);
    }
  }

  /**
   * Get CU tracker for direct access
   */
  getCUTracker(): AlchemyCUTracker {
    return this.cuTracker;
  }

  /**
   * Track a specific method call
   */
  trackMethod(method: string, count = 1): void {
    this.cuTracker.trackMethod(method, count);
  }
}