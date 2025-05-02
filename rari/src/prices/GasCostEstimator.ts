import { ethers } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';

export class GasCostEstimator {
  private readonly logger: Logger;

  constructor() {
    this.logger = new ConsoleLogger('info');
  }

  /**
   * Estimates the gas cost of claiming rewards in terms of reward tokens
   * Uses current gas price and configured price assumptions
   * @param provider - Ethereum provider to get gas prices
   * @returns Estimated gas cost denominated in reward tokens
   */
  async estimateGasCostInRewardToken(
    provider: ethers.Provider,
  ): Promise<bigint> {
    // Get current gas price and estimate gas cost
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? BigInt(0);
    const gasLimit = BigInt(300000); // Estimated gas limit for claim
    const gasCost = gasPrice * gasLimit;

    // Use hardcoded prices for testing
    // ETH price: $1800, Token price: $1
    // Scale prices to token decimals (18)
    const ethPriceInUsd = BigInt(1800); // $1800 per ETH
    const tokenPriceInUsd = BigInt(1); // $1 per token

    // Calculate gas cost in reward tokens
    // gasCost is in wei, convert to ETH by dividing by 1e18
    // Then multiply by price ratio (ethPrice/tokenPrice) to get token amount
    const gasCostInRewardTokens =
      (gasCost * ethPriceInUsd) / (tokenPriceInUsd * BigInt(1e18));

    this.logger.info('Estimated gas cost in reward tokens:', {
      gasPrice: ethers.formatUnits(gasPrice, 'gwei'),
      gasLimit: gasLimit.toString(),
      gasCostWei: gasCost.toString(),
      gasCostEth: ethers.formatEther(gasCost),
      ethPriceUsd: ethPriceInUsd.toString(),
      tokenPriceUsd: tokenPriceInUsd.toString(),
      gasCostInRewardTokens: gasCostInRewardTokens.toString(),
      gasCostInRewardTokensFormatted: ethers.formatEther(gasCostInRewardTokens),
    });

    return gasCostInRewardTokens;
  }
}
