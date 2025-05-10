import { ethers } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { CoinMarketCapFeed } from './CoinmarketcapFeed';
import { CONFIG } from '../configuration';

interface PriceCache {
  ethPrice: bigint;
  tokenPrice: bigint;
  timestamp: number;
}

export class GasCostEstimator {
  private readonly logger: Logger;
  private readonly priceFeed: CoinMarketCapFeed;
  private priceCache: PriceCache | null = null;
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds

  // Constants for fallback values and minimums
  private static readonly FALLBACK_ETH_PRICE_USD = 2500;
  private static readonly FALLBACK_TOKEN_PRICE_USD = 0.1;
  private static readonly MINIMUM_GAS_COST_USD = 30; // $30 minimum
  private static readonly FALLBACK_GAS_PRICE_GWEI = 50n; // 50 gwei

  constructor() {
    this.logger = new ConsoleLogger('info');
    this.priceFeed = new CoinMarketCapFeed(
      {
        ...CONFIG.priceFeed.coinmarketcap,
        rewardToken: CONFIG.govlst.address,
        gasToken: 'ETH',
      },
      this.logger,
    );
  }

  private async getCurrentGasPrice(provider: ethers.Provider): Promise<bigint> {
    try {
      const gasPrice = await provider.getFeeData();
      return gasPrice?.gasPrice
        ? BigInt(gasPrice.gasPrice.toString())
        : GasCostEstimator.FALLBACK_GAS_PRICE_GWEI * 10n ** 9n;
    } catch (error) {
      this.logger.warn('Failed to get gas price, using fallback', {
        fallbackGwei: GasCostEstimator.FALLBACK_GAS_PRICE_GWEI.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      return GasCostEstimator.FALLBACK_GAS_PRICE_GWEI * 10n ** 9n;
    }
  }

  private isCacheValid(): boolean {
    if (!this.priceCache) return false;
    const now = Date.now();
    return now - this.priceCache.timestamp < this.CACHE_DURATION;
  }

  private async calculateTokenPriceRatio(): Promise<{
    ethPrice: bigint;
    tokenPrice: bigint;
  }> {
    // Check cache first
    if (this.isCacheValid() && this.priceCache) {
      this.logger.info('Using cached price data', {
        ethPrice: this.priceCache.ethPrice.toString(),
        tokenPrice: this.priceCache.tokenPrice.toString(),
        cacheAge: `${(Date.now() - this.priceCache.timestamp) / 1000}s`,
      });
      return {
        ethPrice: this.priceCache.ethPrice,
        tokenPrice: this.priceCache.tokenPrice,
      };
    }

    try {
      const prices = await this.priceFeed.getTokenPrices();
      const priceData = {
        ethPrice: BigInt(Math.floor(prices.gasToken.usd * 1e18)),
        tokenPrice: BigInt(Math.floor(prices.rewardToken.usd * 1e18)),
      };

      // Update cache
      this.priceCache = {
        ...priceData,
        timestamp: Date.now(),
      };

      this.logger.info('Updated price cache', {
        ethPrice: prices.gasToken.usd,
        tokenPrice: prices.rewardToken.usd,
        timestamp: new Date().toISOString(),
      });

      return priceData;
    } catch (error) {
      // If we have stale cache, use it as fallback before using hardcoded values
      if (this.priceCache) {
        this.logger.warn('API error, using stale cache as fallback', {
          error: error instanceof Error ? error.message : String(error),
          cacheAge: `${(Date.now() - this.priceCache.timestamp) / 1000}s`,
        });
        return {
          ethPrice: this.priceCache.ethPrice,
          tokenPrice: this.priceCache.tokenPrice,
        };
      }

      this.logger.warn('Using fallback prices, no cache available', {
        eth: GasCostEstimator.FALLBACK_ETH_PRICE_USD,
        token: GasCostEstimator.FALLBACK_TOKEN_PRICE_USD,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        ethPrice: BigInt(
          Math.floor(GasCostEstimator.FALLBACK_ETH_PRICE_USD * 1e18),
        ),
        tokenPrice: BigInt(
          Math.floor(GasCostEstimator.FALLBACK_TOKEN_PRICE_USD * 1e18),
        ),
      };
    }
  }

  private calculateMinimumGasCostInTokens(tokenPriceUSD: bigint): bigint {
    // Convert minimum USD value to token amount based on token price
    return (
      (BigInt(GasCostEstimator.MINIMUM_GAS_COST_USD) * 10n ** 18n) /
      tokenPriceUSD
    );
  }

  async estimateGasCostInRewardToken(
    provider: ethers.Provider,
    gasLimit: bigint,
  ): Promise<bigint> {
    try {
      // Get current gas price with fallback
      const gasPriceWei = await this.getCurrentGasPrice(provider);

      // Calculate base gas cost using provided gasLimit
      const gasCostWei = gasPriceWei * gasLimit;

      // Get price ratio with caching
      const { ethPrice, tokenPrice } = await this.calculateTokenPriceRatio();

      // Calculate cost in tokens
      const costInRewardTokens = (gasCostWei * ethPrice) / tokenPrice;

      // Ensure we never go below minimum gas cost
      const minimumCost = this.calculateMinimumGasCostInTokens(tokenPrice);

      this.logger.info('Gas cost calculation', {
        gasCostInTokens: ethers.formatEther(costInRewardTokens),
        minimumCostInTokens: ethers.formatEther(minimumCost),
        gasPriceGwei: Number(gasPriceWei) / 1e9,
        providedGasLimit: gasLimit.toString(),
        ethPriceUSD: Number(ethPrice) / 1e18,
        tokenPriceUSD: Number(tokenPrice) / 1e18,
        usingCache: this.isCacheValid(),
      });

      return costInRewardTokens > minimumCost
        ? costInRewardTokens
        : minimumCost;
    } catch (error) {
      // Fallback to minimum USD value in tokens
      const fallbackCost = this.calculateMinimumGasCostInTokens(
        BigInt(Math.floor(GasCostEstimator.FALLBACK_TOKEN_PRICE_USD * 1e18)),
      );

      this.logger.warn('Using fallback gas cost', {
        costInTokens: ethers.formatEther(fallbackCost),
        minimumUSD: GasCostEstimator.MINIMUM_GAS_COST_USD,
        reason: error instanceof Error ? error.message : String(error),
      });

      return fallbackCost;
    }
  }
}
