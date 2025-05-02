import axios, { AxiosInstance } from 'axios';
import { BigNumberish, ethers } from 'ethers';
import { IPriceFeed, PriceFeedConfig, TokenPrice } from './interface';
import { Logger } from '@/monitor/logging';
import { ErrorLogger } from '@/configuration/errorLogger';

// Extend the PriceFeedConfig to include errorLogger
export interface ExtendedPriceFeedConfig extends PriceFeedConfig {
  errorLogger?: ErrorLogger;
}

interface CoinMarketCapQuote {
  USD: {
    price: number;
    last_updated: string;
  };
}

interface CoinMarketCapResponse {
  data: {
    [key: string]: {
      quote: CoinMarketCapQuote;
    };
  };
  status: {
    error_code: number;
    error_message: string | null;
  };
}

interface CoinMarketCapInfoResponse {
  data: {
    [address: string]: {
      id: number;
      name: string;
      symbol: string;
      slug: string;
      platform?: {
        token_address: string;
      };
    }[];
  };
  status: {
    error_code: number;
    error_message: string | null;
  };
}

export class CoinMarketCapFeed implements IPriceFeed {
  private readonly client: AxiosInstance;
  private readonly logger: Logger;
  private readonly errorLogger?: ErrorLogger;
  private readonly cache: Map<string, TokenPrice>;
  private readonly cacheDuration: number = 10 * 60 * 1000; // 10 minutes cache
  private readonly rewardToken: string;
  private readonly gasToken: string;
  private readonly idCache: Map<string, number>; // Cache for address -> CMC ID mapping
  private readonly symbolCache: Map<string, string>; // Cache for address -> symbol mapping

  constructor(config: ExtendedPriceFeedConfig, logger: Logger) {
    this.client = axios.create({
      baseURL: config.baseUrl || 'https://pro-api.coinmarketcap.com',
      timeout: config.timeout || 5000,
      headers: {
        'X-CMC_PRO_API_KEY': config.apiKey,
      },
    });
    this.logger = logger;
    this.errorLogger = config.errorLogger;
    this.cache = new Map();
    this.idCache = new Map();
    this.symbolCache = new Map();
    this.rewardToken = config.rewardToken || '';
    this.gasToken = config.gasToken || '';
  }

  /**
   * Gets the CoinMarketCap ID for a token using its contract address
   * @param tokenAddress The blockchain address of the token
   * @returns The CoinMarketCap ID for the token
   */
  private async getTokenId(tokenAddress: string): Promise<number> {
    // Check cache first
    const cachedId = this.idCache.get(tokenAddress.toLowerCase());
    if (cachedId) {
      return cachedId;
    }

    try {
      // Get token info by address using v2 endpoint
      this.logger.info('Fetching token info from CoinMarketCap', {
        tokenAddress,
      });

      // Step 1: Use the v2 cryptocurrency/info endpoint to get the CMC ID by address
      const infoResponse = await this.client.get<CoinMarketCapInfoResponse>(
        '/cryptocurrency/info',
        {
          params: {
            address: tokenAddress,
          },
        },
      );

      if (
        !infoResponse.data.data ||
        Object.keys(infoResponse.data.data).length === 0 ||
        infoResponse.data.status.error_code !== 0
      ) {
        const errorMsg = `No info found for token address ${tokenAddress}`;
        if (this.errorLogger) {
          await this.errorLogger.error(new Error(errorMsg), {
            context: 'coinmarketcap-get-token-info',
            tokenAddress,
            response: infoResponse.data,
          });
        }
        throw new Error(errorMsg);
      }

      // Get the first entry from the data object
      const addrKeys = Object.keys(infoResponse.data.data);
      if (addrKeys.length === 0) {
        const errorMsg = `No token info returned for address ${tokenAddress}`;
        if (this.errorLogger) {
          await this.errorLogger.error(new Error(errorMsg), {
            context: 'coinmarketcap-token-info-empty',
            tokenAddress,
          });
        }
        throw new Error(errorMsg);
      }

      const addrKey = addrKeys[0];
      const tokenInfoArray =
        infoResponse.data.data[addrKey as keyof typeof infoResponse.data.data];

      if (!tokenInfoArray || tokenInfoArray.length === 0) {
        const errorMsg = `No token info returned for address ${tokenAddress}`;
        if (this.errorLogger) {
          await this.errorLogger.error(new Error(errorMsg), {
            context: 'coinmarketcap-token-info-empty',
            tokenAddress,
          });
        }
        throw new Error(errorMsg);
      }

      // Use the first token in the array
      const tokenInfo = tokenInfoArray[0];
      if (!tokenInfo) {
        const errorMsg = `No token info data available for address ${tokenAddress}`;
        if (this.errorLogger) {
          await this.errorLogger.error(new Error(errorMsg), {
            context: 'coinmarketcap-token-info-missing',
            tokenAddress,
          });
        }
        throw new Error(errorMsg);
      }

      const tokenId = tokenInfo.id;
      if (!tokenId) {
        const errorMsg = `Invalid token ID received for address ${tokenAddress}`;
        if (this.errorLogger) {
          await this.errorLogger.error(new Error(errorMsg), {
            context: 'coinmarketcap-invalid-token-id',
            tokenAddress,
            tokenInfo,
          });
        }
        throw new Error(errorMsg);
      }

      this.logger.info('Successfully got CoinMarketCap ID for token', {
        tokenAddress,
        cmcId: tokenId,
        tokenName: tokenInfo.name,
        tokenSymbol: tokenInfo.symbol,
      });

      // Cache the results
      this.idCache.set(tokenAddress.toLowerCase(), tokenId);
      this.symbolCache.set(tokenAddress.toLowerCase(), tokenInfo.symbol);

      return tokenId;
    } catch (error) {
      this.logger.error('Failed to get CoinMarketCap ID for token address', {
        error,
        tokenAddress,
      });

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'coinmarketcap-get-token-id',
          tokenAddress,
        });
      }

      throw error;
    }
  }

  async getTokenPrice(tokenAddress: string): Promise<TokenPrice> {
    const cachedPrice = this.cache.get(tokenAddress);
    if (
      cachedPrice &&
      Date.now() - cachedPrice.lastUpdated.getTime() < this.cacheDuration
    ) {
      return cachedPrice;
    }

    try {
      // Step 1: Get the CoinMarketCap ID for the token
      const tokenId = await this.getTokenId(tokenAddress);

      this.logger.info('Fetching token price from CoinMarketCap', {
        tokenAddress,
        tokenId,
      });

      // Step 2: Fetch token quotes using the ID
      const response = await this.client.get<CoinMarketCapResponse>(
        '/cryptocurrency/quotes/latest',
        {
          params: {
            id: tokenId,
            convert: 'USD',
          },
        },
      );

      if (
        !response.data.data ||
        !response.data.data[tokenId.toString()] ||
        response.data.status.error_code !== 0
      ) {
        const errorMsg = `No price data available for token ID ${tokenId} (address: ${tokenAddress})`;
        if (this.errorLogger) {
          await this.errorLogger.error(new Error(errorMsg), {
            context: 'coinmarketcap-price-data-missing',
            tokenAddress,
            tokenId,
            response: response.data,
          });
        }
        throw new Error(errorMsg);
      }

      const tokenData = response.data.data[tokenId.toString()];
      if (!tokenData?.quote?.USD) {
        const errorMsg = `No USD quote available for token ID ${tokenId} (address: ${tokenAddress})`;
        if (this.errorLogger) {
          await this.errorLogger.error(new Error(errorMsg), {
            context: 'coinmarketcap-usd-quote-missing',
            tokenAddress,
            tokenId,
            tokenData,
          });
        }
        throw new Error(errorMsg);
      }

      const price = tokenData.quote.USD.price;
      const lastUpdated = new Date(tokenData.quote.USD.last_updated);

      this.logger.info('Successfully got token price', {
        tokenAddress,
        tokenId,
        price,
        lastUpdated,
      });

      const tokenPrice: TokenPrice = {
        usd: price,
        lastUpdated,
      };

      // Cache the results
      this.cache.set(tokenAddress, tokenPrice);

      return tokenPrice;
    } catch (error) {
      this.logger.error('Failed to fetch token price from CoinMarketCap', {
        error,
        tokenAddress,
      });

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'coinmarketcap-get-token-price',
          tokenAddress,
        });
      }

      throw error;
    }
  }

  async getTokenPriceInWei(
    tokenAddress: string,
    amount: BigNumberish,
  ): Promise<bigint> {
    try {
      const price = await this.getTokenPrice(tokenAddress);
      const amountInWei = ethers.parseEther(amount.toString());
      const priceInWei = ethers.parseEther(price.usd.toString());
      return (amountInWei * priceInWei) / ethers.parseEther('1');
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'coinmarketcap-get-token-price-in-wei',
          tokenAddress,
          amount: amount.toString(),
        });
      }
      throw error;
    }
  }

  /**
   * Gets both reward and gas token prices in a single call
   * @returns Object containing both token prices
   */
  async getTokenPrices(): Promise<{
    rewardToken: TokenPrice;
    gasToken: TokenPrice;
  }> {
    try {
      const [rewardTokenPrice, gasTokenPrice] = await Promise.all([
        this.getTokenPrice(this.rewardToken),
        this.getTokenPrice(this.gasToken),
      ]);

      return {
        rewardToken: rewardTokenPrice,
        gasToken: gasTokenPrice,
      };
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'coinmarketcap-get-token-prices',
          rewardToken: this.rewardToken,
          gasToken: this.gasToken,
        });
      }
      throw error;
    }
  }
}