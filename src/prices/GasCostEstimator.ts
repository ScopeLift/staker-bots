import { ethers } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { CoinMarketCapFeed } from './CoinmarketcapFeed';
import { CONFIG } from '../configuration';
import { EXECUTOR } from '@/configuration/constants';

export class GasCostEstimator {
  private readonly logger: Logger;
  private readonly priceFeed: CoinMarketCapFeed;

  constructor() {
    this.logger = new ConsoleLogger('info');

    // Configure CoinMarketCapFeed with proper token addresses
    this.priceFeed = new CoinMarketCapFeed(
      {
        ...CONFIG.priceFeed.coinmarketcap,
        rewardToken: CONFIG.govlst.address,
        gasToken: 'ETH',
      },
      this.logger,
    );
  }

  /**
   * Estimates the gas cost of claiming rewards in terms of reward tokens
   * Uses current gas price and configured price assumptions
   * @param provider - Ethereum provider to get gas prices
   * @param gasLimit - The gas limit to use for the estimate (will be capped at MAX_GAS_LIMIT)
   * @returns Estimated gas cost denominated in reward tokens
   */
  async estimateGasCostInRewardToken(
    provider: ethers.Provider,
    gasLimit: bigint,
  ): Promise<bigint> {
    // Always use the maximum gas limit for worst-case estimation
    // This ensures we don't underestimate gas costs
    const worstCaseGasLimit = EXECUTOR.GAS.MAX_GAS_LIMIT;
    
    this.logger.info('Estimating gas cost with worst-case gas limit', {
      providedGasLimit: gasLimit.toString(),
      worstCaseGasLimit: worstCaseGasLimit.toString(),
      using: "MAX_GAS_LIMIT for conservative estimation"
    });

    try {
      // Get current gas price
      const gasPrice = await provider.getFeeData().catch(e => {
        this.logger.warn('Failed to get gas price from provider, using fallback', {
          error: e instanceof Error ? e.message : String(e)
        });
        // Return null to trigger fallback
        return null;
      });
      
      // Use gas price or fallback to a conservative value (50 gwei)
      const gasPriceWei = gasPrice?.gasPrice 
        ? BigInt(gasPrice.gasPrice.toString()) 
        : 50_000_000_000n; // 50 gwei fallback
      
      this.logger.info('Using gas price for cost calculation', {
        gasPriceWei: gasPriceWei.toString(),
        gasPriceGwei: (Number(gasPriceWei) / 1e9).toFixed(2),
        source: gasPrice?.gasPrice ? 'network' : 'fallback (50 gwei)'
      });

      // Calculate total gas cost in wei using worst-case gas limit
      const gasCostWei = gasPriceWei * worstCaseGasLimit;

      // Get token prices with fallback
      let prices;
      try {
        prices = await this.priceFeed.getTokenPrices();
        
        this.logger.info('Price feed data for gas cost calculation', {
          ethPriceUSD: prices.gasToken.usd.toString(),
          tokenPriceUSD: prices.rewardToken.usd.toString(),
          gasCostWei: gasCostWei.toString(),
          gasLimit: worstCaseGasLimit.toString(),
          gasPriceWei: gasPriceWei.toString(),
        });
      } catch (priceError) {
        this.logger.error('Failed to get token prices, using conservative fallback values', {
          error: priceError instanceof Error ? priceError.message : String(priceError)
        });
        
        // Use conservative fallback values (ETH=$2500, token=$0.10)
        prices = {
          gasToken: { usd: 2500 },
          rewardToken: { usd: 0.1 }
        };
        
        this.logger.info('Using fallback price assumptions', {
          ethPriceUSD: prices.gasToken.usd,
          tokenPriceUSD: prices.rewardToken.usd,
          gasCostWei: gasCostWei.toString(),
          source: 'fallback values'
        });
      }

      // Ensure we're working with BigInt values throughout
      const ethPriceScaled = BigInt(Math.floor(Number(prices.gasToken.usd) * 1e18));
      const tokenPriceScaled = BigInt(Math.floor(Number(prices.rewardToken.usd) * 1e18));

      // Make sure we don't divide by zero or very small token price
      if (tokenPriceScaled === 0n || tokenPriceScaled < 100000000000n) { // Minimum price of 0.0000001
        this.logger.warn('Token price is too low, using conservative fallback ratio', {
          tokenPrice: tokenPriceScaled.toString(),
          ethPrice: ethPriceScaled.toString(),
        });
        
        // Use a very conservative 10000:1 ratio (assumes ETH is worth 10000x the token)
        const fallbackTokenCost = gasCostWei * 10000n;
        
        this.logger.info('Using extremely conservative price ratio fallback', {
          gasCostWei: gasCostWei.toString(),
          gasCostEther: ethers.formatEther(gasCostWei),
          fallbackTokenCost: fallbackTokenCost.toString(),
          ratio: '10000:1 (ETH:token)'
        });
        
        return fallbackTokenCost;
      }

      // Calculate the cost in reward tokens: (gas cost in wei * ETH price) / token price
      const costInRewardTokens = (gasCostWei * ethPriceScaled) / tokenPriceScaled;

      this.logger.info('Gas cost in reward tokens', {
        ethPriceUSD: (Number(ethPriceScaled) / 1e18).toFixed(2),
        tokenPriceUSD: (Number(tokenPriceScaled) / 1e18).toFixed(8),
        gasCostInTokens: ethers.formatEther(costInRewardTokens),
        gasCostWei: gasCostWei.toString(),
        gasCostEther: ethers.formatEther(gasCostWei),
        priceRatio: (Number(ethPriceScaled) / Number(tokenPriceScaled)).toFixed(2)
      });

      return costInRewardTokens;
    } catch (error) {
      this.logger.error('Failed to estimate gas cost', { 
        error,
        message: error instanceof Error ? error.message : String(error),
        gasLimit: worstCaseGasLimit.toString()
      });
      
      // Last resort fallback: use a very conservative estimate based on gas limit
      try {
        // Assume a 5000:1 price ratio between ETH and token as absolute worst case
        // and a very high gas price of 200 gwei
        const emergencyGasPrice = 200_000_000_000n; // 200 gwei
        const gasCostWei = emergencyGasPrice * worstCaseGasLimit;
        const conservativePriceRatio = 5000n; // ETH is worth 5000x the token (extremely conservative)
        
        const fallbackTokenCost = (gasCostWei * conservativePriceRatio) / 10n ** 18n;
        
        this.logger.info('Using emergency fallback gas cost calculation', {
          emergencyGasPrice: emergencyGasPrice.toString(),
          gasCostWei: gasCostWei.toString(),
          conservativePriceRatio: conservativePriceRatio.toString(),
          fallbackTokenCost: fallbackTokenCost.toString(),
          worstCaseGasLimit: worstCaseGasLimit.toString()
        });
        
        // Ensure we return a non-zero value
        return fallbackTokenCost > 0n ? fallbackTokenCost : 10n ** 18n; // At least 1 token
      } catch (fallbackError) {
        // If even the fallback calculations fail, return a hardcoded conservative amount
        this.logger.error('Emergency fallback calculation failed, using hardcoded value', {
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        });
        
        // Return 100 tokens as an absolute last resort
        return 100n * 10n ** 18n;
      }
    }
  }
}
