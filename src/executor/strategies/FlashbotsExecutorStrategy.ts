import { ethers } from 'ethers';
import { Logger } from '@/monitor/logging';
import { ErrorLogger } from '@/configuration/errorLogger';
import { sleep } from './helpers';

/**
 * Flashbots executor strategy using the Flashbots RPC endpoint
 * This strategy uses the Flashbots Protect RPC to send transactions directly to builders
 * bypassing the public mempool to prevent frontrunning
 */
export class FlashbotsExecutorStrategy {
  private readonly flashbotsRpcUrl: string;
  private flashbotsProvider: ethers.JsonRpcProvider | null = null;

  constructor(
    private readonly provider: ethers.Provider,
    private readonly signer: ethers.Signer,
    private readonly logger: Logger,
    private readonly errorLogger?: ErrorLogger,
    private readonly maxAttempts: number = 5,
    config?: {
      rpcUrl?: string;
      chainId?: number;
      fast?: boolean;
    },
  ) {
    // Determine which RPC endpoint to use based on chain ID and speed preference
    const chainId = config?.chainId || 1; // Default to mainnet
    const useFastMode = config?.fast !== false; // Default to fast mode

    if (config?.rpcUrl) {
      this.flashbotsRpcUrl = config.rpcUrl;
    } else {
      // Use the appropriate Flashbots Protect RPC URL based on chain ID
      switch (chainId) {
        case 1: // Ethereum Mainnet
          this.flashbotsRpcUrl = useFastMode
            ? 'https://rpc.flashbots.net/fast'
            : 'https://rpc.flashbots.net';
          break;
        case 5: // Goerli Testnet
          this.flashbotsRpcUrl = 'https://rpc-goerli.flashbots.net/';
          break;
        case 11155111: // Sepolia Testnet
          this.flashbotsRpcUrl = 'https://rpc-sepolia.flashbots.net/';
          break;
        case 17000: // Holesky Testnet
          this.flashbotsRpcUrl = 'https://rpc-holesky.flashbots.net/';
          break;
        default:
          this.flashbotsRpcUrl = 'https://rpc.flashbots.net/fast'; // Default to mainnet fast mode
      }
    }

    // Initialize the provider
    this.initialize();
  }

  /**
   * Initialize the Flashbots provider
   */
  private async initialize(): Promise<void> {
    try {
      this.logger.info('Initializing Flashbots provider...', {
        rpcUrl: this.flashbotsRpcUrl,
      });
      this.flashbotsProvider = new ethers.JsonRpcProvider(this.flashbotsRpcUrl);
      this.logger.info('Flashbots provider initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Flashbots provider:', { error });
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'flashbots-initialize',
        });
      }
      // Don't throw - we'll fall back to regular transaction submission
      this.flashbotsProvider = null;
    }
  }

  /**
   * Ensure Flashbots provider is initialized
   */
  private async ensureProviderInitialized(): Promise<boolean> {
    if (!this.flashbotsProvider) {
      await this.initialize();
    }
    return this.flashbotsProvider !== null;
  }

  /**
   * Submit a transaction via Flashbots
   * @param transaction The transaction request to submit
   * @returns The transaction hash if successful, null otherwise
   */
  public async submitTransaction(
    transaction: ethers.TransactionRequest,
  ): Promise<string | null> {
    const isInitialized = await this.ensureProviderInitialized();
    if (!isInitialized || !this.flashbotsProvider) {
      this.logger.warn(
        'Flashbots provider not initialized, skipping MEV protection',
      );
      return null;
    }

    try {
      // Sign the transaction with the provided signer
      const signedTx = await this.signer.signTransaction(transaction);

      // Send the signed transaction to Flashbots
      this.logger.info('Submitting transaction via Flashbots', {
        to: transaction.to,
        value: transaction.value?.toString() || '0',
        gasLimit: transaction.gasLimit?.toString(),
      });

      // Send the raw transaction to Flashbots
      const txHash = await this.flashbotsProvider.send(
        'eth_sendRawTransaction',
        [signedTx],
      );

      if (txHash) {
        this.logger.info('Transaction submitted via Flashbots', { txHash });

        // Wait for transaction confirmation
        let confirmed = false;
        let attempts = 0;
        const maxAttempts = this.maxAttempts;

        while (!confirmed && attempts < maxAttempts) {
          await sleep(3000); // Wait 3 seconds between checks

          try {
            const receipt = await this.provider.getTransactionReceipt(txHash);
            if (receipt) {
              this.logger.info('Transaction confirmed via Flashbots', {
                txHash,
                blockNumber: receipt.blockNumber,
              });
              confirmed = true;
              return txHash;
            }
          } catch (error) {
            this.logger.warn('Error checking transaction receipt', {
              error,
              txHash,
              attempt: attempts + 1,
            });
          }

          attempts++;
          if (attempts >= maxAttempts) {
            this.logger.warn(
              'Max attempts reached waiting for transaction confirmation',
              {
                txHash,
                attempts,
              },
            );
          }
        }

        // Transaction was submitted but not confirmed within timeout
        return txHash;
      } else {
        this.logger.warn(
          'Failed to submit transaction via Flashbots - no txHash returned',
        );
        return null;
      }
    } catch (error) {
      this.logger.error('Error submitting via Flashbots:', { error });
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'flashbots-submission',
        });
      }
      return null;
    }
  }

  /**
   * Get the Flashbots provider
   * @returns The Flashbots provider
   */
  public getProvider(): ethers.JsonRpcProvider | null {
    return this.flashbotsProvider;
  }

  /**
   * Estimate gas for a transaction
   * @param transaction The transaction to estimate gas for
   * @returns The estimated gas as a bigint if successful, null otherwise
   */
  public async estimateGas(
    transaction: ethers.TransactionRequest,
  ): Promise<bigint | null> {
    const isInitialized = await this.ensureProviderInitialized();
    if (!isInitialized || !this.flashbotsProvider) {
      return null;
    }

    try {
      const gasEstimate = await this.flashbotsProvider.estimateGas(transaction);
      return gasEstimate;
    } catch (error) {
      this.logger.error('Error estimating gas via Flashbots:', { error });
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'flashbots-gas-estimation',
        });
      }
      return null;
    }
  }
}
