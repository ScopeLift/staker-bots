import { ethers } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { CoinMarketCapFeed } from './CoinmarketcapFeed';
import { CONFIG } from '../configuration';

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
   * @returns Estimated gas cost denominated in reward tokens
   */
  async estimateGasCostInRewardToken(
    provider: ethers.Provider,
    gasLimit: bigint,
  ): Promise<bigint> {
    try {
      // Get current gas price
      const gasPrice = await provider.getFeeData();
      if (!gasPrice.gasPrice) throw new Error('Failed to get gas price');

      // Calculate total gas cost in wei
      const gasCost = gasPrice.gasPrice * gasLimit;

      // Get token prices
      const prices = await this.priceFeed.getTokenPrices();

      this.logger.info('Price feed data for gas cost calculation', {
        ethPriceUSD: prices.gasToken.usd.toString(),
        tokenPriceUSD: prices.rewardToken.usd.toString(),
        gasCostWei: gasCost.toString(),
        gasLimit: gasLimit.toString(),
        gasPriceWei: gasPrice.gasPrice.toString(),
      });

      // Convert gas cost to reward tokens:
      // 1. gasCost (in wei) * ethPriceUSD = cost in USD (scaled by 1e18)
      // 2. cost in USD / tokenPriceUSD = cost in reward tokens (scaled by 1e18)
      // 3. Final result needs to be in reward token decimals
      
      // Ensure we're working with BigInt values throughout
      const ethPriceScaled = BigInt(Math.floor(Number(prices.gasToken.usd) * 1e18));
      const tokenPriceScaled = BigInt(Math.floor(Number(prices.rewardToken.usd) * 1e18));

      // Make sure we don't divide by zero
      if (tokenPriceScaled === 0n) {
        throw new Error('Token price is zero');
      }

      const costInRewardTokens = (gasCost * ethPriceScaled) / tokenPriceScaled;

      this.logger.info('Calculated gas cost in reward tokens', {
        costInRewardTokens: costInRewardTokens.toString(),
        ethPriceScaled: ethPriceScaled.toString(),
        tokenPriceScaled: tokenPriceScaled.toString(),
      });

      return costInRewardTokens;
    } catch (error) {
      this.logger.error('Failed to estimate gas cost', { 
        error,
        message: error instanceof Error ? error.message : String(error)
      });
      // Return a default value instead of throwing
      return BigInt(0);
    }
  }
}
