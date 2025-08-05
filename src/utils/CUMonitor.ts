import { Logger } from '@/monitor/logging';

/**
 * Monitors and tracks Compute Unit (CU) usage to help optimize costs
 */
export class CUMonitor {
  private cuUsage: Map<string, number> = new Map();
  private dailyUsage = 0;
  private dailyLimit = 20_000_000; // 20M CUs as mentioned by user
  private lastResetDate = new Date().toDateString();
  private readonly logger: Logger;

  // CU costs for common operations (from Alchemy docs)
  private static readonly CU_COSTS = {
    'eth_call': 26,
    'eth_blockNumber': 10,
    'eth_getTransactionReceipt': 20,
    'eth_estimateGas': 20,
    'eth_sendRawTransaction': 40,
    'eth_getLogs': 60,
    'multicall3': 26, // Single multicall cost vs N * 26 for individual calls
    'deposits': 26, // Contract call
    'unclaimedReward': 26, // Contract call
  };

  constructor(logger: Logger, dailyLimitCU = 20_000_000) {
    this.logger = logger;
    this.dailyLimit = dailyLimitCU;
  }

  /**
   * Track CU usage for an operation
   */
  trackUsage(operation: string, count = 1): void {
    const cost = CUMonitor.CU_COSTS[operation as keyof typeof CUMonitor.CU_COSTS] || 26; // Default to eth_call cost
    const totalCost = cost * count;
    
    this.resetDailyUsageIfNeeded();
    
    // Update operation-specific usage
    const currentUsage = this.cuUsage.get(operation) || 0;
    this.cuUsage.set(operation, currentUsage + totalCost);
    
    // Update daily usage
    this.dailyUsage += totalCost;
    
    this.logger.debug('CU usage tracked', {
      operation,
      count,
      costPerOperation: cost,
      totalCost,
      dailyUsage: this.dailyUsage,
      percentOfLimit: (this.dailyUsage / this.dailyLimit * 100).toFixed(2)
    });

    // Warning if approaching limit
    if (this.dailyUsage > this.dailyLimit * 0.8) {
      this.logger.warn('High CU usage detected', {
        dailyUsage: this.dailyUsage,
        percentOfLimit: (this.dailyUsage / this.dailyLimit * 100).toFixed(2),
        remainingCUs: this.dailyLimit - this.dailyUsage
      });
    }
  }

  /**
   * Track batch operation with potential savings
   */
  trackBatchOperation(operation: string, batchSize: number, usedMulticall = false): void {
    if (usedMulticall && batchSize > 1) {
      // Multicall: 1 call instead of N calls = saves (N-1) * 26 CUs
      this.trackUsage('multicall3', 1);
      const saved = (batchSize - 1) * 26;
      this.logger.info('CU savings from multicall', {
        operation,
        batchSize,
        cuSaved: saved,
        cuUsed: 26,
        cuWouldHaveUsed: batchSize * 26
      });
    } else {
      // Individual calls
      this.trackUsage(operation, batchSize);
    }
  }

  /**
   * Get current usage statistics
   */
  getUsageStats() {
    this.resetDailyUsageIfNeeded();
    
    return {
      dailyUsage: this.dailyUsage,
      dailyLimit: this.dailyLimit,
      percentUsed: (this.dailyUsage / this.dailyLimit * 100).toFixed(2),
      remainingCUs: this.dailyLimit - this.dailyUsage,
      topOperations: Array.from(this.cuUsage.entries())
        .sort(([,a], [,b]) => b - a)
        .slice(0, 10)
        .map(([op, usage]) => ({ operation: op, cuUsed: usage })),
      resetDate: this.lastResetDate
    };
  }

  /**
   * Get optimization recommendations
   */
  getOptimizationRecommendations(): string[] {
    const recommendations: string[] = [];
    const stats = this.getUsageStats();
    
    // High usage warning
    if (parseFloat(stats.percentUsed) > 80) {
      recommendations.push(`Daily CU usage is at ${stats.percentUsed}% - consider optimization`);
    }
    
    // Check for high individual call usage
    const unclaimedRewardUsage = this.cuUsage.get('unclaimedReward') || 0;
    const depositsUsage = this.cuUsage.get('deposits') || 0;
    
    if (unclaimedRewardUsage > 10000) {
      recommendations.push(`High unclaimedReward usage (${unclaimedRewardUsage} CUs) - ensure you're using multicall batching`);
    }
    
    if (depositsUsage > 5000) {
      recommendations.push(`High deposits usage (${depositsUsage} CUs) - consider caching deposit data`);
    }
    
    // Block number optimization
    const blockNumberUsage = this.cuUsage.get('eth_blockNumber') || 0;
    if (blockNumberUsage > 1000) {
      recommendations.push(`High block number calls (${blockNumberUsage} CUs) - implement block number caching`);
    }
    
    return recommendations;
  }

  /**
   * Reset daily usage if it's a new day
   */
  private resetDailyUsageIfNeeded(): void {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.logger.info('Daily CU usage reset', {
        previousDate: this.lastResetDate,
        previousUsage: this.dailyUsage,
        newDate: today
      });
      
      this.dailyUsage = 0;
      this.cuUsage.clear();
      this.lastResetDate = today;
    }
  }

  /**
   * Export usage data for analysis
   */
  exportUsageData() {
    return {
      timestamp: new Date().toISOString(),
      dailyUsage: this.dailyUsage,
      operations: Object.fromEntries(this.cuUsage),
      stats: this.getUsageStats(),
      recommendations: this.getOptimizationRecommendations()
    };
  }
}