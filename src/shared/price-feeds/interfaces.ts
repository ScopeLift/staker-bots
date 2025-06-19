import { BigNumberish } from 'ethers';

export interface TokenPrice {
  usd: number;
  lastUpdated: Date;
}

export interface IPriceFeed {
  getTokenPrice(tokenAddress: string): Promise<TokenPrice>;
  getTokenPriceInWei(
    tokenAddress: string,
    amount: BigNumberish,
  ): Promise<bigint>;
}

export interface PriceFeedConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  retries?: number;
  arbTestTokenAddress?: string;
  arbRealTokenAddress?: string;
}
