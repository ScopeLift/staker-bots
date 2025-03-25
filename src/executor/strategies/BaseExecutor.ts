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

export class BaseExecutor implements IExecutor {
  protected readonly logger: Logger;
  protected readonly wallet: ethers.Wallet;
  protected readonly queue: Map<string, QueuedTransaction>;
  protected isRunning: boolean;
  protected processingInterval: NodeJS.Timeout | null;
  protected db?: DatabaseWrapper; // Database access for transaction queue
  protected stakerContract: ethers.Contract;

  constructor(
    protected readonly contractAddress: string,
    protected readonly contractAbi: Interface,
    protected readonly provider: ethers.Provider,
    protected readonly config: ExecutorConfig,
  ) {
    this.logger = new ConsoleLogger('info');
    this.wallet = new ethers.Wallet(config.wallet.privateKey, provider);
    this.queue = new Map();
    this.isRunning = false;
    this.processingInterval = null;

    if (!provider) {
      throw new Error('Provider is required');
    }

    // Create contract with wallet directly
    this.stakerContract = new ethers.Contract(
      contractAddress,
      contractAbi,
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

  protected async getWalletBalance(): Promise<bigint> {
    return (await this.provider.getBalance(this.wallet.address)) || BigInt(0);
  }

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
          error,
        });
      });
    }, 15000); // Check database queue every 15 seconds

    this.logger.info('Queue processing intervals started');
  }

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

  async getTransaction(id: string): Promise<QueuedTransaction | null> {
    return this.queue.get(id) || null;
  }

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

      // Get the tip receiver address - use the default tip receiver from config or fallback to zero address
      const tipReceiver = this.config.defaultTipReceiver || ethers.ZeroAddress;

      this.logger.info('Transferring tips to receiver:', {
        receiver: tipReceiver,
        amount: ethers.formatEther(transferAmount),
        gasPrice: finalGasPrice.toString(),
        gasLimit: gasLimit.toString(),
      });

      // Create simple transaction object for ETH transfer
      const txRequest = {
        to: tipReceiver,
        value: transferAmount,
        gasLimit,
        gasPrice: finalGasPrice,
      };

      // Send transaction directly
      const tx = await this.wallet.sendTransaction(txRequest);

      this.logger.info('Tip transfer transaction sent:', {
        hash: tx.hash,
        to: tipReceiver,
        value: ethers.formatEther(transferAmount),
      });

      // Wait for confirmation
      const receipt = await tx.wait(this.config.minConfirmations);
      if (!receipt) {
        throw new Error('Failed to get transaction receipt');
      }

      return {
        hash: receipt.hash,
        status: receipt.status === 1,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.gasPrice || BigInt(0),
      };
    } catch (error) {
      this.logger.error('Error transferring tips:', { error });
      throw error;
    }
  }

  async clearQueue(): Promise<void> {
    this.queue.clear();
    this.logger.info('Queue cleared');
  }

  protected async processQueue(
    isPeriodicCheck: boolean = false,
  ): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      // Check wallet balance
      const balance = await this.getWalletBalance();
      if (balance < this.config.wallet.minBalance) {
        this.logger.warn('Wallet balance too low:', {
          balance: ethers.formatEther(balance),
          minimum: ethers.formatEther(this.config.wallet.minBalance),
        });
        return;
      }

      // Get pending transactions count
      const pendingTxs = Array.from(this.queue.values()).filter(
        (tx) => tx.status === TransactionStatus.PENDING,
      );
      if (pendingTxs.length >= this.config.wallet.maxPendingTransactions) {
        return;
      }

      // Get queued transactions
      const queuedTxs = Array.from(this.queue.values())
        .filter((tx) => tx.status === TransactionStatus.QUEUED)
        .slice(0, this.config.concurrentTransactions - pendingTxs.length);

      if (queuedTxs.length === 0) {
        if (!isPeriodicCheck) {
          this.logger.debug('No queued transactions to process');
        }
        return;
      }

      // Process each transaction
      await Promise.all(queuedTxs.map((tx) => this.executeTransaction(tx)));
    } catch (error) {
      this.logger.error('Error processing queue:', { error });
    }
  }

  protected async executeTransaction(tx: QueuedTransaction): Promise<void> {
    try {
      // Update status to pending
      tx.status = TransactionStatus.PENDING;
      this.queue.set(tx.id, tx);

      this.logger.info('Starting transaction execution:', {
        id: tx.id,
        depositId: tx.depositId.toString(),
        tipReceiver: tx.profitability.estimates.tipReceiver,
        optimalTip: tx.profitability.estimates.optimalTip.toString(),
      });

      // Get transaction parameters from the tx or tx_data
      let depositId: bigint;
      let tipReceiver: string;
      let tipAmount: bigint;

      if (tx.tx_data) {
        try {
          const txData = JSON.parse(tx.tx_data);
          if (
            txData &&
            txData._depositId &&
            txData._tipReceiver &&
            txData._requestedTip
          ) {
            depositId = BigInt(txData._depositId);
            tipReceiver = txData._tipReceiver;
            tipAmount = BigInt(txData._requestedTip);
          } else {
            throw new Error('Invalid tx_data format');
          }
        } catch (error) {
          this.logger.warn(
            'Failed to parse tx_data, using transaction values',
            { error },
          );
          depositId = tx.depositId;
          tipReceiver = tx.profitability.estimates.tipReceiver;
          tipAmount = tx.profitability.estimates.optimalTip;
        }
      } else {
        depositId = tx.depositId;
        tipReceiver = tx.profitability.estimates.tipReceiver;
        tipAmount = tx.profitability.estimates.optimalTip;
      }

      // First estimate gas for the transaction, but if it fails, use a fixed value
      let estimate: bigint;
      try {
        estimate = await this.stakerContract.bumpEarningPower!.estimateGas(
          depositId,
          tipReceiver,
          tipAmount,
        );

        this.logger.info('Gas estimation successful:', {
          estimate: estimate.toString(),
        });
      } catch (error) {
        // Use a fallback gas estimate if estimation fails
        estimate = BigInt(300000); // Safe default
        this.logger.warn('Gas estimation failed, using fallback value:', {
          fallback: estimate.toString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const balance = await this.provider.getBalance(this.wallet.address);
      this.logger.info('Checking wallet balance:', {
        balance: balance.toString(),
        estimate: estimate.toString(),
      });

      if (balance < estimate) {
        throw new Error('Not enough gas in wallet, please top up.');
      }

      // Make the call directly with a set gas limit (don't rely on estimation since it failed)
      const txOptions = {
        gasLimit: BigInt(300000), // Use fixed gas limit
      };

      // Make the call directly, just like the example
      this.logger.info('Sending bumpEarningPower transaction:', {
        depositId: depositId.toString(),
        tipReceiver,
        tipAmount: tipAmount.toString(),
      });

      const txResponse = await this.stakerContract.bumpEarningPower!(
        depositId,
        tipReceiver,
        tipAmount,
        txOptions,
      );

      // Update transaction info
      tx.hash = txResponse.hash;
      tx.executedAt = new Date();
      this.queue.set(tx.id, tx);

      this.logger.info('Transaction sent:', { hash: txResponse.hash });

      // Wait for confirmation
      const receipt = await txResponse.wait(this.config.minConfirmations);
      if (!receipt) {
        throw new Error('Failed to get transaction receipt');
      }

      // Update status based on receipt
      tx.status =
        receipt.status === 1
          ? TransactionStatus.CONFIRMED
          : TransactionStatus.FAILED;

      if (receipt.status !== 1) {
        this.logger.error('Transaction failed:', { hash: txResponse.hash });
      } else {
        this.logger.info('Transaction confirmed:', {
          hash: txResponse.hash,
          blockNumber: receipt.blockNumber,
        });

        // Update database status to mark this transaction as processed
        if (this.db && tx.tx_data) {
          try {
            const txData = JSON.parse(tx.tx_data);
            if (txData && txData._depositId) {
              const depositId = txData._depositId;
              this.logger.info(
                `Updating database status for deposit ${depositId}`,
              );

              await this.db.updateTransactionQueueItem(depositId.toString(), {
                status: TransactionQueueStatus.CONFIRMED,
                hash: txResponse.hash,
                error: undefined,
              });

              this.logger.info(
                `Database updated for deposit ${depositId} - marked as completed`,
              );
            }
          } catch (dbError) {
            this.logger.error('Failed to update database status:', {
              error: dbError,
            });
          }
        }
      }

      this.queue.set(tx.id, tx);
    } catch (error) {
      tx.status = TransactionStatus.FAILED;
      tx.error = error as Error;
      this.queue.set(tx.id, tx);
      this.logger.error('Transaction execution failed:', { error });

      // Retry logic for gas-related errors
      if (
        error instanceof Error &&
        (error.message.includes('max fee per gas less than block base fee') ||
          error.message.includes('replacement transaction underpriced') ||
          error.message.includes('transaction underpriced'))
      ) {
        this.logger.warn(
          'Gas error detected, will retry with higher gas price',
        );

        // Set up for retry
        tx.status = TransactionStatus.QUEUED;
        tx.retryCount = (tx.retryCount || 0) + 1;

        if (tx.retryCount <= this.config.maxRetries) {
          this.queue.set(tx.id, tx);
          setTimeout(() => this.processQueue(false), this.config.retryDelayMs);
        } else {
          this.logger.error('Max retry attempts exceeded:', {
            retries: tx.retryCount,
          });
        }
      }
    }
  }

  /**
   * Calculate the function selector for a given function signature
   */
  protected calculateFunctionSelector(
    functionName: string,
    paramTypes: string[],
  ): string {
    // Create the canonical signature: name(type1,type2,...)
    const signature = `${functionName}(${paramTypes.join(',')})`;

    // Hash it using keccak256 and take first 4 bytes (8 characters after 0x)
    const hash = ethers.keccak256(ethers.toUtf8Bytes(signature));
    const selector = hash.substring(0, 10); // 0x + 8 characters (4 bytes)

    return selector;
  }

  /**
   * Check if there are transactions in the database that need to be executed
   */
  protected async checkDatabaseTransactionQueue(): Promise<void> {
    if (!this.db) {
      this.logger.warn(
        'No database instance available, cannot check transaction queue',
      );
      return;
    }

    try {
      // Query the database for pending transactions
      const pendingTransactions =
        await this.db.getTransactionQueueItemsByStatus(
          TransactionQueueStatus.PENDING,
        );

      if (!pendingTransactions || pendingTransactions.length === 0) {
        this.logger.debug('No pending transactions found in database');
        return;
      }

      this.logger.info(
        `Found ${pendingTransactions.length} pending transactions in database`,
      );

      // Process each transaction not already in the queue
      for (const txItem of pendingTransactions) {
        try {
          // Check if already in our in-memory queue
          const existingTx = Array.from(this.queue.values()).find(
            (queuedTx) => queuedTx.depositId.toString() === txItem.deposit_id,
          );

          if (existingTx) {
            this.logger.debug(
              `Transaction for deposit ${txItem.deposit_id} already in memory queue, skipping`,
            );
            continue;
          }

          // Parse tx_data
          const txData = txItem.tx_data;
          // Create a new transaction object
          const depositId = BigInt(txItem.deposit_id);

          // Create a minimal profitability check object
          const profitability: ProfitabilityCheck = {
            canBump: true,
            constraints: {
              calculatorEligible: true,
              hasEnoughRewards: true,
              isProfitable: true,
            },
            estimates: {
              optimalTip: BigInt(txItem.tip_amount || '0'),
              gasEstimate: BigInt('150000'), // Default estimate
              expectedProfit: BigInt('0'),
              tipReceiver: txItem.tip_receiver || ethers.ZeroAddress,
            },
          };

          // Add to in-memory queue
          await this.queueTransaction(depositId, profitability, txData);

          this.logger.info(
            `Added transaction from database to memory queue: deposit ${txItem.deposit_id}`,
          );
        } catch (error) {
          this.logger.error(
            `Error processing transaction ${txItem.id} from database:`,
            { error },
          );
        }
      }

      // Process the queue immediately
      await this.processQueue(false);
    } catch (error) {
      this.logger.error('Error retrieving transactions from database:', {
        error,
      });
    }
  }

  // Keep the validateTransactionData method as it's still useful
  protected validateTransactionData(
    data: string | null | undefined,
    context: string,
  ): boolean {
    if (!data) {
      this.logger.error(`Empty transaction data in ${context}`);
      return false;
    }

    if (data === '0x' || data === '') {
      this.logger.error(`Invalid empty transaction data in ${context}`);
      return false;
    }

    if (!data.startsWith('0x')) {
      this.logger.error(
        `Transaction data doesn't start with 0x in ${context}: ${data}`,
      );
      return false;
    }

    if (data.length < 10) {
      this.logger.error(`Transaction data too short in ${context}: ${data}`);
      return false;
    }

    // Valid transaction data
    return true;
  }
}
