import { ethers } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { IExecutor } from '../interfaces/IExecutor';
import {
  ExecutorConfig,
  QueuedTransaction,
  TransactionStatus,
  QueueStats,
  TransactionReceipt,
} from '../interfaces/types';
import { ProfitabilityCheck } from '@/profitability/interfaces/types';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseWrapper } from '@/database';
import { Interface } from 'ethers';
import { TransactionQueueStatus } from '@/database/interfaces/types';

/**
 * Base implementation of the executor using a direct wallet.
 * Handles transaction queueing, execution, and monitoring.
 */
export class BaseExecutor implements IExecutor {
  protected readonly logger: Logger;
  protected readonly wallet: ethers.Wallet;
  protected readonly queue: Map<string, QueuedTransaction>;
  protected isRunning: boolean;
  protected processingInterval: NodeJS.Timeout | null;
  protected db?: DatabaseWrapper;
  protected stakerContract: ethers.Contract;
  protected readonly contractAddress: string;
  protected readonly contractInterface: Interface;
  protected readonly provider: ethers.Provider;
  protected readonly config: ExecutorConfig;

  /**
   * Creates a new BaseExecutor instance
   * @param params Constructor parameters
   */
  constructor({
    contractAddress,
    contractInterface,
    provider,
    config,
  }: {
    contractAddress: string;
    contractInterface: Interface;
    provider: ethers.Provider;
    config: ExecutorConfig;
  }) {
    if (!provider) {
      throw new Error('Provider is required');
    }

    this.logger = new ConsoleLogger('info');
    this.wallet = new ethers.Wallet(config.wallet.privateKey, provider);
    this.queue = new Map();
    this.isRunning = false;
    this.processingInterval = null;
    this.contractAddress = contractAddress;
    this.contractInterface = contractInterface;
    this.provider = provider;
    this.config = config;

    // Create contract with wallet directly
    this.stakerContract = new ethers.Contract(
      contractAddress,
      contractInterface,
      this.wallet,
    );

    // Validate staker contract
    if (!this.stakerContract.interface.hasFunction('bumpEarningPower')) {
      throw new Error(
        'Invalid staker contract: missing bumpEarningPower function',
      );
    }
  }

  /**
   * Set the database instance for transaction queue management
   */
  setDatabase(db: DatabaseWrapper): void {
    this.db = db;
    this.logger.info('Database set for executor');
  }

  /**
   * Get the wallet balance
   */
  protected async getWalletBalance(): Promise<bigint> {
    return (await this.provider.getBalance(this.wallet.address)) || BigInt(0);
  }

  /**
   * Start the executor service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.logger.info('Executor started');

    // Start processing queue periodically as a backup
    this.processingInterval = setInterval(
      () => this.processQueue(true),
      5000, // Process queue every 5 seconds as a backup
    );

    // Also check for transactions in the DB transaction queue that need to be executed
    setInterval(() => {
      this.checkDatabaseTransactionQueue().catch((error) => {
        this.logger.error('Error checking database transaction queue:', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 15000); // Check database queue every 15 seconds

    this.logger.info('Queue processing intervals started');
  }

  /**
   * Stop the executor service
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    this.logger.info('Executor stopped');
  }

  /**
   * Get the current status of the executor
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    walletBalance: bigint;
    pendingTransactions: number;
    queueSize: number;
  }> {
    const balance = await this.getWalletBalance();
    const pendingTxs = Array.from(this.queue.values()).filter(
      (tx) => tx.status === TransactionStatus.PENDING,
    ).length;

    return {
      isRunning: this.isRunning,
      walletBalance: balance,
      pendingTransactions: pendingTxs,
      queueSize: this.queue.size,
    };
  }

  /**
   * Queue a transaction for execution
   */
  async queueTransaction(
    depositId: bigint,
    profitability: ProfitabilityCheck,
    txData?: string,
  ): Promise<QueuedTransaction> {
    // Check queue size
    if (this.queue.size >= this.config.maxQueueSize) {
      throw new Error('Queue is full');
    }

    // Create transaction object
    const tx: QueuedTransaction = {
      id: uuidv4(),
      depositId,
      profitability,
      status: TransactionStatus.QUEUED,
      createdAt: new Date(),
      tx_data: txData,
    };

    // Add to queue
    this.queue.set(tx.id, tx);
    this.logger.info('Transaction queued:', {
      id: tx.id,
      depositId: tx.depositId.toString(),
      hasTxData: !!txData,
    });

    // Process queue immediately if running
    if (this.isRunning) {
      // Use setImmediate to avoid blocking the current call stack
      setImmediate(() => this.processQueue(false));
    }

    return tx;
  }

  /**
   * Get statistics about the transaction queue
   */
  async getQueueStats(): Promise<QueueStats> {
    const txs = Array.from(this.queue.values());
    const confirmedTxs = txs.filter(
      (tx) => tx.status === TransactionStatus.CONFIRMED,
    );

    const totalProfits = confirmedTxs.reduce(
      (sum, tx) => sum + tx.profitability.estimates.expectedProfit,
      BigInt(0),
    );

    const avgGasPrice =
      confirmedTxs.length > 0
        ? confirmedTxs.reduce(
            (sum, tx) => sum + (tx.gasPrice || BigInt(0)),
            BigInt(0),
          ) / BigInt(confirmedTxs.length)
        : BigInt(0);

    const avgExecTime =
      confirmedTxs.length > 0
        ? confirmedTxs.reduce((sum, tx) => {
            const execTime = tx.executedAt
              ? tx.executedAt.getTime() - tx.createdAt.getTime()
              : 0;
            return sum + execTime;
          }, 0) / confirmedTxs.length
        : 0;

    return {
      totalQueued: txs.filter((tx) => tx.status === TransactionStatus.QUEUED)
        .length,
      totalPending: txs.filter((tx) => tx.status === TransactionStatus.PENDING)
        .length,
      totalConfirmed: confirmedTxs.length,
      totalFailed: txs.filter((tx) => tx.status === TransactionStatus.FAILED)
        .length,
      averageExecutionTime: avgExecTime,
      averageGasPrice: avgGasPrice,
      totalProfits,
    };
  }

  /**
   * Get a specific transaction by ID
   */
  async getTransaction(id: string): Promise<QueuedTransaction | null> {
    return this.queue.get(id) || null;
  }

  /**
   * Get transaction receipt
   */
  async getTransactionReceipt(
    hash: string,
  ): Promise<TransactionReceipt | null> {
    const receipt = await this.provider.getTransactionReceipt(hash);
    if (!receipt) {
      return null;
    }

    return {
      hash: receipt.hash,
      status: receipt.status === 1,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice || BigInt(0),
    };
  }

  /**
   * Transfer accumulated tips to the configured receiver
   */
  async transferOutTips(): Promise<TransactionReceipt | null> {
    const balance = await this.getWalletBalance();
    if (balance < this.config.transferOutThreshold) {
      return null;
    }

    try {
      // Calculate transfer amount (leave some ETH for gas)
      const feeData = await this.provider.getFeeData();
      const baseGasPrice = feeData.gasPrice || BigInt(0);
      const boostMultiplier =
        BigInt(100 + this.config.gasBoostPercentage) / BigInt(100);
      const gasPrice = baseGasPrice * boostMultiplier;

      // Make sure our gas price is at least equal to the base fee
      const baseFeePerGas = feeData.maxFeePerGas || baseGasPrice;
      const finalGasPrice =
        gasPrice > baseFeePerGas ? gasPrice : baseFeePerGas + BigInt(1_000_000);

      const gasLimit = BigInt(21000); // Standard ETH transfer
      const gasCost = gasLimit * finalGasPrice;
      const transferAmount = balance - gasCost;

      if (transferAmount <= 0) {
        return null;
      }

      // Get tip receiver from config or use default
      const tipReceiver = this.config.defaultTipReceiver || this.wallet.address;

      // Send transaction
      const tx = await this.wallet.sendTransaction({
        to: tipReceiver,
        value: transferAmount,
        gasLimit,
        gasPrice: finalGasPrice,
      });

      this.logger.info('Transferred tips:', {
        hash: tx.hash,
        amount: transferAmount.toString(),
        receiver: tipReceiver,
      });

      const receipt = await tx.wait();
      if (!receipt) {
        return null;
      }

      return {
        hash: receipt.hash,
        status: receipt.status === 1,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.gasPrice || BigInt(0),
      };
    } catch (error) {
      this.logger.error('Failed to transfer tips:', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Clear the transaction queue
   */
  async clearQueue(): Promise<void> {
    this.queue.clear();
    this.logger.info('Transaction queue cleared');
  }

  /**
   * Process the transaction queue
   */
  protected async processQueue(
    isPeriodicCheck: boolean = false,
  ): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Only process if there are queued transactions
    const queuedTxs = Array.from(this.queue.values()).filter(
      (tx) => tx.status === TransactionStatus.QUEUED,
    );

    if (queuedTxs.length === 0 && isPeriodicCheck) {
      // If this is just a periodic check and there are no queued txs, return early
      return;
    }

    // Check how many pending transactions we have
    const pendingTxCount = Array.from(this.queue.values()).filter(
      (tx) => tx.status === TransactionStatus.PENDING,
    ).length;

    // If we have too many pending transactions, don't execute more
    if (pendingTxCount >= this.config.wallet.maxPendingTransactions) {
      this.logger.info('Too many pending transactions, skipping execution');
      return;
    }

    // Process up to concurrentTransactions at a time
    const toProcess = queuedTxs.slice(0, this.config.concurrentTransactions);
    for (const tx of toProcess) {
      this.executeTransaction(tx).catch((error) => {
        this.logger.error('Error executing transaction', {
          txId: tx.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  /**
   * Execute a transaction
   */
  protected async executeTransaction(tx: QueuedTransaction): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Double-check status
    if (tx.status !== TransactionStatus.QUEUED) {
      return;
    }

    try {
      // Update status to pending
      tx.status = TransactionStatus.PENDING;
      tx.executedAt = new Date();
      this.logger.info('Executing transaction', { id: tx.id });
      
      // Check if contract is properly initialized
      if (!this.stakerContract || typeof this.stakerContract.bumpEarningPower !== 'function') {
        throw new Error('Contract not properly initialized or missing bumpEarningPower method');
      }

      // Get queue item ID from txData
      let queueItemId: string | undefined;
      if (tx.tx_data) {
        try {
          // Check if tx_data is a JSON string
          if (tx.tx_data.startsWith('{')) {
            const txData = JSON.parse(tx.tx_data);
            queueItemId = txData.id;
          }
        } catch (error) {
          // Not JSON data, continue with normal execution
          this.logger.debug('tx_data is not JSON', {
            txData: tx.tx_data.substring(0, 20) + '...',
          });
        }
      }

      // Update database with pending status first
      if (this.db && queueItemId) {
        try {
          await this.db.updateTransactionQueueItem(queueItemId, {
            status: TransactionQueueStatus.PENDING,
          });
          this.logger.info('Updated transaction queue item status to PENDING', {
            queueItemId,
          });
        } catch (error) {
          this.logger.error('Failed to update transaction queue item status', {
            error: error instanceof Error ? error.message : String(error),
            queueItemId,
          });
        }
      }

      // Get gas price with boost applied
      const feeData = await this.provider.getFeeData();
      const baseGasPrice = feeData.gasPrice || BigInt(0);
      const boostMultiplier =
        BigInt(100 + this.config.gasBoostPercentage) / BigInt(100);
      let gasPrice = baseGasPrice * boostMultiplier;

      // Make sure our gas price is at least equal to the base fee
      const baseFeePerGas = feeData.maxFeePerGas || baseGasPrice;
      if (gasPrice < baseFeePerGas) {
        gasPrice = baseFeePerGas + BigInt(1_000_000); // Add 1 gwei buffer
      }

      // Log fee data
      this.logger.info('Network fee data:', {
        gasPrice: gasPrice.toString(),
        baseFeePerGas: baseFeePerGas.toString(),
        boostMultiplier: boostMultiplier.toString(),
      });

      // Wallet balance check
      const balance = await this.getWalletBalance();
      if (balance < this.config.wallet.minBalance) {
        throw new Error(
          `Wallet balance too low: ${balance.toString()} < ${this.config.wallet.minBalance.toString()}`,
        );
      }

      // Prepare and execute transaction
      let txResponse;
      if (tx.tx_data) {
        // If we have pre-built transaction data, validate and use it
        if (!tx.tx_data.startsWith('0x')) {
          // Check if this might be JSON data
          try {
            // If tx_data is JSON, assume it contains transaction metadata
            const txMetadata = JSON.parse(tx.tx_data);
            
            // Log the parsed metadata
            this.logger.info('Parsed tx_data as JSON metadata', {
              hasDepositId: !!txMetadata.depositId,
              hasTipReceiver: !!txMetadata.tipReceiver,
              hasTipAmount: !!txMetadata.tipAmount,
            });
            
            // Execute via contract method using the depositId
            const depositId = BigInt(txMetadata.depositId || tx.depositId.toString());
            
            // Use the contract's bumpEarningPower method directly
            let gasLimit: bigint;
            try {
              gasLimit = await this.stakerContract.bumpEarningPower.estimateGas(depositId);
              // Add 20% buffer for safety
              gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
            } catch (error) {
              this.logger.error('Failed to estimate gas', {
                error: error instanceof Error ? error.message : String(error),
                depositId: depositId.toString(),
              });
              // Use a default gas limit as fallback
              gasLimit = BigInt(300000);
            }
            
            // Execute transaction
            txResponse = await this.stakerContract.bumpEarningPower(depositId, {
              gasLimit,
              gasPrice,
            });
          } catch (error) {
            this.logger.error('Failed to parse tx_data as JSON, and it\'s not hex data', {
              error: error instanceof Error ? error.message : String(error),
              tx_data_prefix: tx.tx_data.substring(0, 20),
            });
            throw new Error('Invalid transaction data format');
          }
        } else {
          // It's hex data, check if it's a call to bumpEarningPower
          const functionSelector = tx.tx_data.slice(0, 10);
          
          // Safely check if it's a bumpEarningPower function call
          let isBumpFunction = false;
          try {
            const bumpFunction = this.contractInterface.getFunction('bumpEarningPower(uint256)');
            // Check if bumpFunction exists and has a selector property before comparison
            isBumpFunction = !!bumpFunction && 
                            typeof bumpFunction.selector === 'string' && 
                            bumpFunction.selector === functionSelector;
          } catch (error) {
            this.logger.error('Failed to get bumpEarningPower function selector', {
              error: error instanceof Error ? error.message : String(error),
            });
            // Not a bumpEarningPower function call
            isBumpFunction = false;
          }
          
          if (isBumpFunction) {
            // Decode the function data to get the depositId
            let depositId: bigint;
            try {
              const decoded = this.contractInterface.decodeFunctionData(
                'bumpEarningPower',
                tx.tx_data
              );
              depositId = (decoded && decoded.length > 0) 
                ? BigInt(decoded[0].toString()) 
                : tx.depositId;
            } catch (error) {
              this.logger.error('Failed to decode function data', {
                error: error instanceof Error ? error.message : String(error),
              });
              // Fallback to the deposit ID from the transaction
              depositId = tx.depositId;
            }
            
            // Estimate gas
            let gasLimit: bigint;
            try {
              gasLimit = await this.stakerContract.bumpEarningPower.estimateGas(depositId);
              // Add 20% buffer for safety
              gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
            } catch (error) {
              this.logger.error('Failed to estimate gas', {
                error: error instanceof Error ? error.message : String(error),
                depositId: depositId.toString(),
              });
              gasLimit = BigInt(300000); // Safe default
            }
            
            // Execute transaction
            txResponse = await this.stakerContract.bumpEarningPower(depositId, {
              gasLimit,
              gasPrice,
            });
          } else {
            // Generic transaction with raw hex data
            this.logger.info('Sending raw transaction with hex data', {
              to: this.contractAddress,
              data_prefix: tx.tx_data.substring(0, 20) + '...'
            });
            
            // Estimate gas
            let gasLimit: bigint;
            try {
              gasLimit = await this.provider.estimateGas({
                to: this.contractAddress,
                data: tx.tx_data,
                from: this.wallet.address,
              });
              // Add 20% buffer for safety
              gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
            } catch (error) {
              this.logger.error('Failed to estimate gas for raw transaction', {
                error: error instanceof Error ? error.message : String(error),
              });
              gasLimit = BigInt(300000); // Safe default
            }
            
            // Send raw transaction
            txResponse = await this.wallet.sendTransaction({
              to: this.contractAddress,
              data: tx.tx_data,
              gasLimit,
              gasPrice,
            });
          }
        }
      } else {
        // No pre-built transaction data, build bump transaction for the deposit ID
        const depositId = tx.depositId;
        
        // Estimate gas for the bump
        let gasLimit: bigint;
        try {
          gasLimit = await this.stakerContract.bumpEarningPower.estimateGas(depositId);
          // Add 20% buffer for safety
          gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
        } catch (error) {
          this.logger.error('Failed to estimate gas', {
            error: error instanceof Error ? error.message : String(error),
            depositId: depositId.toString(),
          });
          // Use a default gas limit as fallback
          gasLimit = BigInt(300000);
        }
        
        // Execute transaction via contract
        this.logger.info('Executing bumpEarningPower via contract', {
          depositId: depositId.toString(),
          gasLimit: gasLimit.toString(),
          gasPrice: gasPrice.toString(),
        });
        
        txResponse = await this.stakerContract.bumpEarningPower(depositId, {
          gasLimit,
          gasPrice,
        });
      }

      // Check if we have a valid transaction response
      if (!txResponse || !txResponse.hash) {
        throw new Error('Transaction failed - no transaction hash received');
      }

      // Store transaction info
      tx.hash = txResponse.hash;
      tx.gasPrice = gasPrice;
      this.logger.info('Transaction sent', {
        id: tx.id,
        hash: tx.hash,
        depositId: tx.depositId.toString(),
        gasPrice: gasPrice.toString(),
      });

      // Wait for transaction to be mined
      const receipt = await txResponse.wait(this.config.minConfirmations);
      if (!receipt) {
        throw new Error('Transaction receipt not received');
      }

      // Update transaction status
      tx.status = TransactionStatus.CONFIRMED;
      this.logger.info('Transaction confirmed', {
        id: tx.id,
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
      });
      
      // Update database if needed
      if (this.db && queueItemId) {
        try {
          await this.db.updateTransactionQueueItem(queueItemId, {
            status: TransactionQueueStatus.CONFIRMED,
            hash: receipt.hash,
          });
          this.logger.info('Updated transaction queue item to CONFIRMED', {
            queueItemId,
            hash: receipt.hash,
          });
        } catch (error) {
          this.logger.error('Failed to update transaction queue status', {
            error: error instanceof Error ? error.message : String(error),
            queueItemId,
          });
        }
      }
    } catch (error) {
      // Handle execution error
      tx.status = TransactionStatus.FAILED;
      tx.error = error as Error;
      tx.retryCount = (tx.retryCount || 0) + 1;

      // Log the error
      this.logger.error('Transaction execution failed', {
        id: tx.id,
        depositId: tx.depositId.toString(), 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      // If we have retries left, requeue the transaction
      if (tx.retryCount < this.config.maxRetries) {
        this.logger.info('Requeuing failed transaction', {
          id: tx.id,
          retryCount: tx.retryCount,
          error: error instanceof Error ? error.message : String(error),
        });

        // Delay retries using an exponential backoff
        const delayMs = this.config.retryDelayMs * Math.pow(2, tx.retryCount - 1);
        setTimeout(() => {
          // Reset status to QUEUED for retry
          tx.status = TransactionStatus.QUEUED;
          // Process queue to pick up the retry
          this.processQueue(false);
        }, delayMs);
      } else {
        this.logger.error('Transaction failed permanently', {
          id: tx.id,
          error: error instanceof Error ? error.message : String(error),
        });
        
        // Update database if needed
        if (this.db && tx.tx_data) {
          try {
            // Try to parse tx_data for queue item ID
            const parseResult = tx.tx_data.startsWith('{') ? JSON.parse(tx.tx_data) : null;
            if (parseResult && parseResult.id) {
              await this.db.updateTransactionQueueItem(parseResult.id, {
                status: TransactionQueueStatus.FAILED,
                error: error instanceof Error ? error.message : String(error),
              });
              this.logger.info('Updated transaction queue item to FAILED', {
                queueItemId: parseResult.id,
              });
            }
          } catch (e) {
            // Ignore JSON parse errors
            this.logger.debug('Failed to parse tx_data for queue ID', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
    }
  }

  /**
   * Calculate function selector for a given function name and parameter types
   */
  protected calculateFunctionSelector(
    functionName: string,
    paramTypes: string[],
  ): string {
    // Create the function signature
    const signature = `${functionName}(${paramTypes.join(',')})`;
    // Calculate the selector
    const selector = ethers.keccak256(ethers.toUtf8Bytes(signature)).slice(0, 10);
    return selector;
  }

  /**
   * Check for transactions in the database queue that need to be executed
   */
  protected async checkDatabaseTransactionQueue(): Promise<void> {
    if (!this.db || !this.isRunning) {
      return;
    }

    try {
      // Get queued transactions from database
      const queueItems = await this.db.getTransactionQueueItemsByStatus(
        TransactionQueueStatus.PENDING
      );

      if (queueItems.length === 0) {
        return;
      }

      this.logger.info('Found database queue items', {
        count: queueItems.length,
      });

      // Process each transaction
      for (const item of queueItems) {
        if (!item || !item.deposit_id) {
          continue;
        }

        // Skip if we already have this transaction in our queue
        const existingTx = Array.from(this.queue.values()).find(
          (tx) =>
            tx.depositId.toString() === item.deposit_id &&
            tx.status !== TransactionStatus.FAILED,
        );

        if (existingTx) {
          this.logger.info('Transaction already in local queue', {
            depositId: item.deposit_id,
          });
          continue;
        }

        try {
          // Mark as processing in database
          await this.db.updateTransactionQueueItem(
            item.id,
            {
              status: TransactionQueueStatus.SUBMITTED,
            }
          );

          // Parse transaction data for metadata
          const txData = item.tx_data;
          const metadata = this.parseTxDataMetadata(txData);

          // Create a profitability check object for the executor
          const profitability: ProfitabilityCheck = {
            canBump: true,
            constraints: {
              calculatorEligible: true,
              hasEnoughRewards: true,
              isProfitable: true,
            },
            estimates: {
              optimalTip: BigInt(metadata.tipAmount || '0'),
              gasEstimate: BigInt(metadata.gasEstimate || '100000'),
              expectedProfit: BigInt(metadata.profit || '0'),
              tipReceiver: metadata.tipReceiver || ethers.ZeroAddress,
            },
          };

          // Queue the transaction
          const tx = await this.queueTransaction(
            BigInt(item.deposit_id),
            profitability,
            txData
          );

          this.logger.info('Queued transaction from database', {
            id: tx.id,
            depositId: item.deposit_id,
          });
        } catch (error) {
          this.logger.error('Failed to process database queue item', {
            id: item.id,
            error: error instanceof Error ? error.message : String(error),
          });

          // Mark as failed in database
          await this.db.updateTransactionQueueItem(
            item.id,
            {
              status: TransactionQueueStatus.FAILED,
              error: error instanceof Error ? error.message : String(error),
            }
          );
        }
      }
    } catch (error) {
      this.logger.error('Failed to check database transaction queue', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Parse metadata from transaction data
   */
  private parseTxDataMetadata(txData?: string): {
    tipAmount?: string;
    gasEstimate?: string;
    profit?: string;
    tipReceiver?: string;
  } {
    if (!txData) return {};
    
    try {
      // Try to parse as JSON
      return JSON.parse(txData);
    } catch (e) {
      // If not JSON, return empty object
      return {};
    }
  }

  /**
   * Validate transaction data
   */
  protected validateTransactionData(
    data: string | null | undefined,
    context: string,
  ): boolean {
    if (!data) {
      this.logger.error('Transaction data is null or undefined', { context });
      return false;
    }

    // Check if it's a valid hex string starting with 0x
    if (!data.startsWith('0x')) {
      this.logger.error('Transaction data does not start with 0x', {
        context,
        data: data.substring(0, 10),
      });
      return false;
    }

    // Check for minimum length (0x + at least 4 bytes function selector)
    if (data.length < 10) {
      this.logger.error('Transaction data too short', {
        context,
        length: data.length,
      });
      return false;
    }

    return true;
  }
}
