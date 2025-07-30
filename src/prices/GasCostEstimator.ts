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
  private static readonly FALLBACK_GAS_PRICE_GWEI = 3n; // 3 gwei (base ~2.257 + buffer)
  private static readonly FALLBACK_PRIORITY_FEE_GWEI = 0.2; // 0.2 gwei (tip ~0.158 + buffer)
  private static readonly ETH_DECIMALS = 18;
  private static readonly TOKEN_DECIMALS =
    CONFIG.govlst.rewardTokenDecimals || 18;

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

  private isCacheValid(): boolean {
    return (
      this.priceCache !== null &&
      Date.now() - this.priceCache.timestamp < this.CACHE_DURATION
    );
  }

  private async getCurrentGasPrice(provider: ethers.Provider): Promise<bigint> {
    try {
      const feeData = await provider.getFeeData();
      let gasPrice: bigint;
      let priorityFee: bigint | undefined;

      // Add detailed debug for production issue
      this.logger.info('Raw fee data debug', {
        feeDataExists: !!feeData,
        gasPriceExists: !!feeData?.gasPrice,
        gasPriceValue: feeData?.gasPrice?.toString() || 'undefined',
        maxFeePerGas: feeData?.maxFeePerGas?.toString() || 'undefined',
        maxPriorityFeePerGas:
          feeData?.maxPriorityFeePerGas?.toString() || 'undefined',
        providerType: provider.constructor.name,
      });

      if (feeData?.gasPrice) {
        let currentGasPrice = BigInt(feeData.gasPrice.toString());

        // Handle very low gas prices (sub 1 gwei) that can cause issues
        const MIN_GAS_PRICE_GWEI = 1n; // 1 gwei minimum
        const MIN_GAS_PRICE_WEI = MIN_GAS_PRICE_GWEI * 10n ** 9n;

        if (currentGasPrice < MIN_GAS_PRICE_WEI) {
          this.logger.warn('Gas price is very low, using minimum threshold', {
            actualGasPriceGwei: Number(currentGasPrice) / 1e9,
            minGasPriceGwei: Number(MIN_GAS_PRICE_GWEI),
            usingMinimum: true,
          });
          currentGasPrice = MIN_GAS_PRICE_WEI;
        }

        // Apply 25% buffer to current gas price
        gasPrice = (currentGasPrice * 125n) / 100n; // Add 25% buffer

        // Also get max priority fee if EIP-1559 is active
        if (feeData.maxPriorityFeePerGas) {
          priorityFee = BigInt(feeData.maxPriorityFeePerGas.toString());
          priorityFee = (priorityFee * 125n) / 100n; // Add 25% buffer
        }
      } else {
        // Use fallback values
        gasPrice = GasCostEstimator.FALLBACK_GAS_PRICE_GWEI * 10n ** 9n;
        priorityFee = BigInt(
          Math.floor(GasCostEstimator.FALLBACK_PRIORITY_FEE_GWEI * 1e9),
        );

        // Log when using fallback
        this.logger.warn(
          'Using fallback gas price due to missing feeData.gasPrice',
          {
            fallbackGwei: GasCostEstimator.FALLBACK_GAS_PRICE_GWEI.toString(),
            fallbackWei: gasPrice.toString(),
            reason: feeData ? 'feeData.gasPrice is null/0' : 'feeData is null',
          },
        );
      }

      this.logger.info('Retrieved current gas price with 25% buffer', {
        gasPriceWei: gasPrice.toString(),
        gasPriceGwei: Number(gasPrice) / 1e9,
        priorityFeeWei: priorityFee?.toString() || 'N/A',
        priorityFeeGwei: priorityFee ? Number(priorityFee) / 1e9 : 'N/A',
        source: feeData?.gasPrice ? 'provider (+25% buffer)' : 'fallback',
      });

      return gasPrice;
    } catch (error) {
      this.logger.warn('Failed to get gas price, using fallback', {
        fallbackGwei: GasCostEstimator.FALLBACK_GAS_PRICE_GWEI.toString(),
        fallbackPriorityFeeGwei:
          GasCostEstimator.FALLBACK_PRIORITY_FEE_GWEI.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      return GasCostEstimator.FALLBACK_GAS_PRICE_GWEI * 10n ** 9n;
    }
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

      // Convert prices to wei/token base units with proper decimals
      const ethPriceScaled = BigInt(
        Math.floor(prices.gasToken.usd * 10 ** GasCostEstimator.ETH_DECIMALS),
      );
      const tokenPriceScaled = BigInt(
        Math.floor(
          prices.rewardToken.usd * 10 ** GasCostEstimator.TOKEN_DECIMALS,
        ),
      );

      const priceData = {
        ethPrice: ethPriceScaled,
        tokenPrice: tokenPriceScaled,
      };

      // Update cache
      this.priceCache = {
        ...priceData,
        timestamp: Date.now(),
      };

      this.logger.info('Updated price cache', {
        ethPriceUSD: prices.gasToken.usd,
        tokenPriceUSD: prices.rewardToken.usd,
        ethPriceScaled: ethPriceScaled.toString(),
        tokenPriceScaled: tokenPriceScaled.toString(),
        ethDecimals: GasCostEstimator.ETH_DECIMALS,
        tokenDecimals: GasCostEstimator.TOKEN_DECIMALS,
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
          Math.floor(
            GasCostEstimator.FALLBACK_ETH_PRICE_USD *
              10 ** GasCostEstimator.ETH_DECIMALS,
          ),
        ),
        tokenPrice: BigInt(
          Math.floor(
            GasCostEstimator.FALLBACK_TOKEN_PRICE_USD *
              10 ** GasCostEstimator.TOKEN_DECIMALS,
          ),
        ),
      };
    }
  }

  private calculateMinimumGasCostInTokens(tokenPriceUSD: bigint): bigint {
    // Convert minimum USD value to token amount based on token price
    const minCost =
      (BigInt(GasCostEstimator.MINIMUM_GAS_COST_USD) *
        10n ** BigInt(GasCostEstimator.TOKEN_DECIMALS)) /
      tokenPriceUSD;

    this.logger.info('Calculated minimum gas cost in tokens', {
      minUSD: GasCostEstimator.MINIMUM_GAS_COST_USD,
      tokenPriceUSD:
        Number(tokenPriceUSD) / 10 ** GasCostEstimator.TOKEN_DECIMALS,
      minCostInTokens: ethers.formatUnits(
        minCost,
        GasCostEstimator.TOKEN_DECIMALS,
      ),
    });

    return minCost;
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

      this.logger.info('Base gas cost calculation', {
        gasPriceWei: gasPriceWei.toString(),
        gasPriceGwei: Number(gasPriceWei) / 1e9,
        gasLimit: gasLimit.toString(),
        gasCostWei: gasCostWei.toString(),
        gasCostEth: ethers.formatEther(gasCostWei),
      });

      // Get price ratio with caching
      const { ethPrice, tokenPrice } = await this.calculateTokenPriceRatio();

      // Calculate cost in tokens with decimal adjustment
      // Formula: (gasCostWei * ethPriceUSD) / tokenPriceUSD
      // Note: We need to adjust for the difference in decimals between ETH and the reward token
      const decimalAdjustment =
        10n **
        BigInt(
          Math.abs(
            GasCostEstimator.ETH_DECIMALS - GasCostEstimator.TOKEN_DECIMALS,
          ),
        );
      let costInRewardTokens: bigint;

      // Add detailed debug for conversion calculation
      this.logger.info('Token conversion debug values', {
        gasCostWei: gasCostWei.toString(),
        gasCostEth: ethers.formatEther(gasCostWei),
        ethPrice: ethPrice.toString(),
        tokenPrice: tokenPrice.toString(),
        ethDecimals: GasCostEstimator.ETH_DECIMALS,
        tokenDecimals: GasCostEstimator.TOKEN_DECIMALS,
        decimalAdjustment: decimalAdjustment.toString(),
        ethPriceUsd: Number(ethPrice) / 10 ** GasCostEstimator.ETH_DECIMALS,
        tokenPriceUsd:
          Number(tokenPrice) / 10 ** GasCostEstimator.TOKEN_DECIMALS,
      });

      if (GasCostEstimator.ETH_DECIMALS >= GasCostEstimator.TOKEN_DECIMALS) {
        costInRewardTokens =
          (gasCostWei * ethPrice) / (tokenPrice * decimalAdjustment);

        this.logger.info(
          'Token conversion calculation (ETH decimals >= Token decimals)',
          {
            numerator: (gasCostWei * ethPrice).toString(),
            denominator: (tokenPrice * decimalAdjustment).toString(),
            formula: 'gasCostWei * ethPrice / (tokenPrice * decimalAdjustment)',
          },
        );
      } else {
        costInRewardTokens =
          (gasCostWei * ethPrice * decimalAdjustment) / tokenPrice;

        this.logger.info(
          'Token conversion calculation (ETH decimals < Token decimals)',
          {
            numerator: (gasCostWei * ethPrice * decimalAdjustment).toString(),
            denominator: tokenPrice.toString(),
            formula: 'gasCostWei * ethPrice * decimalAdjustment / tokenPrice',
          },
        );
      }

      // Ensure we never go below minimum gas cost
      const minimumCost = this.calculateMinimumGasCostInTokens(tokenPrice);

      this.logger.info('Gas cost calculation results', {
        rawCostInRewardTokens: costInRewardTokens.toString(),
        formattedCostInRewardTokens: ethers.formatUnits(
          costInRewardTokens,
          GasCostEstimator.TOKEN_DECIMALS,
        ),
        minimumCost: minimumCost.toString(),
        formattedMinimumCost: ethers.formatUnits(
          minimumCost,
          GasCostEstimator.TOKEN_DECIMALS,
        ),
        isZero: costInRewardTokens === 0n,
        usesMinimum: costInRewardTokens < minimumCost,
      });

      // Add check for zero result
      if (costInRewardTokens === 0n) {
        this.logger.warn(
          'Gas cost in reward token calculated as zero, using minimum cost',
          {
            gasCostWei: gasCostWei.toString(),
            ethPrice: ethPrice.toString(),
            tokenPrice: tokenPrice.toString(),
            minimumCost: minimumCost.toString(),
          },
        );
        return minimumCost;
      }

      this.logger.info('Gas cost calculation details', {
        gasCostInTokens: ethers.formatUnits(
          costInRewardTokens,
          GasCostEstimator.TOKEN_DECIMALS,
        ),
        minimumCostInTokens: ethers.formatUnits(
          minimumCost,
          GasCostEstimator.TOKEN_DECIMALS,
        ),
        gasPriceGwei: Number(gasPriceWei) / 1e9,
        providedGasLimit: gasLimit.toString(),
        ethPriceUSD: Number(ethPrice) / 10 ** GasCostEstimator.ETH_DECIMALS,
        tokenPriceUSD:
          Number(tokenPrice) / 10 ** GasCostEstimator.TOKEN_DECIMALS,
        decimalAdjustment: decimalAdjustment.toString(),
        ethDecimals: GasCostEstimator.ETH_DECIMALS,
        tokenDecimals: GasCostEstimator.TOKEN_DECIMALS,
        usingCache: this.isCacheValid(),
      });

      const finalCost =
        costInRewardTokens > minimumCost ? costInRewardTokens : minimumCost;

      this.logger.info('Final gas cost', {
        costInTokens: ethers.formatUnits(
          finalCost,
          GasCostEstimator.TOKEN_DECIMALS,
        ),
        usingMinimum: finalCost === minimumCost,
      });

      return finalCost;
    } catch (error) {
      // Fallback to minimum USD value in tokens
      const fallbackCost = this.calculateMinimumGasCostInTokens(
        BigInt(
          Math.floor(
            GasCostEstimator.FALLBACK_TOKEN_PRICE_USD *
              10 ** GasCostEstimator.TOKEN_DECIMALS,
          ),
        ),
      );

      this.logger.warn('Using fallback gas cost', {
        costInTokens: ethers.formatUnits(
          fallbackCost,
          GasCostEstimator.TOKEN_DECIMALS,
        ),
        minimumUSD: GasCostEstimator.MINIMUM_GAS_COST_USD,
        reason: error instanceof Error ? error.message : String(error),
      });

      return fallbackCost;
    }
  }
}
