import { ethers } from 'ethers';
import { Logger } from '@/monitor/logging';

/**
 * Caches block numbers to reduce redundant getBlockNumber calls
 * Saves 10 CUs per avoided call
 */
export class BlockNumberCache {
  private cache: Map<string, { blockNumber: number; timestamp: number }> = new Map();
  private readonly cacheTimeout: number;
  private readonly logger: Logger;

  constructor(logger: Logger, cacheTimeoutMs = 12000) { // ~1 block time
    this.logger = logger;
    this.cacheTimeout = cacheTimeoutMs;
  }

  /**
   * Gets block number with caching to reduce CU usage
   * @param provider Ethereum provider
   * @param cacheKey Optional cache key for different contexts
   * @returns Current block number
   */
  async getCachedBlockNumber(
    provider: ethers.Provider,
    cacheKey = 'default'
  ): Promise<number> {
    const now = Date.now();
    const cached = this.cache.get(cacheKey);

    // Return cached value if still fresh
    if (cached && (now - cached.timestamp) < this.cacheTimeout) {
      this.logger.debug('Using cached block number', {
        blockNumber: cached.blockNumber,
        age: now - cached.timestamp,
        cacheKey
      });
      return cached.blockNumber;
    }

    // Fetch fresh block number
    try {
      const blockNumber = await provider.getBlockNumber();
      this.cache.set(cacheKey, { blockNumber, timestamp: now });
      
      this.logger.debug('Fetched fresh block number (10 CUs)', {
        blockNumber,
        cacheKey,
        cacheSize: this.cache.size
      });
      
      return blockNumber;
    } catch (error) {
      // Return stale cache if available on error
      if (cached) {
        this.logger.warn('Using stale cached block number due to error', {
          error: error instanceof Error ? error.message : String(error),
          blockNumber: cached.blockNumber,
          age: now - cached.timestamp
        });
        return cached.blockNumber;
      }
      throw error;
    }
  }

  /**
   * Clears the cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Gets cache statistics
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }
}