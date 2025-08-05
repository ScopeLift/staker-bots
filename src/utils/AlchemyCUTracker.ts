import { Logger } from '@/monitor/logging';

/**
 * Accurate Alchemy Compute Unit (CU) tracker based on official documentation
 * Tracks real-time CU usage and provides detailed analytics
 */
export class AlchemyCUTracker {
  private readonly logger: Logger;
  private dailyUsage = 0;
  private dailyLimit: number;
  private lastResetDate = new Date().toDateString();
  private methodUsage: Map<string, { calls: number; totalCUs: number }> = new Map();
  
  // Official Alchemy CU costs from documentation
  private static readonly OFFICIAL_CU_COSTS = {
    // Standard Methods
    'eth_call': 26,
    'eth_blockNumber': 10,
    'eth_getTransactionReceipt': 20,
    'eth_estimateGas': 20,
    'eth_sendRawTransaction': 40,
    'eth_getLogs': 60,
    'eth_getBalance': 20,
    'eth_getCode': 20,
    'eth_chainId': 0,
    
    // Contract methods (all use eth_call)
    'unclaimedReward': 26,
    'deposits': 26,
    'payoutAmount': 26,
    
    // Multicall3 - single eth_call regardless of batch size
    'multicall3': 26,
    
    // Enhanced APIs
    'getNFTMetadata': 100,
    'getFloorPrice': 100,
  } as const;

  constructor(logger: Logger, dailyLimitCU = 20_000_000) {
    this.logger = logger;
    this.dailyLimit = dailyLimitCU;
  }

  /**
   * Track a single method call
   */
  trackMethod(method: string, count = 1): number {
    const cuCost = AlchemyCUTracker.OFFICIAL_CU_COSTS[method as keyof typeof AlchemyCUTracker.OFFICIAL_CU_COSTS] || 26;
    const totalCUs = cuCost * count;
    
    this.resetDailyUsageIfNeeded();
    this.dailyUsage += totalCUs;
    
    // Update method-specific tracking
    const existing = this.methodUsage.get(method) || { calls: 0, totalCUs: 0 };
    this.methodUsage.set(method, {
      calls: existing.calls + count,
      totalCUs: existing.totalCUs + totalCUs
    });

    return totalCUs;
  }

  /**
   * Track multicall batch - always 26 CUs regardless of batch size
   */
  trackMulticall(individualMethodCount: number): { cuUsed: number; cuSaved: number } {
    const cuUsed = 26; // Multicall3 always costs 26 CUs
    const cuSaved = (individualMethodCount - 1) * 26; // What we saved vs individual calls
    
    this.trackMethod('multicall3', 1);
    
    return { cuUsed, cuSaved };
  }

  /**
   * Track individual calls when multicall fails
   */
  trackIndividualCalls(method: string, count: number): number {
    return this.trackMethod(method, count);
  }

  /**
   * Get current usage statistics
   */
  getUsageStats() {
    this.resetDailyUsageIfNeeded();
    
    return {
      dailyUsage: this.dailyUsage,
      dailyLimit: this.dailyLimit,
      percentUsed: ((this.dailyUsage / this.dailyLimit) * 100).toFixed(2),
      remainingCUs: this.dailyLimit - this.dailyUsage,
      costInUSD: this.calculateCostUSD(),
      resetDate: this.lastResetDate,
      methodBreakdown: this.getTopMethods()
    };
  }

  /**
   * Get top methods by CU usage
   */
  private getTopMethods() {
    return Array.from(this.methodUsage.entries())
      .sort(([,a], [,b]) => b.totalCUs - a.totalCUs)
      .slice(0, 10)
      .map(([method, stats]) => ({
        method,
        calls: stats.calls,
        totalCUs: stats.totalCUs,
        avgCUsPerCall: (stats.totalCUs / stats.calls).toFixed(1)
      }));
  }

  /**
   * Calculate estimated USD cost based on Alchemy pricing
   */
  private calculateCostUSD(): string {
    // Alchemy Growth plan: $199/month for 300M CUs + $1.20 per additional 1M CUs
    const includedCUs = 300_000_000; // Monthly included CUs
    const additionalCUCost = 1.20; // Cost per 1M additional CUs
    
    // For daily usage, approximate monthly cost
    const estimatedMonthlyCUs = this.dailyUsage * 30;
    
    if (estimatedMonthlyCUs <= includedCUs) {
      return '$199.00'; // Base plan cost
    } else {
      const additionalCUs = estimatedMonthlyCUs - includedCUs;
      const additionalCost = (additionalCUs / 1_000_000) * additionalCUCost;
      return `$${(199 + additionalCost).toFixed(2)}`;
    }
  }

  /**
   * Get optimization recommendations
   */
  getOptimizationRecommendations(): string[] {
    const recommendations: string[] = [];
    const stats = this.getUsageStats();
    
    // High usage warning
    if (parseFloat(stats.percentUsed) > 80) {
      recommendations.push(`⚠️ Daily CU usage at ${stats.percentUsed}% of limit`);
    }
    
    // Check method-specific issues
    const topMethods = this.getTopMethods();
    
    if (topMethods.length > 0) {
      const topMethod = topMethods[0];
      
      if (topMethod?.method === 'eth_call' && topMethod.totalCUs > 10000) {
        recommendations.push(`🔄 High eth_call usage (${topMethod.totalCUs} CUs) - ensure multicall batching is working`);
      }
      
      if (topMethod?.method === 'unclaimedReward' && topMethod.calls > 100) {
        recommendations.push(`📦 High unclaimedReward calls (${topMethod.calls}) - batch size too small?`);
      }
      
      if (topMethod?.method === 'eth_blockNumber' && topMethod.totalCUs > 500) {
        recommendations.push(`⏰ High block number calls (${topMethod.totalCUs} CUs) - implement caching`);
      }
    }
    
    // Cost optimization
    const monthlyCost = parseFloat(stats.costInUSD.replace('$', ''));
    if (monthlyCost > 400) {
      recommendations.push(`💰 High monthly cost estimate (${stats.costInUSD}) - consider provider alternatives`);
    }
    
    return recommendations;
  }

  /**
   * Export detailed usage report
   */
  exportDetailedReport() {
    const stats = this.getUsageStats();
    
    return {
      timestamp: new Date().toISOString(),
      usage: {
        daily: stats.dailyUsage,
        limit: stats.dailyLimit,
        percentage: stats.percentUsed,
        remaining: stats.remainingCUs
      },
      cost: {
        estimated: stats.costInUSD,
        breakdown: 'Based on Alchemy Growth plan ($199/month + $1.20/M additional CUs)'
      },
      methods: stats.methodBreakdown,
      recommendations: this.getOptimizationRecommendations(),
      cuSavingsFromMulticall: this.calculateMulticallSavings()
    };
  }

  /**
   * Calculate total CU savings from multicall usage
   */
  private calculateMulticallSavings(): number {
    const multicallStats = this.methodUsage.get('multicall3');
    if (!multicallStats) return 0;
    
    // Estimate average batch size based on individual call reductions
    // This is approximate since we don't track exact batch sizes
    const estimatedBatchSize = 20; // Conservative estimate
    return multicallStats.calls * (estimatedBatchSize - 1) * 26;
  }

  /**
   * Reset daily usage if it's a new day
   */
  private resetDailyUsageIfNeeded(): void {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.logger.info('🔄 Daily CU usage reset', {
        previousDate: this.lastResetDate,
        previousUsage: this.dailyUsage,
        previousCost: this.calculateCostUSD(),
        newDate: today
      });
      
      this.dailyUsage = 0;
      this.methodUsage.clear();
      this.lastResetDate = today;
    }
  }

  /**
   * Log periodic summary with actionable insights
   */
  logSummary(): void {
    const stats = this.getUsageStats();
    const recommendations = this.getOptimizationRecommendations();
    
    this.logger.info('📊 CU Usage Summary', {
      usage: `${stats.dailyUsage.toLocaleString()} / ${stats.dailyLimit.toLocaleString()} (${stats.percentUsed}%)`,
      cost: stats.costInUSD,
      topMethod: stats.methodBreakdown[0]?.method || 'none',
      savings: `~${this.calculateMulticallSavings().toLocaleString()} CUs saved via multicall`
    });
    
    if (recommendations.length > 0) {
      this.logger.warn('💡 CU Optimization Recommendations', {
        count: recommendations.length,
        recommendations: recommendations.slice(0, 3) // Top 3 recommendations
      });
    }
  }
}