import { ethers, ContractTransactionResponse } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { IExecutor } from '../interfaces/IExecutor';
import {
  ExecutorConfig,
  QueuedTransaction,
  TransactionStatus,
  QueueStats,
  TransactionReceipt,
  GovLstExecutorError,
} from '../interfaces/types';
import { GovLstProfitabilityCheck } from '@/profitability/interfaces/types';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseWrapper } from '@/database';
import { Interface } from 'ethers';
import { TransactionQueueStatus } from '@/database/interfaces/types';
import { EXECUTOR_EVENTS, GAS_CONSTANTS, QUEUE_CONSTANTS } from '../constants';
import {
  ContractMethodError,
  ExecutorError,
  GasEstimationError,
  InsufficientBalanceError,
  QueueOperationError,
  TransactionExecutionError,
  TransactionReceiptError,
  TransactionValidationError,
  createExecutorError,
} from '../errors';

interface GovLstContractMethod {
  (
    walletAddress: string,
    minExpectedReward: bigint,
    depositIds: bigint[],
    options?: {
      gasLimit?: bigint
      gasPrice?: bigint
    }
  ): Promise<ContractTransactionResponse>
  estimateGas: (
    walletAddress: string,
    minExpectedReward: bigint,
    depositIds: bigint[]
  ) => Promise<bigint>
}

/**
 * Base implementation of the GovLst reward executor using a direct wallet.
 * Handles transaction queueing, execution, and monitoring.
 */
export class BaseExecutor implements IExecutor {
  // Private members
  private readonly logger: Logger;
  private readonly wallet: ethers.Wallet;
  private readonly queue: Map<string, QueuedTransaction>;
  private isRunning: boolean;
  private processingInterval: NodeJS.Timeout | null;
  private db?: DatabaseWrapper; // Database access for transaction queue
  private govLstContract: ethers.Contract;
  private readonly provider: ethers.Provider;
  private readonly config: ExecutorConfig;

  /**
   * Creates a new BaseExecutor instance
   * @param params - Constructor parameters
   * @param params.contractAddress - Address of the GovLst contract
   * @param params.contractAbi - ABI of the GovLst contract
   * @param params.provider - Ethereum provider
   * @param params.config - Executor configuration
   */
  constructor({
    contractAddress,
    contractAbi,
    provider,
    config,
  }: {
    contractAddress: string;
    contractAbi: Interface;
    provider: ethers.Provider;
    config: ExecutorConfig;
  }) {
    if (!provider) throw new ExecutorError('Provider is required', {}, false);

    this.logger = new ConsoleLogger('info');
    this.wallet = new ethers.Wallet(config.wallet.privateKey, provider);
    this.queue = new Map();
    this.isRunning = false;
    this.processingInterval = null;
    this.provider = provider;
    this.config = config;

    // Initialize contract
    this.govLstContract = new ethers.Contract(
      contractAddress,
      contractAbi,
      this.wallet
    );

    if (!this.govLstContract.interface.hasFunction('claimAndDistributeReward'))
      throw new ContractMethodError('claimAndDistributeReward');
  }

  /**
   * Starts the executor service
   * Initializes queue processing and requeues any pending transactions
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;
    this.startQueueProcessor();
    await this.requeuePendingItems();
  }

  /**
   * Stops the executor service
   * Cleans up queue processing
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;
    this.stopQueueProcessor();
  }

  /**
   * Gets the current status of the executor
   * @returns Current status including wallet balance and queue stats
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    walletBalance: bigint;
    pendingTransactions: number;
    queueSize: number;
  }> {
    const balance = await this.getWalletBalance();
    const pendingTxs = Array.from(this.queue.values()).filter(
      (tx) => tx.status === TransactionStatus.PENDING
    ).length;

    return {
      isRunning: this.isRunning,
      walletBalance: balance,
      pendingTransactions: pendingTxs,
      queueSize: this.queue.size,
    };
  }

  /**
   * Queues a transaction for execution
   * @param depositIds - Array of deposit IDs to claim rewards for
   * @param profitability - Profitability check results
   * @param txData - Optional transaction data
   * @returns Queued transaction object
   */
  private serializeProfitabilityCheck(check: GovLstProfitabilityCheck): GovLstProfitabilityCheck {
    const serializeBigInt = (value: bigint | string): bigint => {
      return typeof value === 'string' ? BigInt(value) : value;
    };

    return {
      ...check,
      estimates: {
        expected_profit: serializeBigInt(check.estimates.expected_profit),
        gas_estimate: serializeBigInt(check.estimates.gas_estimate),
        total_shares: serializeBigInt(check.estimates.total_shares),
        payout_amount: serializeBigInt(check.estimates.payout_amount)
      },
      deposit_details: check.deposit_details.map(detail => ({
        ...detail,
        depositId: serializeBigInt(detail.depositId),
        rewards: serializeBigInt(detail.rewards)
      }))
    };
  }

  async queueTransaction(
    depositIds: bigint[],
    profitability: GovLstProfitabilityCheck,
    txData?: string
  ): Promise<QueuedTransaction> {
    // Validate state and inputs
    if (!this.isRunning) throw new ExecutorError('Executor is not running', {}, false);
    if (this.queue.size >= this.config.maxQueueSize) throw new QueueOperationError('queue', new Error('Queue is full'), { maxSize: this.config.maxQueueSize });
    if (depositIds.length > QUEUE_CONSTANTS.MAX_BATCH_SIZE)
      throw new TransactionValidationError(`Batch size exceeds maximum of ${QUEUE_CONSTANTS.MAX_BATCH_SIZE}`, { depositIds: depositIds.map(String) });
    if (depositIds.length < QUEUE_CONSTANTS.MIN_BATCH_SIZE)
      throw new TransactionValidationError(`Batch size below minimum of ${QUEUE_CONSTANTS.MIN_BATCH_SIZE}`, { depositIds: depositIds.map(String) });

    // Create transaction
    const tx: QueuedTransaction = {
      id: uuidv4(),
      depositIds,
      profitability: this.serializeProfitabilityCheck(profitability),
      status: TransactionStatus.QUEUED,
      createdAt: new Date(),
      tx_data: txData,
    };

    // Queue and log
    this.queue.set(tx.id, tx);
    this.logger.info(EXECUTOR_EVENTS.TRANSACTION_QUEUED, {
      id: tx.id,
      depositCount: depositIds.length,
      totalShares: profitability.estimates.total_shares.toString(),
      expectedProfit: profitability.estimates.expected_profit.toString(),
    });

    if (this.isRunning) setImmediate(() => this.processQueue(false));

    return tx;
  }

  /**
   * Gets statistics about the transaction queue
   * @returns Queue statistics including counts and gas usage
   */
  async getQueueStats(): Promise<QueueStats> {
    const transactions = Array.from(this.queue.values());
    const confirmed = transactions.filter((tx) => tx.status === TransactionStatus.CONFIRMED);
    const failed = transactions.filter((tx) => tx.status === TransactionStatus.FAILED);
    const pending = transactions.filter((tx) => tx.status === TransactionStatus.PENDING);
    const queued = transactions.filter((tx) => tx.status === TransactionStatus.QUEUED);

    const totalGasPrice = confirmed.reduce(
      (sum, tx) => sum + (tx.gasPrice || 0n),
      0n
    );
    const totalGasLimit = confirmed.reduce(
      (sum, tx) => sum + (tx.gasLimit || 0n),
      0n
    );
    const totalProfits = confirmed.reduce(
      (sum, tx) => sum + tx.profitability.estimates.expected_profit,
      0n
    );

    return {
      totalConfirmed: confirmed.length,
      totalFailed: failed.length,
      totalPending: pending.length,
      totalQueued: queued.length,
      averageGasPrice: confirmed.length ? totalGasPrice / BigInt(confirmed.length) : 0n,
      averageGasLimit: confirmed.length ? totalGasLimit / BigInt(confirmed.length) : 0n,
      totalProfits,
    };
  }

  /**
   * Gets a specific transaction by ID
   * @param id - Transaction ID
   * @returns Transaction object or null if not found
   */
  async getTransaction(id: string): Promise<QueuedTransaction | null> {
    return this.queue.get(id) || null;
  }

  /**
   * Gets a transaction receipt
   * @param hash - Transaction hash
   * @returns Transaction receipt or null if not found
   */
  async getTransactionReceipt(hash: string): Promise<TransactionReceipt | null> {
    const receipt = await this.provider.getTransactionReceipt(hash);
    if (!receipt) return null;

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.gasPrice || 0n,
      status: receipt.status || 0,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: Array.from(log.topics),
        data: log.data,
      })),
    };
  }

  /**
   * Transfers accumulated tips to the configured receiver
   * @returns Transaction receipt or null if transfer not needed/possible
   */
  async transferOutTips(): Promise<TransactionReceipt | null> {
    if (!this.config.defaultTipReceiver) throw new Error('No tip receiver configured');

    const balance = await this.getWalletBalance();
    if (balance < this.config.transferOutThreshold) return null;

    const tx = await this.wallet.sendTransaction({
      to: this.config.defaultTipReceiver,
      value: balance - this.config.wallet.minBalance,
    });

    const receipt = await tx.wait(this.config.minConfirmations);
    if (!receipt) return null;

    this.logger.info(EXECUTOR_EVENTS.TIPS_TRANSFERRED, {
      amount: ethers.formatEther(balance - this.config.wallet.minBalance),
      receiver: this.config.defaultTipReceiver,
      hash: tx.hash,
    });

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.gasPrice || 0n,
      status: receipt.status || 0,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: Array.from(log.topics),
        data: log.data,
      })),
    };
  }

  /**
   * Clears the transaction queue
   */
  async clearQueue(): Promise<void> {
    this.queue.clear();
  }

  /**
   * Sets the database instance for transaction queue management
   * @param db - Database instance
   */
  setDatabase(db: DatabaseWrapper): void {
    this.db = db;
    this.logger.info('Database set for executor');
  }

  /**
   * Gets the current wallet balance
   * @returns Wallet balance in wei
   */
  private async getWalletBalance(): Promise<bigint> {
    return this.provider.getBalance(this.wallet.address);
  }

  /**
   * Starts the queue processor
   */
  private startQueueProcessor(): void {
    if (this.processingInterval) return;

    this.processingInterval = setInterval(
      () => this.processQueue(true),
      QUEUE_CONSTANTS.QUEUE_PROCESSOR_INTERVAL
    );
  }

  /**
   * Stops the queue processor
   */
  private stopQueueProcessor(): void {
    if (!this.processingInterval) return;

    clearInterval(this.processingInterval);
    this.processingInterval = null;
  }

  /**
   * Processes the transaction queue
   * @param isPeriodicCheck - Whether this is a periodic check or manual trigger
   */
  private async processQueue(isPeriodicCheck: boolean = false): Promise<void> {
    if (!this.isRunning) {
      this.logger.debug('Queue processor not running, skipping');
      return;
    }

    try {
      this.logger.info('Starting queue processing cycle', {
        isPeriodicCheck,
        queueSize: this.queue.size,
        timestamp: new Date().toISOString()
      });

      const balance = await this.getWalletBalance();
      this.logger.info('Current wallet balance', {
        balance: ethers.formatEther(balance),
        minRequired: ethers.formatEther(this.config.wallet.minBalance)
      });

      if (balance < this.config.wallet.minBalance) {
        this.logger.warn('Insufficient wallet balance', {
          balance: ethers.formatEther(balance),
          required: ethers.formatEther(this.config.wallet.minBalance)
        });
        throw new InsufficientBalanceError(balance, this.config.wallet.minBalance);
      }

      const pendingTxs = Array.from(this.queue.values()).filter(
        (tx) => tx.status === TransactionStatus.PENDING
      );
      this.logger.info('Current pending transactions', {
        count: pendingTxs.length,
        maxAllowed: this.config.wallet.maxPendingTransactions,
        pendingIds: pendingTxs.map(tx => tx.id)
      });

      if (pendingTxs.length >= this.config.wallet.maxPendingTransactions) {
        this.logger.warn('Max pending transactions reached', {
          current: pendingTxs.length,
          max: this.config.wallet.maxPendingTransactions
        });
        return;
      }

      const queuedTxs = Array.from(this.queue.values())
        .filter((tx) => tx.status === TransactionStatus.QUEUED)
        .slice(0, this.config.concurrentTransactions - pendingTxs.length);

      this.logger.info('Processing queued transactions', {
        queuedCount: queuedTxs.length,
        maxConcurrent: this.config.concurrentTransactions,
        queuedIds: queuedTxs.map(tx => tx.id)
      });

      if (queuedTxs.length === 0) {
        if (!isPeriodicCheck) this.logger.debug('No queued transactions to process');
        return;
      }

      await Promise.all(queuedTxs.map((tx) => this.executeTransaction(tx)));

      this.logger.info('Queue processing cycle completed', {
        processedCount: queuedTxs.length,
        remainingQueueSize: this.queue.size,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      const executorError = createExecutorError(error, {
        isPeriodicCheck,
        queueSize: this.queue.size,
      });
      this.logger.error(EXECUTOR_EVENTS.ERROR, {
        ...executorError,
        ...executorError.context,
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  /**
   * Executes a single transaction
   * @param tx - Transaction to execute
   */
  private async executeTransaction(tx: QueuedTransaction): Promise<void> {
    this.logger.info('Starting transaction execution', {
      id: tx.id,
      depositIds: tx.depositIds.map(String),
      expectedProfit: ethers.formatEther(tx.profitability.estimates.expected_profit)
    });

    try {
      tx.status = TransactionStatus.PENDING;
      this.queue.set(tx.id, tx);
      this.logger.info('Transaction status updated to pending', { id: tx.id });

      // Calculate total rewards from deposit details
      const totalRewards = tx.profitability.deposit_details.reduce(
        (sum, detail) => sum + detail.rewards,
        BigInt(0)
      );

      const depositIds = tx.depositIds;

      this.logger.info('Estimating gas for transaction', {
        id: tx.id,
        depositCount: depositIds.length,
        minExpectedReward: ethers.formatEther(totalRewards)
      });

      const gasEstimate = await this.estimateGas(totalRewards, depositIds);
      const { finalGasLimit, boostedGasPrice } = await this.calculateGasParameters(gasEstimate);

      this.logger.info('Gas parameters calculated', {
        id: tx.id,
        baseGasEstimate: gasEstimate.toString(),
        finalGasLimit: finalGasLimit.toString(),
        boostedGasPrice: ethers.formatUnits(boostedGasPrice, 'gwei'),
        estimatedCostEth: ethers.formatEther(finalGasLimit * boostedGasPrice)
      });

      const claimAndDistributeReward = this.govLstContract.claimAndDistributeReward as GovLstContractMethod;
      if (!claimAndDistributeReward) {
        throw new ContractMethodError('claimAndDistributeReward');
      }

      this.logger.info('Submitting transaction', {
        id: tx.id,
        tipReceiver: this.config.defaultTipReceiver,
        minExpectedReward: ethers.formatEther(totalRewards),
        depositIds: depositIds.map(String)
      });

      const txResponse = await claimAndDistributeReward(
        this.config.defaultTipReceiver || this.wallet.address,
        totalRewards,
        depositIds,
        {
          gasLimit: finalGasLimit,
          gasPrice: boostedGasPrice,
        }
      );

      this.logger.info('Transaction submitted', {
        id: tx.id,
        hash: txResponse.hash,
        nonce: txResponse.nonce,
        gasPrice: ethers.formatUnits(txResponse.gasPrice || 0n, 'gwei')
      });

      await this.processTransactionReceipt(tx, txResponse);
    } catch (error) {
      this.logger.error('Transaction execution failed', {
        id: tx.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      await this.handleTransactionError(tx, error);
    }
  }

  /**
   * Estimates gas for a transaction
   * @param minExpectedReward - Minimum expected reward
   * @param depositIds - Array of deposit IDs
   * @returns Estimated gas amount
   */
  private async estimateGas(minExpectedReward: bigint, depositIds: bigint[]): Promise<bigint> {
    const claimAndDistributeReward = this.govLstContract.claimAndDistributeReward as GovLstContractMethod;
    if (!claimAndDistributeReward) {
      throw new ContractMethodError('claimAndDistributeReward');
    }

    try {
      const estimate = await claimAndDistributeReward.estimateGas(
        this.config.defaultTipReceiver || this.wallet.address,
        minExpectedReward,
        depositIds
      );
      return BigInt(estimate.toString());
    } catch (error) {
      throw new GasEstimationError(
        error instanceof Error ? error : new Error(String(error)),
        {
          minExpectedReward: minExpectedReward.toString(),
          depositIds: depositIds.map(String),
        }
      );
    }
  }

  /**
   * Calculates gas parameters for a transaction
   * @param gasEstimate - Base gas estimate
   * @returns Gas limit and price parameters
   */
  private async calculateGasParameters(gasEstimate: bigint): Promise<{
    finalGasLimit: bigint;
    boostedGasPrice: bigint;
  }> {
    // Calculate gas limit with buffer
    const gasLimit = BigInt(Math.ceil(Number(gasEstimate) * GAS_CONSTANTS.GAS_LIMIT_BUFFER));
    const finalGasLimit = gasLimit < GAS_CONSTANTS.MIN_GAS_LIMIT
      ? GAS_CONSTANTS.MIN_GAS_LIMIT
      : gasLimit > GAS_CONSTANTS.MAX_GAS_LIMIT
      ? GAS_CONSTANTS.MAX_GAS_LIMIT
      : gasLimit;

    // Calculate boosted gas price
    const feeData = await this.provider.getFeeData();
    const baseGasPrice = feeData.gasPrice || 0n;
    const gasBoostMultiplier = BigInt(100 + this.config.gasBoostPercentage);
    const boostedGasPrice = (baseGasPrice * gasBoostMultiplier) / 100n;

    return { finalGasLimit, boostedGasPrice };
  }

  /**
   * Processes a transaction receipt
   * @param tx - Original transaction
   * @param txResponse - Transaction response from contract
   */
  private async processTransactionReceipt(
    tx: QueuedTransaction,
    txResponse: ContractTransactionResponse
  ): Promise<void> {
    const receipt = await txResponse.wait(this.config.minConfirmations);
    if (!receipt) throw new TransactionReceiptError(txResponse.hash, {
      transactionId: tx.id,
      depositIds: tx.depositIds.map(String),
    });

    // Update transaction status
    tx.status = receipt.status === 1 ? TransactionStatus.CONFIRMED : TransactionStatus.FAILED;
    tx.hash = txResponse.hash;
    tx.gasPrice = receipt.gasPrice || 0n;
    tx.gasLimit = receipt.gasUsed;
    tx.executedAt = new Date();

    if (receipt.status !== 1) {
      this.logger.error(EXECUTOR_EVENTS.TRANSACTION_FAILED, {
        id: tx.id,
        hash: txResponse.hash,
      });
      return;
    }

    this.logger.info(EXECUTOR_EVENTS.TRANSACTION_CONFIRMED, {
      id: tx.id,
      hash: txResponse.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      gasPrice: (receipt.gasPrice || 0n).toString(),
    });

    // Update database status
    if (this.db) {
      await Promise.all(
        tx.depositIds.map((depositId) =>
          this.db!.updateTransactionQueueItem(depositId.toString(), {
            status: TransactionQueueStatus.CONFIRMED,
            hash: txResponse.hash,
            error: undefined,
          })
        )
      );
    }

    this.queue.set(tx.id, tx);
  }

  /**
   * Handles transaction errors
   * @param tx - Failed transaction
   * @param error - Error that occurred
   */
  private async handleTransactionError(tx: QueuedTransaction, error: unknown): Promise<void> {
    tx.status = TransactionStatus.FAILED;
    tx.error = error as Error;
    this.queue.set(tx.id, tx);

    const executorError = new TransactionExecutionError(
      tx.id,
      error instanceof Error ? error : new Error(String(error)),
      {
        depositIds: tx.depositIds.map(String),
        profitability: tx.profitability,
      }
    );
    this.logger.error(EXECUTOR_EVENTS.ERROR, { ...executorError, ...executorError.context });

    // Update database status
    if (this.db) {
      await Promise.all(
        tx.depositIds.map((depositId) =>
          this.db!.updateTransactionQueueItem(depositId.toString(), {
            status: TransactionQueueStatus.FAILED,
            error: executorError.message,
          })
        )
      );
    }
  }

  /**
   * Requeues pending items from the database
   */
  private async requeuePendingItems(): Promise<void> {
    if (!this.db) return;

    try {
      const pendingItems = await this.db.getTransactionQueueItemsByStatus(
        TransactionQueueStatus.PENDING
      );

      if (!pendingItems?.length) return;

      this.logger.info('Requeuing pending transactions', {
        count: pendingItems.length,
      });

      for (const item of pendingItems) {
        if (!item.tx_data) continue;

        try {
          const txData = JSON.parse(item.tx_data);
          if (!txData.depositIds || !txData.profitability) continue;

          await this.queueTransaction(
            txData.depositIds.map(BigInt),
            txData.profitability,
            item.tx_data
          );
        } catch (error) {
          this.logger.error('Failed to requeue transaction', {
            depositId: item.deposit_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      const executorError = new Error('Failed to requeue pending items') as GovLstExecutorError;
      executorError.context = { error: error instanceof Error ? error.message : String(error) };
      this.logger.error(EXECUTOR_EVENTS.ERROR, { ...executorError, ...executorError.context });
    }
  }

  protected async validateTipReceiver(): Promise<void> {
    if (!this.config.defaultTipReceiver)
      throw new TransactionValidationError('No tip receiver configured', {
        config: this.config
      })
  }
}
