import { ethers, ContractTransactionResponse, BaseContract } from 'ethers';
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
import {
  TransactionQueueStatus,
  ProcessingQueueStatus,
} from '@/database/interfaces/types';
import { EXECUTOR } from '@/configuration/constants';
import {
  ContractMethodError,
  ExecutorError,
  GasEstimationError,
  InsufficientBalanceError,
  QueueOperationError,
  TransactionExecutionError,
  TransactionValidationError,
  createExecutorError,
} from '@/configuration/errors';
import { CONFIG } from '@/configuration';
import {
  calculateGasLimit,
  pollForReceipt,
  validateTransaction,
  extractQueueItemInfo,
  calculateQueueStats,
} from '@/configuration/helpers';
import { GasCostEstimator } from '@/prices/GasCostEstimator';

// Local constants used in this file
const BASE_EVENTS = {
  TRANSACTION_QUEUED: EXECUTOR.EVENTS.TRANSACTION_QUEUED,
  TRANSACTION_CONFIRMED: EXECUTOR.EVENTS.TRANSACTION_CONFIRMED,
  TRANSACTION_FAILED: EXECUTOR.EVENTS.TRANSACTION_FAILED,
  TIPS_TRANSFERRED: EXECUTOR.EVENTS.TIPS_TRANSFERRED,
  ERROR: EXECUTOR.EVENTS.ERROR,
} as const;

const GAS = {
  MIN_LIMIT: EXECUTOR.GAS.MIN_GAS_LIMIT,
  MAX_LIMIT: EXECUTOR.GAS.MAX_GAS_LIMIT,
  BUFFER: EXECUTOR.GAS.GAS_LIMIT_BUFFER,
} as const;

const BASE_QUEUE = {
  PROCESSOR_INTERVAL: EXECUTOR.QUEUE.QUEUE_PROCESSOR_INTERVAL,
  MAX_BATCH_SIZE: EXECUTOR.QUEUE.MAX_BATCH_SIZE,
  MIN_BATCH_SIZE: EXECUTOR.QUEUE.MIN_BATCH_SIZE,
  MAX_RETRIES: EXECUTOR.QUEUE.MAX_RETRIES,
  RETRY_DELAY: EXECUTOR.QUEUE.RETRY_DELAY,
} as const;

interface GovLstContract extends BaseContract {
  estimateGas: {
    claimAndDistributeReward: (
      recipient: string,
      minExpectedReward: bigint,
      depositIds: bigint[],
    ) => Promise<bigint>;
  };
  claimAndDistributeReward: (
    recipient: string,
    minExpectedReward: bigint,
    depositIds: bigint[],
  ) => Promise<ContractTransactionResponse>;
  payoutAmount(): Promise<bigint>;
}

interface GovLstContractMethod {
  (
    walletAddress: string,
    minExpectedReward: bigint,
    depositIds: bigint[],
    options?: {
      gasLimit?: bigint;
      gasPrice?: bigint;
    },
  ): Promise<ContractTransactionResponse>;
  estimateGas: (
    walletAddress: string,
    minExpectedReward: bigint,
    depositIds: bigint[],
  ) => Promise<bigint>;
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
  protected readonly govLstContract: GovLstContract;
  private readonly provider: ethers.Provider;
  private readonly config: ExecutorConfig;
  private readonly gasCostEstimator: GasCostEstimator;

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
      this.wallet,
    ) as unknown as GovLstContract;

    if (!this.govLstContract.interface.hasFunction('claimAndDistributeReward'))
      throw new ContractMethodError('claimAndDistributeReward');

    this.gasCostEstimator = new GasCostEstimator();
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
    depositIds: bigint[],
    profitability: GovLstProfitabilityCheck,
    txData?: string,
  ): Promise<QueuedTransaction> {
    // Validate state and inputs
    if (!this.isRunning)
      throw new ExecutorError('Executor is not running', {}, false);
    if (this.queue.size >= this.config.maxQueueSize)
      throw new QueueOperationError('queue', new Error('Queue is full'), {
        maxSize: this.config.maxQueueSize,
      });

    // Validate the transaction
    const { isValid, error } = await this.validateTransaction(
      depositIds,
      profitability,
    );
    if (!isValid) {
      throw error;
    }

    const tx: QueuedTransaction = {
      id: uuidv4(),
      depositIds,
      profitability,
      status: TransactionStatus.QUEUED,
      createdAt: new Date(),
      tx_data: txData,
    };

    this.queue.set(tx.id, tx);
    this.logger.info(BASE_EVENTS.TRANSACTION_QUEUED, {
      id: tx.id,
      depositCount: depositIds.length,
      totalShares: profitability.estimates.total_shares.toString(),
      expectedProfit: profitability.estimates.expected_profit.toString(),
    });

    if (this.isRunning) setImmediate(() => this.processQueue(false));

    return tx;
  }

  async validateTransaction(
    depositIds: bigint[],
    profitability: GovLstProfitabilityCheck,
  ): Promise<{ isValid: boolean; error: TransactionValidationError | null }> {
    // Use the centralized validation function
    const baseValidation = await validateTransaction(
      depositIds,
      profitability,
      this.queue,
    );
    if (!baseValidation.isValid) {
      return {
        isValid: false,
        error: new TransactionValidationError(
          baseValidation.error?.message || 'Transaction validation failed',
          {
            depositIds: depositIds.map(String),
          },
        ),
      };
    }

    // Get current gas price and calculate gas cost
    const feeData = await this.provider.getFeeData();
    if (!feeData.gasPrice) {
      return {
        isValid: false,
        error: new TransactionValidationError(
          'Failed to get gas price from provider',
          {
            feeData: feeData,
          },
        ),
      };
    }
    const gasBoostMultiplier = BigInt(100 + this.config.gasBoostPercentage);
    const boostedGasPrice = (feeData.gasPrice * gasBoostMultiplier) / 100n;
    const estimatedGasCost =
      boostedGasPrice * profitability.estimates.gas_estimate;

    // Get payout amount - with fallback
    let payoutAmount: bigint;
    try {
      if (typeof this.govLstContract.payoutAmount === 'function') {
        payoutAmount = await this.govLstContract.payoutAmount();
        this.logger.info('Retrieved payout amount from contract', {
          payoutAmount: payoutAmount.toString(),
        });
      } else {
        return {
          isValid: false,
          error: new TransactionValidationError(
            'Contract missing payoutAmount method',
            {
              contract: this.govLstContract,
            },
          ),
        };
      }
    } catch (error) {
      // Use the payout amount from profitability check as fallback
      this.logger.warn('Using fallback payout amount', {
        error: error instanceof Error ? error.message : String(error),
      });

      payoutAmount =
        profitability.estimates.payout_amount ||
        profitability.deposit_details.reduce(
          (sum, detail) => sum + detail.rewards,
          BigInt(0),
        );

      if (payoutAmount === 0n) {
        // Last resort fallback - arbitrary amount
        payoutAmount = ethers.parseUnits('0.1', 18); // 0.1 token
      }

      this.logger.info('Using fallback payout amount', {
        payoutAmount: payoutAmount.toString(),
      });
    }

    // Calculate the base amount for profit margin calculation
    const baseAmountForMargin =
      payoutAmount +
      (CONFIG.profitability.includeGasCost ? estimatedGasCost : 0n);

    // Get the min profit margin percentage (as a number)
    const minProfitMarginPercent = CONFIG.profitability.minProfitMargin;

    // Calculate the required profit value in wei
    const requiredProfitValue =
      (baseAmountForMargin * BigInt(Math.round(minProfitMarginPercent * 100))) /
      10000n; // Multiply by 100 for percentage, divide by 10000 (100*100)

    // Validate that expected reward is sufficient
    if (
      profitability.estimates.expected_profit <
      baseAmountForMargin + requiredProfitValue
    ) {
      throw new TransactionValidationError(
        'Expected reward is less than payout amount plus gas cost and profit margin',
        {
          expectedReward: profitability.estimates.expected_profit.toString(),
          payoutAmount: payoutAmount.toString(),
          estimatedGasCost: estimatedGasCost.toString(),
          requiredProfitValue: requiredProfitValue.toString(),
          minProfitMarginPercent: `${minProfitMarginPercent}%`,
          depositIds: depositIds.map(String),
        },
      );
    }

    return {
      isValid: true,
      error: null,
    };
  }

  /**
   * Gets statistics about the transaction queue
   * @returns Queue statistics including counts and gas usage
   */
  async getQueueStats(): Promise<QueueStats> {
    return calculateQueueStats(Array.from(this.queue.values()));
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
  async getTransactionReceipt(
    hash: string,
  ): Promise<TransactionReceipt | null> {
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
    if (!this.config.defaultTipReceiver)
      throw new Error('No tip receiver configured');

    const balance = await this.getWalletBalance();
    if (balance < this.config.transferOutThreshold) return null;

    try {
      const tx = await this.wallet.sendTransaction({
        to: this.config.defaultTipReceiver,
        value: balance - this.config.wallet.minBalance,
      });

      this.logger.info('Tip transfer transaction submitted', {
        hash: tx.hash,
        amount: ethers.formatEther(balance - this.config.wallet.minBalance),
        receiver: this.config.defaultTipReceiver,
      });

      const receipt = await tx.wait(1); // Just wait for 1 confirmation

      this.logger.info(BASE_EVENTS.TIPS_TRANSFERRED, {
        amount: ethers.formatEther(balance - this.config.wallet.minBalance),
        receiver: this.config.defaultTipReceiver,
        hash: tx.hash,
        blockNumber: receipt!.blockNumber,
      });

      return {
        hash: tx.hash,
        blockNumber: receipt!.blockNumber,
        gasUsed: receipt!.gasUsed,
        gasPrice: 0n, // Default gas price since it's not available in the receipt
        status: receipt!.status || 0,
        logs: receipt!.logs.map((log) => ({
          address: log.address,
          topics: Array.from(log.topics),
          data: log.data,
        })),
      };
    } catch (error) {
      this.logger.error('Failed to transfer tips', {
        error: error instanceof Error ? error.message : String(error),
        receiver: this.config.defaultTipReceiver,
      });

      throw new TransactionExecutionError(
        'transfer_tips',
        error instanceof Error ? error : new Error(String(error)),
        {
          amount: (balance - this.config.wallet.minBalance).toString(),
          receiver: this.config.defaultTipReceiver,
        },
      );
    }
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
      BASE_QUEUE.PROCESSOR_INTERVAL,
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
        timestamp: new Date().toISOString(),
      });

      const balance = await this.getWalletBalance();
      this.logger.info('Current wallet balance', {
        balance: ethers.formatEther(balance),
        minRequired: ethers.formatEther(this.config.wallet.minBalance),
      });

      if (balance < this.config.wallet.minBalance) {
        this.logger.warn('Insufficient wallet balance', {
          balance: ethers.formatEther(balance),
          required: ethers.formatEther(this.config.wallet.minBalance),
        });
        throw new InsufficientBalanceError(
          balance,
          this.config.wallet.minBalance,
        );
      }

      const pendingTxs = Array.from(this.queue.values()).filter(
        (tx) => tx.status === TransactionStatus.PENDING,
      );
      this.logger.info('Current pending transactions', {
        count: pendingTxs.length,
        maxAllowed: this.config.wallet.maxPendingTransactions,
        pendingIds: pendingTxs.map((tx) => tx.id),
      });

      if (pendingTxs.length >= this.config.wallet.maxPendingTransactions) {
        this.logger.warn('Max pending transactions reached', {
          current: pendingTxs.length,
          max: this.config.wallet.maxPendingTransactions,
        });
        return;
      }

      const queuedTxs = Array.from(this.queue.values())
        .filter((tx) => tx.status === TransactionStatus.QUEUED)
        .slice(0, this.config.concurrentTransactions - pendingTxs.length);

      this.logger.info('Processing queued transactions', {
        queuedCount: queuedTxs.length,
        maxConcurrent: this.config.concurrentTransactions,
        queuedIds: queuedTxs.map((tx) => tx.id),
      });

      if (queuedTxs.length === 0) {
        if (!isPeriodicCheck)
          this.logger.debug('No queued transactions to process');
        return;
      }

      await Promise.all(queuedTxs.map((tx) => this.executeTransaction(tx)));

      this.logger.info('Queue processing cycle completed', {
        processedCount: queuedTxs.length,
        remainingQueueSize: this.queue.size,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const executorError = createExecutorError(error, {
        isPeriodicCheck,
        queueSize: this.queue.size,
      });
      this.logger.error(BASE_EVENTS.ERROR, {
        ...executorError,
        ...executorError.context,
        stack: error instanceof Error ? error.stack : undefined,
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
    });

    try {
      tx.status = TransactionStatus.PENDING;
      this.queue.set(tx.id, tx);

      // Get payout amount from contract
      const payoutAmount = await this.govLstContract.payoutAmount();

      // Temporarily use a default gas cost value
      const gasCost = 0n; // Set to 0 for now since we don't have actual values
      this.logger.info('Using default gas cost:', {
        value: gasCost.toString(),
        type: typeof gasCost
      });

      // Calculate optimal threshold
      const profitMargin = this.config.minProfitMargin;
      const profitMarginBasisPoints = BigInt(Math.floor(profitMargin * 100));
      const baseAmount = payoutAmount + gasCost;
      const profitMarginAmount = (baseAmount * profitMarginBasisPoints) / 10000n;
      const optimalThreshold = payoutAmount + gasCost + profitMarginAmount;

      const depositIds = tx.depositIds;

      // Store queue-related metadata
      let queueItemId: string | undefined;
      let queueDepositIds: string[] = [];
      if (tx.tx_data) {
        try {
          const txData = JSON.parse(tx.tx_data);
          queueItemId = txData.queueItemId;
          queueDepositIds = depositIds.map(String);
        } catch (error) {
          this.logger.error('Failed to parse txData', {
            error: error instanceof Error ? error.message : String(error),
            txData: tx.tx_data,
          });
        }
      }

      tx.metadata = {
        queueItemId,
        depositIds: queueDepositIds,
      };

      // Calculate gas parameters
      const gasEstimate = await this.estimateGas(depositIds, tx.profitability);
      const { finalGasLimit, boostedGasPrice } = await this.calculateGasParameters(gasEstimate);

      const claimAndDistributeReward = this.govLstContract.claimAndDistributeReward as GovLstContractMethod;
      if (!claimAndDistributeReward) {
        throw new ContractMethodError('claimAndDistributeReward');
      }

      const txResponse = await claimAndDistributeReward(
        this.config.defaultTipReceiver || this.wallet.address,
        optimalThreshold,
        depositIds,
        {
          gasLimit: finalGasLimit,
          gasPrice: boostedGasPrice,
        },
      );

      this.logger.info('Transaction submitted', {
        id: tx.id,
        hash: txResponse.hash,
      });

      // Process the transaction receipt
      await this.processTransactionReceipt(tx, txResponse);
    } catch (error) {
      this.logger.error('Transaction execution failed', {
        id: tx.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.handleTransactionError(tx, error);
    }
  }

  /**
   * Estimates gas for a transaction
   * @param depositIds - Array of deposit IDs
   * @param profitability - Profitability check results
   * @returns Estimated gas amount
   */
  async estimateGas(
    depositIds: bigint[],
    profitability: GovLstProfitabilityCheck,
  ): Promise<bigint> {
    try {
      // Validate inputs
      if (!depositIds.length) {
        throw new Error('No deposit IDs provided for gas estimation');
      }

      if (!profitability.estimates.payout_amount) {
        throw new Error('Invalid payout amount in profitability check');
      }

      // Get current gas price with buffer
      const feeData = await this.provider.getFeeData();
      if (!feeData.gasPrice) {
        throw new Error('Failed to get gas price from provider');
      }

      const tipReceiver = this.config.defaultTipReceiver || this.wallet.address;
      if (!tipReceiver) {
        throw new Error('No tip receiver configured');
      }

      // First try to estimate with actual values
      try {
        const gasEstimate =
          await this.govLstContract.estimateGas.claimAndDistributeReward(
            tipReceiver,
            profitability.estimates.payout_amount,
            depositIds,
          );
        return BigInt(gasEstimate.toString());
      } catch (estimateError) {
        this.logger.warn(
          'Initial gas estimation failed, trying with minimum values',
          {
            error:
              estimateError instanceof Error
                ? estimateError.message
                : String(estimateError),
          },
        );

        // If that fails, try with minimum values
        try {
          const minPayout = BigInt(1); // Minimum possible payout
          const gasEstimate =
            await this.govLstContract.estimateGas.claimAndDistributeReward(
              tipReceiver,
              minPayout,
              depositIds,
            );
          return BigInt(gasEstimate.toString());
        } catch (fallbackError) {
          // If both attempts fail, throw with detailed error
          throw new GasEstimationError(fallbackError as Error, {
            depositIds: depositIds.map((id) => id.toString()),
            payoutAmount: profitability.estimates.payout_amount.toString(),
            tipReceiver,
          });
        }
      }
    } catch (error) {
      throw new GasEstimationError(error as Error, {
        depositIds: depositIds.map((id) => id.toString()),
      });
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
    const finalGasLimit = calculateGasLimit(gasEstimate, 1, this.logger);
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
    txResponse: ContractTransactionResponse,
  ): Promise<void> {
    try {
      let receipt;
      let isSuccess = false;

      try {
        receipt = await pollForReceipt(
          txResponse.hash,
          this.provider,
          this.logger,
          1,
        );
        isSuccess = receipt?.status === 1;
      } catch (waitError) {
        this.logger.warn('Transaction confirmation failed', {
          error: waitError instanceof Error ? waitError.message : String(waitError),
          hash: txResponse.hash,
        });
      }

      // Update transaction status
      tx.status = isSuccess ? TransactionStatus.CONFIRMED : TransactionStatus.FAILED;
      tx.hash = txResponse.hash;
      tx.gasPrice = txResponse.gasPrice || 0n;
      tx.gasLimit = receipt?.gasUsed || 0n;
      tx.executedAt = new Date();

      // Log appropriate event
      if (isSuccess) {
        this.logger.info(BASE_EVENTS.TRANSACTION_CONFIRMED, {
          id: tx.id,
          hash: txResponse.hash,
          blockNumber: receipt?.blockNumber,
        });
      } else {
        this.logger.error(BASE_EVENTS.TRANSACTION_FAILED, {
          id: tx.id,
          hash: txResponse.hash,
        });
      }

      // Clean up queue items and update queue
      await this.cleanupQueueItems(tx, txResponse.hash);
      this.queue.set(tx.id, tx);
      this.queue.delete(tx.id);
    } catch (error) {
      await this.handleTransactionError(tx, error);
    }
  }

  /**
   * Handles transaction errors
   * @param tx - Failed transaction
   * @param error - Error that occurred
   */
  private async handleTransactionError(
    tx: QueuedTransaction,
    error: unknown,
  ): Promise<void> {
    tx.status = TransactionStatus.FAILED;
    tx.error = error as Error;
    this.queue.set(tx.id, tx);

    const executorError = new TransactionExecutionError(
      tx.id,
      error instanceof Error ? error : new Error(String(error)),
      {
        depositIds: tx.depositIds.map(String),
        profitability: tx.profitability,
      },
    );
    this.logger.error(BASE_EVENTS.ERROR, {
      ...executorError,
      ...executorError.context,
    });

    // Clean up queue items
    await this.cleanupQueueItems(tx, tx.hash || '');

    // Remove from in-memory queue
    this.queue.delete(tx.id);
  }

  /**
   * Cleans up queue items after transaction completion (success or failure)
   * @param tx - Transaction that completed
   * @param txHash - Transaction hash
   */
  private async cleanupQueueItems(
    tx: QueuedTransaction,
    txHash: string,
  ): Promise<void> {
    if (!this.db) return;

    try {
      // Use the centralized helper to extract queue item info
      const { queueItemId, depositIds: extractedDepositIds } =
        extractQueueItemInfo(tx);
      let depositIdStrings = [...extractedDepositIds]; // Make a mutable copy

      // If we have a specific queue item ID
      if (queueItemId) {
        // First try to get additional deposit IDs from the database if needed
        if (depositIdStrings.length === 0) {
          const queueItem = await this.db.getTransactionQueueItem(queueItemId);
          if (queueItem) {
            // Try to extract deposit IDs from the tx_data JSON
            if (queueItem.tx_data) {
              try {
                const txData = JSON.parse(queueItem.tx_data);
                if (Array.isArray(txData.depositIds)) {
                  depositIdStrings = txData.depositIds.map(String);
                  this.logger.info('Found deposit IDs in tx_data:', {
                    depositIds: depositIdStrings,
                  });
                }
              } catch (parseError) {
                this.logger.error('Failed to parse tx_data JSON:', {
                  error:
                    parseError instanceof Error
                      ? parseError.message
                      : String(parseError),
                });
              }
            }

            // If we still have no deposit IDs, check if deposit_id field has a single ID
            if (depositIdStrings.length === 0 && queueItem.deposit_id) {
              // Use the deposit_id directly (will be a single ID in Supabase case)
              depositIdStrings = [queueItem.deposit_id];
              this.logger.info('Using single deposit ID from queue item:', {
                depositId: queueItem.deposit_id,
              });
            }
          }
        }

        // Update transaction queue item status first
        await this.db.updateTransactionQueueItem(queueItemId, {
          status:
            tx.status === TransactionStatus.CONFIRMED
              ? TransactionQueueStatus.CONFIRMED
              : TransactionQueueStatus.FAILED,
          hash: txHash,
          error:
            tx.status === TransactionStatus.FAILED
              ? tx.error?.message || 'Transaction failed'
              : undefined,
        });

        // Delete transaction queue item
        await this.db.deleteTransactionQueueItem(queueItemId);

        this.logger.info('Deleted transaction queue item', {
          queueItemId,
          txHash,
        });
      }

      // Clean up processing queue items for all deposit IDs
      if (depositIdStrings.length > 0) {
        for (const depositId of depositIdStrings) {
          try {
            const processingItem =
              await this.db.getProcessingQueueItemByDepositId(depositId);
            if (processingItem) {
              // Update status before deletion for record keeping
              await this.db.updateProcessingQueueItem(processingItem.id, {
                status:
                  tx.status === TransactionStatus.CONFIRMED
                    ? ProcessingQueueStatus.COMPLETED
                    : ProcessingQueueStatus.FAILED,
                error:
                  tx.status === TransactionStatus.FAILED
                    ? tx.error?.message || 'Transaction failed'
                    : undefined,
              });

              // Then delete
              await this.db.deleteProcessingQueueItem(processingItem.id);

              this.logger.info('Deleted processing queue item', {
                processingItemId: processingItem.id,
                depositId,
                txHash,
              });
            }
          } catch (error) {
            this.logger.error('Failed to clean up processing queue item', {
              error: error instanceof Error ? error.message : String(error),
              depositId,
              txHash,
            });
          }
        }
      }

      // If we couldn't find specific items, log a warning
      if (!queueItemId && depositIdStrings.length === 0) {
        this.logger.warn('Unable to identify queue items to clean up', {
          txId: tx.id,
          txHash,
        });
      }
    } catch (error) {
      this.logger.error('Failed to clean up queue items', {
        error: error instanceof Error ? error.message : String(error),
        txId: tx.id,
        txHash,
      });
    }
  }

  /**
   * Requeues pending items from the database
   */
  private async requeuePendingItems(): Promise<void> {
    if (!this.db) return;

    try {
      const pendingItems = await this.db.getTransactionQueueItemsByStatus(
        TransactionQueueStatus.PENDING,
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
            item.tx_data,
          );
        } catch (error) {
          this.logger.error('Failed to requeue transaction', {
            depositId: item.deposit_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      const executorError = new Error(
        'Failed to requeue pending items',
      ) as GovLstExecutorError;
      executorError.context = {
        error: error instanceof Error ? error.message : String(error),
      };
      this.logger.error(BASE_EVENTS.ERROR, {
        ...executorError,
        ...executorError.context,
      });
    }
  }

  protected async validateTipReceiver(): Promise<void> {
    if (!this.config.defaultTipReceiver)
      throw new TransactionValidationError('No tip receiver configured', {
        config: this.config,
      });
  }
}
