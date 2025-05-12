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
import { TransactionQueueStatus } from '@/database/interfaces/types';
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
  pollForReceipt,
  validateTransaction,
  calculateQueueStats,
} from '@/configuration/helpers';
import {
  calculateGasParameters,
  cleanupQueueItems,
  calculateOptimalThreshold,
  cleanupStaleTransactions,
} from './helpers';
import { GasCostEstimator } from '@/prices/GasCostEstimator';
import { ErrorLogger } from '@/configuration/errorLogger';
import { BASE_EVENTS, BASE_QUEUE } from './constants';
import { SimulationService } from '@/simulation';
import { SimulationTransaction } from '@/simulation/interfaces';

// Extended executor config with error logger
export interface ExtendedExecutorConfig extends ExecutorConfig {
  errorLogger?: ErrorLogger;
}

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
  REWARD_TOKEN(): Promise<string>;
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
  private readonly errorLogger?: ErrorLogger;
  private readonly wallet: ethers.Wallet;
  private readonly queue: Map<string, QueuedTransaction>;
  private isRunning: boolean;
  private processingInterval: NodeJS.Timeout | null;
  private db?: DatabaseWrapper; // Database access for transaction queue
  protected readonly govLstContract: GovLstContract;
  private readonly provider: ethers.Provider;
  private readonly config: ExecutorConfig;
  private readonly gasCostEstimator: GasCostEstimator;
  private readonly simulationService: SimulationService | null;

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
    config: ExtendedExecutorConfig;
  }) {
    if (!provider) throw new ExecutorError('Provider is required', {}, false);

    this.logger = new ConsoleLogger('info');
    this.errorLogger = config.errorLogger;
    this.wallet = new ethers.Wallet(config.wallet.privateKey, provider);
    this.queue = new Map();
    this.isRunning = false;
    this.processingInterval = null;
    this.provider = provider;
    this.config = config;

    // Initialize simulation service (with fallback)
    try {
      if (CONFIG.tenderly.useSimulation) {
        this.simulationService = new SimulationService();
        this.logger.info(
          'Initialized simulation service for transaction validation',
        );
      } else {
        this.simulationService = null;
        this.logger.info('Simulation service disabled by configuration');
      }
    } catch (error) {
      this.logger.warn(
        'Failed to initialize simulation service, will use fallback gas estimation',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      this.simulationService = null;
    }

    // Initialize contract
    this.govLstContract = new ethers.Contract(
      contractAddress,
      contractAbi,
      this.wallet,
    ) as unknown as GovLstContract;

    if (
      !this.govLstContract.interface.hasFunction('claimAndDistributeReward')
    ) {
      const error = new ContractMethodError('claimAndDistributeReward');
      if (this.errorLogger) {
        this.errorLogger
          .error(error, {
            context: 'base-executor-initialization',
            contractAddress,
          })
          .catch(console.error);
      }
      throw error;
    }

    this.gasCostEstimator = new GasCostEstimator();
  }

  /**
   * Starts the executor service
   * Initializes queue processing and requeues any pending transactions
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    try {
      this.isRunning = true;
      this.startQueueProcessor();
      await this.requeuePendingItems();
    } catch (error) {
      this.logger.error('Failed to start executor', { error });
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'base-executor-start',
        });
      }
      throw error;
    }
  }

  /**
   * Stops the executor service
   * Cleans up queue processing
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    try {
      this.isRunning = false;
      this.stopQueueProcessor();
    } catch (error) {
      this.logger.error('Failed to stop executor', { error });
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'base-executor-stop',
        });
      }
      throw error;
    }
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
    try {
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
    } catch (error) {
      this.logger.error('Failed to get executor status', { error });
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'base-executor-get-status',
        });
      }
      throw error;
    }
  }

  async queueTransaction(
    depositIds: bigint[],
    profitability: GovLstProfitabilityCheck,
    txData?: string,
  ): Promise<QueuedTransaction> {
    // Validate state and inputs
    if (!this.isRunning) {
      const error = new ExecutorError('Executor is not running', {}, false);
      if (this.errorLogger) {
        await this.errorLogger.warn(error, {
          context: 'base-executor-queue-transaction-not-running',
        });
      }
      throw error;
    }

    if (this.queue.size >= this.config.maxQueueSize) {
      const error = new QueueOperationError(
        'queue',
        new Error('Queue is full'),
        {
          maxSize: this.config.maxQueueSize,
        },
      );
      if (this.errorLogger) {
        await this.errorLogger.warn(error, {
          context: 'base-executor-queue-full',
          maxSize: this.config.maxQueueSize,
        });
      }
      throw error;
    }

    // Validate the transaction
    const { isValid, error } = await this.validateTransaction(
      depositIds,
      profitability,
    );
    if (!isValid) {
      if (this.errorLogger) {
        await this.errorLogger.warn(error as Error, {
          context: 'base-executor-transaction-validation-failed',
          depositIds: depositIds.map(String),
        });
      }
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
    try {
      // First try simulation-based gas estimation if available
      if (this.simulationService) {
        try {
          const signerAddress = this.wallet.address;
          const payoutAmount =
            profitability.estimates.payout_amount || BigInt(0);

          // Use a minimal expected reward for estimation
          const simulatedGas = await this.estimateGasUsingSimulation(
            depositIds,
            signerAddress,
            payoutAmount,
          );

          if (
            simulatedGas !== null &&
            simulatedGas > profitability.estimates.gas_estimate
          ) {
            this.logger.info('Updated gas estimate from simulation', {
              originalEstimate: profitability.estimates.gas_estimate.toString(),
              simulatedEstimate: simulatedGas.toString(),
              depositCount: depositIds.length,
            });

            // Update the gas estimate in the profitability object
            profitability.estimates.gas_estimate = simulatedGas;
          }
        } catch (error) {
          // Just log and continue with original estimate if simulation fails
          this.logger.warn(
            'Simulation-based gas estimation failed during validation',
            {
              error: error instanceof Error ? error.message : String(error),
              depositIds: depositIds.map(String),
            },
          );
        }
      }

      // Use the centralized validation function
      const baseValidation = await validateTransaction(
        depositIds,
        profitability,
        this.queue,
      );
      if (!baseValidation.isValid) {
        const error = new TransactionValidationError(
          baseValidation.error?.message || 'Transaction validation failed',
          {
            depositIds: depositIds.map(String),
          },
        );
        if (this.errorLogger) {
          await this.errorLogger.warn(error, {
            context: 'base-executor-transaction-validation',
            depositIds: depositIds.map(String),
          });
        }
        return {
          isValid: false,
          error,
        };
      }

      // Get current gas price and calculate gas cost
      const feeData = await this.provider.getFeeData();
      if (!feeData.gasPrice) {
        const error = new TransactionValidationError(
          'Failed to get gas price from provider',
          {
            feeData: feeData,
          },
        );
        if (this.errorLogger) {
          await this.errorLogger.warn(error, {
            context: 'base-executor-gas-price-missing',
          });
        }
        return {
          isValid: false,
          error,
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
          const error = new TransactionValidationError(
            'Contract missing payoutAmount method',
            {
              contract: this.govLstContract,
            },
          );
          if (this.errorLogger) {
            await this.errorLogger.error(error, {
              context: 'base-executor-missing-payout-method',
            });
          }
          return {
            isValid: false,
            error,
          };
        }
      } catch (error) {
        // Use the payout amount from profitability check as fallback
        this.logger.warn('Using fallback payout amount', {
          error: error instanceof Error ? error.message : String(error),
        });

        if (this.errorLogger) {
          await this.errorLogger.warn(error as Error, {
            context: 'base-executor-fallback-payout-amount',
          });
        }

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
        (baseAmountForMargin *
          BigInt(Math.round(minProfitMarginPercent * 100))) /
        10000n; // Multiply by 100 for percentage, divide by 10000 (100*100)

      // Validate that expected reward is sufficient
      if (
        profitability.estimates.expected_profit <
        baseAmountForMargin + requiredProfitValue
      ) {
        const error = new TransactionValidationError(
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
        if (this.errorLogger) {
          await this.errorLogger.warn(error, {
            context: 'base-executor-insufficient-reward',
          });
        }

        throw error;
      }

      return {
        isValid: true,
        error: null,
      };
    } catch (error) {
      if (this.errorLogger && !(error instanceof TransactionValidationError)) {
        await this.errorLogger.error(error as Error, {
          context: 'base-executor-transaction-validation-error',
          depositIds: depositIds.map(String),
        });
      }

      if (error instanceof TransactionValidationError) {
        return { isValid: false, error };
      }

      const wrappedError = new TransactionValidationError(
        error instanceof Error ? error.message : String(error),
        { depositIds: depositIds.map(String) },
      );
      return { isValid: false, error: wrappedError };
    }
  }

  /**
   * Gets statistics about the transaction queue
   * @returns Queue statistics including counts and gas usage
   */
  async getQueueStats(): Promise<QueueStats> {
    try {
      return calculateQueueStats(Array.from(this.queue.values()));
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'base-executor-get-queue-stats',
        });
      }
      throw new QueueOperationError('queue_stats', error as Error, {});
    }
  }

  /**
   * Gets a specific transaction by ID
   * @param id - Transaction ID
   * @returns Transaction object or null if not found
   */
  async getTransaction(id: string): Promise<QueuedTransaction | null> {
    try {
      return this.queue.get(id) || null;
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'base-executor-get-transaction',
          transactionId: id,
        });
      }
      throw new QueueOperationError('get_transaction', error as Error, { id });
    }
  }

  /**
   * Gets a transaction receipt
   * @param hash - Transaction hash
   * @returns Transaction receipt or null if not found
   */
  async getTransactionReceipt(
    hash: string,
  ): Promise<TransactionReceipt | null> {
    try {
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
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'base-executor-get-transaction-receipt',
          transactionHash: hash,
        });
      }
      throw new TransactionExecutionError('get_receipt', error as Error, {
        hash,
      });
    }
  }

  /**
   * Transfers accumulated tips to the configured receiver
   * @returns Transaction receipt or null if transfer not needed/possible
   */
  async transferOutTips(): Promise<TransactionReceipt | null> {
    try {
      if (!this.config.defaultTipReceiver) {
        const error = new Error('No tip receiver configured');
        if (this.errorLogger) {
          await this.errorLogger.error(error, {
            context: 'base-executor-no-tip-receiver',
          });
        }
        throw error;
      }

      const balance = await this.getWalletBalance();
      if (balance < this.config.transferOutThreshold) return null;

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

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'base-executor-transfer-tips',
          receiver: this.config.defaultTipReceiver,
        });
      }

      throw new TransactionExecutionError(
        'transfer_tips',
        error instanceof Error ? error : new Error(String(error)),
        {
          amount:
            error instanceof Error && 'balance' in error
              ? (
                  (error as Error & { balance: bigint }).balance -
                  this.config.wallet.minBalance
                ).toString()
              : 'unknown',
          receiver: this.config.defaultTipReceiver,
        },
      );
    }
  }

  /**
   * Clears the transaction queue
   */
  async clearQueue(): Promise<void> {
    try {
      this.queue.clear();
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'base-executor-clear-queue',
        });
      }
      throw new QueueOperationError('clear_queue', error as Error, {});
    }
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

      // Run stale transaction cleanup (default 5 minutes)
      const staleThresholdMinutes =
        this.config.staleTransactionThresholdMinutes || 5;
      const cleanupResult = await cleanupStaleTransactions(
        this.queue,
        staleThresholdMinutes,
        this.db,
        this.logger,
        this.errorLogger,
      );

      if (cleanupResult.staleCount > 0) {
        this.logger.info('Cleaned up stale transactions', {
          staleCount: cleanupResult.staleCount,
          cleanedIds: cleanupResult.cleanedIds,
        });
      }

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
        type: typeof gasCost,
      });

      // Calculate optimal threshold
      const optimalThreshold = calculateOptimalThreshold(
        payoutAmount,
        gasCost,
        this.config.minProfitMargin,
        this.logger,
      );

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

      // Run transaction simulation if available
      if (this.simulationService) {
        try {
          const simulationResult = await this.simulateTransaction(
            tx,
            depositIds,
            this.wallet.address,
            optimalThreshold,
            tx.profitability.estimates.gas_estimate,
          );

          if (!simulationResult.success) {
            // If simulation explicitly failed (not due to service error), reject the transaction
            this.logger.error(
              'Transaction simulation explicitly failed, removing from queue',
              {
                txId: tx.id,
                error: simulationResult.error,
              },
            );

            if (this.errorLogger) {
              await this.errorLogger.error(
                new TransactionValidationError(
                  `Transaction simulation failed: ${simulationResult.error}`,
                  { depositIds: depositIds.map(String) },
                ),
                {
                  stage: 'executeTransaction_simulation',
                  txId: tx.id,
                  error: simulationResult.error,
                },
              );
            }

            // Update transaction status to failed
            tx.status = TransactionStatus.FAILED;
            tx.error = new Error(
              `Simulation failed: ${simulationResult.error}`,
            );
            this.queue.set(tx.id, tx);

            // Cleanup the queue item
            await cleanupQueueItems(
              tx,
              '',
              this.db,
              this.logger,
              this.errorLogger,
            );

            // Check token swap after transaction completes
            await this.checkAndSwapTokensIfNeeded();

            // Remove from queue and exit
            this.queue.delete(tx.id);
            return;
          }

          // Use gas limit from simulation if available
          if (simulationResult.optimizedGasLimit) {
            this.logger.info('Using optimized gas limit from simulation', {
              originalEstimate:
                tx.profitability.estimates.gas_estimate.toString(),
              optimizedLimit: simulationResult.optimizedGasLimit.toString(),
            });
            tx.profitability.estimates.gas_estimate =
              simulationResult.optimizedGasLimit;
          } else if (simulationResult.gasEstimate) {
            this.logger.info('Using gas estimate from simulation', {
              originalEstimate:
                tx.profitability.estimates.gas_estimate.toString(),
              simulationEstimate: simulationResult.gasEstimate.toString(),
            });
            tx.profitability.estimates.gas_estimate =
              simulationResult.gasEstimate;
          }
        } catch (simError) {
          // If simulation fails with an exception, log but continue with standard parameters
          this.logger.warn(
            'Transaction simulation error, continuing with standard parameters',
            {
              error:
                simError instanceof Error ? simError.message : String(simError),
              txId: tx.id,
            },
          );

          if (this.errorLogger) {
            await this.errorLogger.warn(
              simError instanceof Error
                ? simError
                : new Error(`Simulation error: ${String(simError)}`),
              {
                stage: 'executeTransaction_simulationError',
                txId: tx.id,
              },
            );
          }
        }
      }

      // Calculate gas parameters
      const gasEstimate = await this.estimateGas(depositIds, tx.profitability);
      const { finalGasLimit, boostedGasPrice } =
        await this.calculateGasParameters(gasEstimate);

      const claimAndDistributeReward = this.govLstContract
        .claimAndDistributeReward as GovLstContractMethod;
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
        const error = new Error('No deposit IDs provided for gas estimation');
        if (this.errorLogger) {
          await this.errorLogger.warn(error, {
            context: 'base-executor-estimate-gas-no-deposit-ids',
          });
        }
        throw error;
      }

      if (!profitability.estimates.payout_amount) {
        const error = new Error('Invalid payout amount in profitability check');
        if (this.errorLogger) {
          await this.errorLogger.warn(error, {
            context: 'base-executor-estimate-gas-invalid-payout',
          });
        }
        throw error;
      }

      // Get current gas price with buffer
      const feeData = await this.provider.getFeeData();
      if (!feeData.gasPrice) {
        const error = new Error('Failed to get gas price from provider');
        if (this.errorLogger) {
          await this.errorLogger.warn(error, {
            context: 'base-executor-estimate-gas-no-gas-price',
          });
        }
        throw error;
      }

      const tipReceiver = this.config.defaultTipReceiver || this.wallet.address;
      if (!tipReceiver) {
        const error = new Error('No tip receiver configured');
        if (this.errorLogger) {
          await this.errorLogger.warn(error, {
            context: 'base-executor-estimate-gas-no-tip-receiver',
          });
        }
        throw error;
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

        if (this.errorLogger) {
          await this.errorLogger.warn(estimateError as Error, {
            context: 'base-executor-estimate-gas-initial-failed',
            depositIds: depositIds.map(String),
          });
        }

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
          if (this.errorLogger) {
            await this.errorLogger.error(fallbackError as Error, {
              context: 'base-executor-estimate-gas-fallback-failed',
              depositIds: depositIds.map(String),
            });
          }

          throw new GasEstimationError(fallbackError as Error, {
            depositIds: depositIds.map((id) => id.toString()),
            payoutAmount: profitability.estimates.payout_amount.toString(),
            tipReceiver,
          });
        }
      }
    } catch (error) {
      if (this.errorLogger && !(error instanceof GasEstimationError)) {
        await this.errorLogger.error(error as Error, {
          context: 'base-executor-estimate-gas-error',
          depositIds: depositIds.map(String),
        });
      }

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
    return calculateGasParameters(
      this.provider,
      gasEstimate,
      this.config.gasBoostPercentage,
      this.logger,
    );
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
          error:
            waitError instanceof Error ? waitError.message : String(waitError),
          hash: txResponse.hash,
        });

        if (this.errorLogger) {
          await this.errorLogger.warn(waitError as Error, {
            context: 'base-executor-poll-receipt-failed',
            hash: txResponse.hash,
            txId: tx.id,
          });
        }
      }

      // Update transaction status
      tx.status = isSuccess
        ? TransactionStatus.CONFIRMED
        : TransactionStatus.FAILED;
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

        if (this.errorLogger) {
          await this.errorLogger.error(new Error('Transaction failed'), {
            context: 'base-executor-transaction-failed',
            txId: tx.id,
            hash: txResponse.hash,
          });
        }
      }

      // Clean up queue items and update queue
      await cleanupQueueItems(
        tx,
        txResponse.hash,
        this.db,
        this.logger,
        this.errorLogger,
      );
      this.queue.set(tx.id, tx);
      this.queue.delete(tx.id);

      // Check if we need to swap tokens for ETH after transaction
      await this.checkAndSwapTokensIfNeeded();
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'base-executor-process-receipt-error',
          txId: tx.id,
          hash: txResponse.hash || 'unknown',
        });
      }

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

    if (this.errorLogger) {
      await this.errorLogger.error(executorError, {
        context: 'base-executor-transaction-execution-error',
        txId: tx.id,
      });
    }

    // Clean up queue items
    await cleanupQueueItems(
      tx,
      tx.hash || '',
      this.db,
      this.logger,
      this.errorLogger,
    );

    // Remove from in-memory queue
    this.queue.delete(tx.id);

    // Check if we need to swap tokens for ETH even after failure
    await this.checkAndSwapTokensIfNeeded();
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

          if (this.errorLogger) {
            await this.errorLogger.error(error as Error, {
              context: 'base-executor-requeue-transaction-failed',
              depositId: item.deposit_id,
            });
          }
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

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'base-executor-requeue-pending-items-failed',
        });
      }
    }
  }

  protected async validateTipReceiver(): Promise<void> {
    try {
      if (!this.config.defaultTipReceiver) {
        const error = new TransactionValidationError(
          'No tip receiver configured',
          {
            config: this.config,
          },
        );

        if (this.errorLogger) {
          await this.errorLogger.warn(error, {
            context: 'base-executor-validate-tip-receiver-missing',
          });
        }

        throw error;
      }
    } catch (error) {
      if (this.errorLogger && !(error instanceof TransactionValidationError)) {
        await this.errorLogger.error(error as Error, {
          context: 'base-executor-validate-tip-receiver-error',
        });
      }

      throw error;
    }
  }

  // Add helper function for BigInt serialization
  private serializeBigIntValues(
    obj: Record<string, unknown> | unknown[] | unknown,
  ): Record<string, unknown> | unknown[] | unknown {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === 'bigint') {
      return obj.toString();
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.serializeBigIntValues(item));
    }

    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(
        obj as Record<string, unknown>,
      )) {
        result[key] = this.serializeBigIntValues(value);
      }
      return result;
    }

    return obj;
  }

  /**
   * Simulates a transaction to verify it will succeed and estimate gas costs
   * This uses Tenderly simulation API to validate the transaction without submitting to the chain
   *
   * @param depositIds List of deposit IDs
   * @param signerAddress The address that will sign the transaction
   * @param minExpectedReward Minimum expected reward
   * @param gasLimit Initial gas limit to use for simulation
   * @returns Object containing simulation results and gas parameters
   */
  private async simulateTransaction(
    tx: QueuedTransaction,
    depositIds: bigint[],
    signerAddress: string,
    minExpectedReward: bigint,
    gasLimit: bigint,
  ): Promise<{
    success: boolean;
    gasEstimate: bigint | null;
    error?: string;
    optimizedGasLimit?: bigint;
  }> {
    if (!this.simulationService) {
      this.logger.warn(
        'Simulation service not available, skipping simulation',
        {
          txId: tx.id,
        },
      );
      return { success: true, gasEstimate: null }; // Default to success if service not available
    }

    try {
      // Get the contract data for the transaction
      const data = this.govLstContract.interface.encodeFunctionData(
        'claimAndDistributeReward',
        [signerAddress, minExpectedReward, depositIds],
      );

      const contractAddress = this.govLstContract.target.toString();

      // Create simulation transaction object
      const simulationTx: SimulationTransaction = {
        from: signerAddress,
        to: contractAddress,
        data,
        gas: Number(gasLimit),
        value: '0',
      };

      this.logger.info('Simulating transaction', {
        txId: tx.id,
        depositIds: depositIds.map(String),
        minExpectedReward: minExpectedReward.toString(),
        recipient: signerAddress,
        gasLimit: gasLimit.toString(),
      });

      // First try to get gas estimation (faster)
      let gasEstimate: bigint | null = null;
      try {
        const gasEstimation = await this.simulationService.estimateGasCosts(
          simulationTx,
          {
            networkId: CONFIG.tenderly.networkId || '1',
          },
        );

        gasEstimate = BigInt(Math.ceil(gasEstimation.gasUnits * 1.3)); // Add 30% buffer
        this.logger.info('Transaction gas estimation successful', {
          txId: tx.id,
          estimatedGas: gasEstimation.gasUnits,
          bufferedGas: gasEstimate.toString(),
        });
      } catch (estimateError) {
        this.logger.warn(
          'Failed to estimate gas via simulation, will fall back to simulation',
          {
            error:
              estimateError instanceof Error
                ? estimateError.message
                : String(estimateError),
            txId: tx.id,
          },
        );
      }

      // Then run full simulation to check for other issues
      const simulationResult = await this.simulationService.simulateTransaction(
        simulationTx,
        {
          networkId: CONFIG.tenderly.networkId || '1',
        },
      );

      // If simulation fails but the error is gas-related, try again with higher gas
      if (
        !simulationResult.success &&
        simulationResult.error?.code === 'GAS_LIMIT_EXCEEDED' &&
        simulationResult.gasUsed > 0
      ) {
        const newGasLimit = BigInt(Math.ceil(simulationResult.gasUsed * 1.5)); // 50% buffer

        const retrySimulationTx = {
          ...simulationTx,
          gas: Number(newGasLimit),
        };

        this.logger.info('Retrying simulation with higher gas limit', {
          txId: tx.id,
          originalGasLimit: gasLimit.toString(),
          newGasLimit: newGasLimit.toString(),
        });

        const retryResult = await this.simulationService.simulateTransaction(
          retrySimulationTx,
          {
            networkId: CONFIG.tenderly.networkId || '1',
          },
        );

        if (retryResult.success) {
          this.logger.info(
            'Transaction simulation succeeded with higher gas limit',
            {
              txId: tx.id,
              gasUsed: retryResult.gasUsed,
              optimizedGasLimit: newGasLimit.toString(),
            },
          );

          return {
            success: true,
            gasEstimate:
              gasEstimate || BigInt(Math.ceil(retryResult.gasUsed * 1.2)),
            optimizedGasLimit: newGasLimit,
          };
        }
      }

      if (!simulationResult.success) {
        this.logger.warn('Transaction simulation failed', {
          txId: tx.id,
          errorCode: simulationResult.error?.code,
          errorMessage: simulationResult.error?.message,
          errorDetails: simulationResult.error?.details,
        });

        return {
          success: false,
          gasEstimate: null,
          error: `${simulationResult.error?.code}: ${simulationResult.error?.message}`,
        };
      }

      // Use gas from simulation if it's higher than our estimate (plus buffer)
      if (simulationResult.gasUsed > 0) {
        const simulationGas = BigInt(Math.ceil(simulationResult.gasUsed * 1.2)); // 20% buffer
        if (!gasEstimate || simulationGas > gasEstimate) {
          gasEstimate = simulationGas;
        }
      }

      this.logger.info('Transaction simulation successful', {
        txId: tx.id,
        gasUsed: simulationResult.gasUsed,
        estimatedGas: gasEstimate?.toString(),
        simulationStatus: simulationResult.status,
      });

      return {
        success: true,
        gasEstimate,
      };
    } catch (error) {
      this.logger.error('Transaction simulation error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        txId: tx.id,
      });

      // Return success true with null gasEstimate to allow fallback to normal gas estimation
      return {
        success: true,
        gasEstimate: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Estimates gas for a transaction using simulation
   * This is a lighter-weight method that only calls the gas estimation part of the simulation
   *
   * @param depositIds List of deposit IDs
   * @param recipient The recipient address
   * @param reward The expected reward amount
   * @returns Estimated gas or null if simulation fails
   */
  private async estimateGasUsingSimulation(
    depositIds: bigint[],
    recipient: string,
    reward: bigint,
  ): Promise<bigint | null> {
    if (!this.simulationService) {
      return null; // Simulation service not available
    }

    try {
      // Encode transaction data
      const data = this.govLstContract.interface.encodeFunctionData(
        'claimAndDistributeReward',
        [recipient, reward, depositIds],
      );

      // Create simulation transaction with a high gas limit to ensure it doesn't fail due to gas
      const simulationTx: SimulationTransaction = {
        from: recipient,
        to: this.govLstContract.target.toString(),
        data,
        gas: 5000000, // 5M gas as a high limit for estimation
        value: '0',
      };

      // Get gas estimation
      const gasEstimation = await this.simulationService.estimateGasCosts(
        simulationTx,
        {
          networkId: CONFIG.tenderly.networkId || '1',
        },
      );

      // Add 30% buffer to the estimate
      const gasEstimate = BigInt(Math.ceil(gasEstimation.gasUnits * 1.3));

      this.logger.info('Estimated gas using simulation', {
        depositCount: depositIds.length,
        rawEstimate: gasEstimation.gasUnits,
        bufferedEstimate: gasEstimate.toString(),
      });

      return gasEstimate;
    } catch (error) {
      this.logger.warn('Failed to estimate gas using simulation', {
        error: error instanceof Error ? error.message : String(error),
        depositCount: depositIds.length,
      });
      return null;
    }
  }

  /**
   * Checks ETH balance and swaps tokens if needed
   */
  private async checkAndSwapTokensIfNeeded(): Promise<void> {
    // Only proceed if swap is enabled
    if (!CONFIG.executor.swap.enabled) {
      return;
    }

    try {
      // Check ETH balance
      const ethBalance = await this.provider.getBalance(this.wallet.address);
      const minEthBalance = ethers.parseEther('0.1'); // 0.1 ETH threshold

      if (ethBalance < minEthBalance) {
        this.logger.info(
          'ETH balance below threshold, attempting to swap tokens',
          {
            currentBalance: ethers.formatEther(ethBalance),
            threshold: '0.1 ETH',
          },
        );

        await this.swapTokensForEth();
      }
    } catch (error) {
      this.logger.error('Failed to check ETH balance', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'base-executor-check-eth-balance-error',
        });
      }
    }
  }

  /**
   * Swaps tokens for ETH using Uniswap
   */
  private async swapTokensForEth(): Promise<void> {
    if (
      !CONFIG.executor.swap.enabled ||
      !CONFIG.executor.swap.uniswapRouterAddress
    ) {
      this.logger.warn('Token swap not configured properly');
      return;
    }

    try {
      // Get the reward token address
      if (typeof this.govLstContract.REWARD_TOKEN !== 'function') {
        throw new Error('REWARD_TOKEN method not found on contract');
      }

      const rewardTokenAddress = await this.govLstContract.REWARD_TOKEN();
      if (!rewardTokenAddress) {
        throw new Error('Failed to get reward token address');
      }

      // Create token contract
      const tokenAbi = [
        'function balanceOf(address account) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
        'function decimals() view returns (uint8)',
      ] as const;

      const tokenContract = new ethers.Contract(
        rewardTokenAddress,
        tokenAbi,
        this.wallet,
      ) as ethers.Contract & {
        balanceOf(account: string): Promise<bigint>;
        approve(
          spender: string,
          amount: bigint,
        ): Promise<ContractTransactionResponse>;
        decimals(): Promise<number>;
      };

      // Create Uniswap router contract
      const uniswapAbi = [
        'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
        'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)',
      ] as const;

      const uniswapRouter = new ethers.Contract(
        CONFIG.executor.swap.uniswapRouterAddress,
        uniswapAbi,
        this.wallet,
      ) as ethers.Contract & {
        swapExactTokensForETH(
          amountIn: bigint,
          amountOutMin: bigint,
          path: string[],
          to: string,
          deadline: number,
        ): Promise<ContractTransactionResponse>;
        getAmountsOut(amountIn: bigint, path: string[]): Promise<bigint[]>;
      };

      // Get token balance
      const tokenBalance = await tokenContract.balanceOf(this.wallet.address);
      const decimals = await tokenContract.decimals();
      const minKeepAmount = ethers.parseUnits('2200', decimals); // Always keep at least 2200 tokens

      this.logger.info('Current token balance', {
        balance: ethers.formatUnits(tokenBalance, decimals),
        minKeepAmount: ethers.formatUnits(minKeepAmount, decimals),
      });

      // Check if we have enough tokens to swap while maintaining minimum balance
      if (tokenBalance <= minKeepAmount) {
        this.logger.warn('Token balance too low for swap', {
          balance: ethers.formatUnits(tokenBalance, decimals),
          minKeepAmount: ethers.formatUnits(minKeepAmount, decimals),
        });
        return;
      }

      // Get contract's payout amount to ensure we don't go below it
      const payoutAmount = await this.govLstContract.payoutAmount();

      // Calculate how much we can swap
      // We want to keep at least max(minKeepAmount, payoutAmount)
      const keepAmount =
        minKeepAmount > payoutAmount ? minKeepAmount : payoutAmount;
      const availableToSwap = tokenBalance - keepAmount;

      // Use half of available tokens, but not more than maxAmountIn
      let swapAmount = availableToSwap / 2n;
      if (swapAmount > CONFIG.executor.swap.maxAmountIn) {
        swapAmount = CONFIG.executor.swap.maxAmountIn;
      }

      // Check minimum swap amount
      if (swapAmount < CONFIG.executor.swap.minAmountIn) {
        this.logger.info('Swap amount below minimum threshold', {
          amount: ethers.formatUnits(swapAmount, decimals),
          minAmount: ethers.formatUnits(
            CONFIG.executor.swap.minAmountIn,
            decimals,
          ),
        });
        return;
      }

      // Set up the swap path and parameters
      const path = [rewardTokenAddress, ethers.ZeroAddress]; // Token -> ETH
      const deadline =
        Math.floor(Date.now() / 1000) +
        CONFIG.executor.swap.deadlineMinutes * 60;

      // Get expected ETH output
      const amountsOut = await uniswapRouter.getAmountsOut(swapAmount, path);
      if (!amountsOut || !Array.isArray(amountsOut) || amountsOut.length < 2) {
        throw new Error('Invalid amounts out from Uniswap');
      }

      // TypeScript safe access to the second element (ETH amount)
      const ethAmountRaw = amountsOut[1];
      if (!ethAmountRaw) {
        throw new Error('ETH output amount is undefined');
      }

      // Convert to BigInt to ensure type safety
      const expectedEthAmount = BigInt(ethAmountRaw.toString());

      // Apply slippage tolerance
      const slippageTolerance = CONFIG.executor.swap.slippageTolerance;
      const minOutputWithSlippage =
        (expectedEthAmount *
          BigInt(Math.floor((1 - slippageTolerance) * 1000))) /
        1000n;

      this.logger.info('Preparing token swap', {
        swapAmount: ethers.formatUnits(swapAmount, decimals),
        expectedEthOutput: ethers.formatEther(expectedEthAmount),
        minOutputWithSlippage: ethers.formatEther(minOutputWithSlippage),
        slippageTolerance: `${slippageTolerance * 100}%`,
      });

      // First approve the router to spend tokens
      const approveTx = await tokenContract.approve(
        CONFIG.executor.swap.uniswapRouterAddress,
        swapAmount,
      );

      this.logger.info('Approval transaction submitted', {
        hash: approveTx.hash,
      });

      // Wait for approval to be mined
      await approveTx.wait();

      // Execute the swap
      const swapTx = await uniswapRouter.swapExactTokensForETH(
        swapAmount,
        minOutputWithSlippage,
        path,
        this.wallet.address,
        deadline,
      );

      this.logger.info('Swap transaction submitted', {
        hash: swapTx.hash,
      });

      // Wait for swap to be mined
      const receipt = await swapTx.wait();

      if (!receipt) {
        throw new Error('No receipt returned from swap transaction');
      }

      this.logger.info('Token swap successful', {
        hash: swapTx.hash,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber,
        tokensSwapped: ethers.formatUnits(swapAmount, decimals),
      });
    } catch (error) {
      this.logger.error('Token swap failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'base-executor-token-swap-error',
        });
      }
    }
  }
}
