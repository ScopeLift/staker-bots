import { ethers } from 'ethers';
import { Logger } from '@/monitor/logging';

/**
 * Caches contract data to reduce redundant calls
 * Saves 26 CUs per avoided eth_call
 */
export class ContractDataCache {
  private depositCache: Map<string, { data: any; timestamp: number }> = new Map();
  private rewardCache: Map<string, { reward: bigint; timestamp: number }> = new Map();
  private readonly depositCacheTimeout: number;
  private readonly rewardCacheTimeout: number;
  private readonly logger: Logger;

  constructor(
    logger: Logger,
    depositCacheTimeoutMs = 300000, // 5 minutes - deposit data changes rarely
    rewardCacheTimeoutMs = 30000    // 30 seconds - rewards change frequently
  ) {
    this.logger = logger;
    this.depositCacheTimeout = depositCacheTimeoutMs;
    this.rewardCacheTimeout = rewardCacheTimeoutMs;
  }

  /**
   * Gets deposit data with caching
   */
  async getCachedDepositData(
    contract: ethers.Contract,
    depositId: string
  ): Promise<any> {
    const now = Date.now();
    const cached = this.depositCache.get(depositId);

    if (cached && (now - cached.timestamp) < this.depositCacheTimeout) {
      this.logger.debug('Using cached deposit data', {
        depositId,
        age: now - cached.timestamp
      });
      return cached.data;
    }

    try {
      const data = await contract.deposits?.(depositId);
      this.depositCache.set(depositId, { data, timestamp: now });
      
      this.logger.debug('Fetched fresh deposit data', {
        depositId,
        cacheSize: this.depositCache.size
      });
      
      return data;
    } catch (error) {
      if (cached) {
        this.logger.warn('Using stale cached deposit data due to error', {
          error: error instanceof Error ? error.message : String(error),
          depositId,
          age: now - cached.timestamp
        });
        return cached.data;
      }
      throw error;
    }
  }

  /**
   * Gets reward data with shorter caching due to frequent changes
   */
  async getCachedReward(
    contract: ethers.Contract,
    depositId: string
  ): Promise<bigint> {
    const now = Date.now();
    const cached = this.rewardCache.get(depositId);

    if (cached && (now - cached.timestamp) < this.rewardCacheTimeout) {
      this.logger.debug('Using cached reward', {
        depositId,
        reward: ethers.formatEther(cached.reward),
        age: now - cached.timestamp
      });
      return cached.reward;
    }

    try {
      const reward = await contract.unclaimedReward?.(depositId);
      this.rewardCache.set(depositId, { reward, timestamp: now });
      
      this.logger.debug('Fetched fresh reward', {
        depositId,
        reward: ethers.formatEther(reward),
        cacheSize: this.rewardCache.size
      });
      
      return reward;
    } catch (error) {
      if (cached) {
        this.logger.warn('Using stale cached reward due to error', {
          error: error instanceof Error ? error.message : String(error),
          depositId,
          reward: ethers.formatEther(cached.reward),
          age: now - cached.timestamp
        });
        return cached.reward;
      }
      throw error;
    }
  }

  /**
   * Invalidates cache for specific deposit
   */
  invalidateDeposit(depositId: string): void {
    this.depositCache.delete(depositId);
    this.rewardCache.delete(depositId);
  }

  /**
   * Clears all caches
   */
  clear(): void {
    this.depositCache.clear();
    this.rewardCache.clear();
  }

  /**
   * Gets cache statistics
   */
  getStats() {
    return {
      deposits: {
        size: this.depositCache.size,
        keys: Array.from(this.depositCache.keys()).slice(0, 10) // First 10 for brevity
      },
      rewards: {
        size: this.rewardCache.size,
        keys: Array.from(this.rewardCache.keys()).slice(0, 10)
      }
    };
  }

  /**
   * Cleanup expired entries
   */
  cleanup(): void {
    const now = Date.now();
    
    // Cleanup deposit cache
    for (const [key, value] of this.depositCache.entries()) {
      if (now - value.timestamp > this.depositCacheTimeout) {
        this.depositCache.delete(key);
      }
    }
    
    // Cleanup reward cache
    for (const [key, value] of this.rewardCache.entries()) {
      if (now - value.timestamp > this.rewardCacheTimeout) {
        this.rewardCache.delete(key);
      }
    }
    
    this.logger.debug('Cache cleanup completed', this.getStats());
  }
}