import { ethers } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { IExecutor } from '../interfaces/IExecutor';
import {
  RelayerExecutorConfig,
  QueuedTransaction,
  TransactionStatus,
  QueueStats,
  TransactionReceipt,
  GovLstExecutorError,
  EthersTransactionReceipt,
} from '../interfaces/types';
import { GovLstProfitabilityCheck } from '@/profitability/interfaces/types';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseWrapper } from '@/database';
import {
  DefenderRelayProvider,
  DefenderRelaySigner,
} from '@openzeppelin/defender-relay-client/lib/ethers';
import { EXECUTOR } from '@/configuration/constants';
import {
  TransactionQueueStatus,
} from '@/database/interfaces/types';
import {
  ContractMethodError,
  ExecutorError,
  InsufficientBalanceError,
  QueueOperationError,
  TransactionExecutionError,
  TransactionReceiptError,
  TransactionValidationError,
  createExecutorError,
  BaseError,
} from '@/configuration/errors';
import { CONFIG } from '@/configuration';
import {
  calculateGasLimit,
  pollForReceipt,
  validateTransaction,
  calculateQueueStats,
} from '@/configuration/helpers';
import { GasCostEstimator } from '@/prices/GasCostEstimator';
import { ErrorLogger, createErrorLogger } from '@/configuration/errorLogger';

// Local constants used in this file
const RELAYER_EVENTS = {
  TRANSACTION_QUEUED: EXECUTOR.EVENTS.TRANSACTION_QUEUED,
  TRANSACTION_CONFIRMED: EXECUTOR.EVENTS.TRANSACTION_CONFIRMED,
  TRANSACTION_FAILED: EXECUTOR.EVENTS.TRANSACTION_FAILED,
  TIPS_TRANSFERRED: EXECUTOR.EVENTS.TIPS_TRANSFERRED,
  ERROR: EXECUTOR.EVENTS.ERROR,
} as const;

const RELAYER_QUEUE = {
  PROCESSOR_INTERVAL: EXECUTOR.QUEUE.QUEUE_PROCESSOR_INTERVAL,
  MAX_BATCH_SIZE: EXECUTOR.QUEUE.MAX_BATCH_SIZE,
  MIN_BATCH_SIZE: EXECUTOR.QUEUE.MIN_BATCH_SIZE,
} as const;

const RELAYER_PROFITABILITY = {
  INCLUDE_GAS_COST: CONFIG.profitability.includeGasCost,
  MIN_PROFIT_MARGIN: CONFIG.profitability.minProfitMargin,
} as const;

// Add Defender API error interfaces
interface DefenderErrorResponse {
  status: number;
  statusText: string;
  data: {
    error?: {
      code: string;
      message: string;
      suggestedNonce?: number;
      suggestedGasLimit?: string;
    };
  };
}

interface DefenderErrorConfig {
  method?: string;
  url?: string;
  data?: unknown;
}

interface DefenderError extends Error {
  response?: DefenderErrorResponse;
  config?: DefenderErrorConfig;
}

// Add gas estimation error interface
interface GasEstimationError extends Error {
  data?: unknown;
}

export class RelayerExecutor implements IExecutor {
  protected readonly logger: Logger;
  private errorLogger: ErrorLogger;
  protected readonly queue: Map<string, QueuedTransaction>;
  protected readonly relayProvider: DefenderRelayProvider;
  protected readonly relaySigner: DefenderRelaySigner;
  protected isRunning: boolean;
  protected processingInterval: NodeJS.Timeout | null;
  protected lstContract: ethers.Contract & {
    claimAndDistributeReward(
      _recipient: string,
      _minExpectedReward: bigint,
      _depositIds: bigint[],
      options?: ethers.Overrides,
    ): Promise<ethers.ContractTransactionResponse>;
    payoutAmount(): Promise<bigint>;
  };
  protected db?: DatabaseWrapper;
  private readonly gasCostEstimator: GasCostEstimator;
  private cleanupInProgress: Set<string> = new Set(); // Add cleanup lock set

  constructor(
    lstContract: ethers.Contract,
    provider: ethers.Provider,
    protected readonly config: RelayerExecutorConfig,
  ) {
    this.logger = new ConsoleLogger('info');
    this.errorLogger = createErrorLogger('RelayerExecutor');
    this.queue = new Map();
    this.isRunning = false;
    this.processingInterval = null;

    if (!provider) {
      const error = new ExecutorError('Provider is required', {}, false);
      this.errorLogger.error(error, { stage: 'initialization' });
      throw error;
    }

    // Set default maxQueueSize if not provided
    if (!this.config.maxQueueSize) {
      this.config.maxQueueSize = 100; // Default value from constants
    }

    try {
      // Initialize Defender Relay Provider and Signer
      this.relayProvider = new DefenderRelayProvider({
        apiKey: this.config.apiKey,
        apiSecret: this.config.apiSecret,
      });
      this.relaySigner = new DefenderRelaySigner(
        {
          apiKey: this.config.apiKey,
          apiSecret: this.config.apiSecret,
        },
        this.relayProvider,
        { speed: 'fast' },
      );

      // Create contract instance with signer
      this.lstContract = new ethers.Contract(
        lstContract.target as string,
        lstContract.interface,
        this.relaySigner as unknown as ethers.Signer,
      ) as typeof this.lstContract;
    } catch (error) {
      const executorError = new ExecutorError(
        'Failed to initialize Defender SDK',
        { error: error instanceof Error ? error.message : String(error) },
        false,
      );
      this.logger.error('Failed to initialize Defender SDK:', { error });
      this.errorLogger.error(executorError);
      throw executorError;
    }

    // Validate LST contract
    if (!this.lstContract.interface.hasFunction('claimAndDistributeReward')) {
      const error = new ContractMethodError('claimAndDistributeReward');
      this.errorLogger.error(error, { contractAddress: lstContract.target });
      throw error;
    }

    this.gasCostEstimator = new GasCostEstimator();
  }

  // Add setDatabase method
  setDatabase(db: DatabaseWrapper): void {
    this.db = db;
    this.logger.info('Database set for executor');
    // Update the errorLogger with the database
    this.errorLogger = createErrorLogger('RelayerExecutor', db);
    this.errorLogger.info('ErrorLogger initialized with database');
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.startQueueProcessor();
    this.errorLogger.info('RelayerExecutor started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.stopQueueProcessor();
    this.errorLogger.info('RelayerExecutor stopped');
  }

  async getStatus(): Promise<{
    isRunning: boolean;
    walletBalance: bigint;
    pendingTransactions: number;
    queueSize: number;
  }> {
    const balance = await this.lstContract.runner?.provider?.getBalance(
      await this.lstContract.target,
    );
    const pendingTxs = Array.from(this.queue.values()).filter(
      (tx) => tx.status === TransactionStatus.PENDING,
    ).length;

    return {
      isRunning: this.isRunning,
      walletBalance: BigInt(balance?.toString() || '0'),
      pendingTransactions: pendingTxs,
      queueSize: this.queue.size,
    };
  }

  async queueTransaction(
    depositIds: bigint[],
    profitability: GovLstProfitabilityCheck,
    txData?: string,
  ): Promise<QueuedTransaction> {
    if (!this.isRunning) {
      const error = new ExecutorError('Executor is not running', {}, false);
      this.errorLogger.error(error, { stage: 'queueTransaction' });
      throw error;
    }

    if (this.queue.size >= this.config.maxQueueSize) {
      const error = new QueueOperationError('queue', new Error('Queue is full'), {
        maxSize: this.config.maxQueueSize,
      });
      this.errorLogger.error(error, { 
        stage: 'queueTransaction', 
        queueSize: this.queue.size,
        maxQueueSize: this.config.maxQueueSize
      });
      throw error;
    }

    // Check if any of the deposit IDs are being cleaned up
    const depositIdStrings = depositIds.map(String);
    const isCleaningUp = depositIdStrings.some(id => this.cleanupInProgress.has(id));
    if (isCleaningUp) {
      this.logger.info('Skipping queue transaction - cleanup in progress:', {
        depositIds: depositIdStrings
      });
      this.errorLogger.info('Skipping queue transaction - cleanup in progress', {
        depositIds: depositIdStrings
      });
      return {
        id: '',
        depositIds,
        profitability,
        status: TransactionStatus.FAILED,
        createdAt: new Date(),
        error: new Error('Cleanup in progress'),
        tx_data: txData
      };
    }

    // Validate the transaction
    const { isValid, error } = await this.validateTransaction(
      depositIds,
      profitability,
    );
    if (!isValid) {
      this.errorLogger.error(error || new Error('Unknown validation error'), {
        stage: 'validateTransaction',
        depositIds: depositIds.map(String)
      });
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
    this.logger.info(RELAYER_EVENTS.TRANSACTION_QUEUED, {
      id: tx.id,
      depositCount: depositIds.length,
      totalShares: profitability.estimates.total_shares.toString(),
      expectedProfit: profitability.estimates.expected_profit.toString(),
    });
    this.errorLogger.info(`Transaction queued: ${tx.id}`, {
      id: tx.id,
      depositCount: depositIds.length,
      totalShares: profitability.estimates.total_shares.toString(),
      expectedProfit: profitability.estimates.expected_profit.toString(),
    });

    if (this.isRunning) {
      setImmediate(() => this.processQueue(false));
    }

    return tx;
  }

  async validateTransaction(
    depositIds: bigint[],
    profitability: GovLstProfitabilityCheck,
  ): Promise<{ isValid: boolean; error: TransactionValidationError | null }> {
    // Use the centralized validation function first
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
    const feeData = await this.relayProvider.getFeeData();
    if (!feeData.maxFeePerGas) {
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
    const estimatedGasCost =
      BigInt(feeData.maxFeePerGas.toString()) *
      profitability.estimates.gas_estimate;

    // Get payout amount from contract
    if (
      !this.lstContract ||
      typeof this.lstContract.payoutAmount !== 'function'
    ) {
      return {
        isValid: false,
        error: new TransactionValidationError(
          'Contract not properly initialized or missing payoutAmount method',
          {
            contract: this.lstContract,
          },
        ),
      };
    }
    const payoutAmount = await this.lstContract.payoutAmount();

    // Calculate the base amount for profit margin calculation
    const baseAmountForMargin =
      payoutAmount +
      (RELAYER_PROFITABILITY.INCLUDE_GAS_COST ? estimatedGasCost : 0n);

    // Get the min profit margin percentage (as a number)
    const minProfitMarginPercent = RELAYER_PROFITABILITY.MIN_PROFIT_MARGIN;

    // Calculate the required profit value in wei
    const requiredProfitValue =
      (baseAmountForMargin * BigInt(Math.round(minProfitMarginPercent * 100))) /
      10000n; // Multiply by 100 for percentage, divide by 10000 (100*100)

    // Validate that expected reward is sufficient
    if (
      profitability.estimates.expected_profit <
      baseAmountForMargin + requiredProfitValue
    ) {
      return {
        isValid: false,
        error: new TransactionValidationError(
          'Expected reward is less than payout amount plus gas cost and profit margin',
          {
            expectedReward: profitability.estimates.expected_profit.toString(),
            payoutAmount: payoutAmount.toString(),
            estimatedGasCost: estimatedGasCost.toString(),
            requiredProfitValue: requiredProfitValue.toString(),
            minProfitMarginPercent: `${minProfitMarginPercent}%`,
            depositIds: depositIds.map(String),
          },
        ),
      };
    }

    return {
      isValid: true,
      error: null,
    };
  }

  async getQueueStats(): Promise<QueueStats> {
    return calculateQueueStats(Array.from(this.queue.values()));
  }

  async getTransaction(id: string): Promise<QueuedTransaction | null> {
    return this.queue.get(id) || null;
  }

  async getTransactionReceipt(
    hash: string,
  ): Promise<TransactionReceipt | null> {
    const receipt =
      (await this.lstContract.runner?.provider?.getTransactionReceipt(
        hash,
      )) as unknown as EthersTransactionReceipt | null;
    if (!receipt) return null;

    return {
      hash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      gasUsed: BigInt(receipt.gasUsed.toString()),
      gasPrice: 0n,
      status: receipt.status,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: Array.from(log.topics),
        data: log.data,
      })),
    };
  }

  async transferOutTips(): Promise<TransactionReceipt | null> {
    if (!this.config.defaultTipReceiver) {
      throw new TransactionValidationError('No tip receiver configured', {
        config: this.config,
      });
    }

    if (!this.relayProvider) {
      throw new ExecutorError('Relay provider not initialized', {}, false);
    }

    if (!this.relaySigner) {
      throw new ExecutorError('Relay signer not initialized', {}, false);
    }

    // Get relayer balance
    const balance = await this.relayProvider.getBalance(this.config.address);
    const balanceBigInt = BigInt(balance.toString());

    if (balanceBigInt < this.config.minBalance) {
      return null;
    }

    // Use relaySigner directly like BaseExecutor uses wallet
    const tx = await this.relaySigner
      .sendTransaction({
        to: this.config.defaultTipReceiver,
        value: balanceBigInt - this.config.minBalance,
      })
      .catch((error: unknown) => {
        throw new TransactionExecutionError(
          'transfer_tips',
          error instanceof Error ? error : new Error(String(error)),
          {
            amount: (balanceBigInt - this.config.minBalance).toString(),
            receiver: this.config.defaultTipReceiver,
          },
        );
      });

    this.logger.info('Tip transfer transaction submitted', {
      hash: tx.hash,
      amount: ethers.formatEther(balanceBigInt - this.config.minBalance),
      receiver: this.config.defaultTipReceiver,
    });

    try {
      this.logger.info('Waiting for tip transfer transaction...');
      const receipt = await tx.wait();

      this.logger.info(RELAYER_EVENTS.TIPS_TRANSFERRED, {
        amount: ethers.formatEther(balanceBigInt - this.config.minBalance),
        receiver: this.config.defaultTipReceiver,
        hash: tx.hash,
        blockNumber: receipt!.blockNumber,
      });

      return {
        hash: tx.hash,
        blockNumber: receipt!.blockNumber,
        gasUsed: BigInt(receipt!.gasUsed.toString()),
        gasPrice: 0n,
        status: receipt!.status || 0,
        logs: receipt!.logs.map((log) => ({
          address: log.address,
          topics: Array.from(log.topics),
          data: log.data,
        })),
      };
    } catch (error) {
      this.logger.error('Failed to wait for tip transfer transaction', {
        error: error instanceof Error ? error.message : String(error),
        hash: tx.hash,
      });
      throw new TransactionReceiptError(tx.hash, {
        error: 'Failed waiting for tip transfer receipt',
      });
    }
  }

  async clearQueue(): Promise<void> {
    this.queue.clear();
  }

  protected startQueueProcessor(): void {
    if (this.processingInterval) {
      return;
    }
    this.processingInterval = setInterval(
      () => this.processQueue(true),
      RELAYER_QUEUE.PROCESSOR_INTERVAL,
    );
  }

  protected stopQueueProcessor(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
  }

  private async checkAndWaitForBalance(): Promise<void> {
    if (!this.relayProvider) {
      throw new ExecutorError('Relay provider not initialized', {}, false);
    }

    const balance = await this.relayProvider.getBalance(this.config.address);
    const balanceBigInt = BigInt(balance.toString());

    if (balanceBigInt < this.config.minBalance) {
      this.logger.warn('Insufficient balance detected', {
        currentBalance: balanceBigInt.toString(),
        requiredBalance: this.config.minBalance.toString(),
        difference: (this.config.minBalance - balanceBigInt).toString(),
      });

      // Start monitoring balance
      let attempts = 0;
      const maxAttempts = 30; // Wait up to 5 minutes (30 * 10 seconds)

      while (attempts < maxAttempts) {
        attempts++;

        // Wait 10 seconds between checks
        await new Promise((resolve) => setTimeout(resolve, 10000));

        const newBalance = await this.relayProvider.getBalance(
          this.config.address,
        );
        const newBalanceBigInt = BigInt(newBalance.toString());

        this.logger.info('Checking balance recovery', {
          attempt: attempts,
          currentBalance: newBalanceBigInt.toString(),
          requiredBalance: this.config.minBalance.toString(),
        });

        if (newBalanceBigInt >= this.config.minBalance) {
          this.logger.info('Balance recovered', {
            finalBalance: newBalanceBigInt.toString(),
          });
          return;
        }
      }

      // If we get here, balance didn't recover
      throw new InsufficientBalanceError(balanceBigInt, this.config.minBalance);
    }
  }

  protected async processQueue(
    isPeriodicCheck: boolean = false,
  ): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      if (!this.relayProvider) {
        const error = new ExecutorError('Relay provider not initialized', {}, false);
        this.errorLogger.error(error, { stage: 'processQueue' });
        throw error;
      }

      // Check and wait for balance recovery
      try {
        await this.checkAndWaitForBalance();
      } catch (error) {
        if (error instanceof InsufficientBalanceError) {
          // Handle stuck transactions as before
          const queuedTxs = Array.from(this.queue.values()).filter(
            (tx) => tx.status === TransactionStatus.QUEUED,
          );

          if (queuedTxs.length > 0) {
            this.logger.warn(
              'Clearing stuck transactions due to insufficient balance',
              {
                queuedTransactions: queuedTxs.length,
                error: error instanceof Error ? error.message : String(error),
              },
            );
            this.errorLogger.warn(
              'Clearing stuck transactions due to insufficient balance',
              {
                queuedTransactions: queuedTxs.length,
                error: error instanceof Error ? error.message : String(error),
              },
            );

            await Promise.all(
              queuedTxs.map(async (tx) => {
                try {
                  tx.status = TransactionStatus.FAILED;
                  tx.error = error as Error;
                  await this.cleanupQueueItems(tx, '');
                  this.queue.delete(tx.id);
                } catch (cleanupError) {
                  this.logger.error('Failed to clean up stuck transaction', {
                    error:
                      cleanupError instanceof Error
                        ? cleanupError.message
                        : String(cleanupError),
                    txId: tx.id,
                  });
                  this.errorLogger.error(
                    cleanupError instanceof Error 
                      ? cleanupError 
                      : new Error(String(cleanupError)), 
                    {
                      stage: 'cleanupStuckTransaction',
                      txId: tx.id,
                    }
                  );
                }
              }),
            );
          }
          this.errorLogger.error(error, { 
            stage: 'processQueue',
            balance: error instanceof InsufficientBalanceError ? error.context.currentBalance : 'unknown',
            required: error instanceof InsufficientBalanceError ? error.context.requiredBalance : 'unknown'
          });
          throw error;
        }
        this.errorLogger.error(
          error instanceof Error ? error : new Error(String(error)), 
          { stage: 'processQueue' }
        );
        throw error;
      }

      const pendingTxs = Array.from(this.queue.values()).filter(
        (tx) => tx.status === TransactionStatus.PENDING,
      );
      if (pendingTxs.length >= this.config.maxPendingTransactions) {
        const error = new QueueOperationError(
          'queue',
          new Error('Max pending transactions reached'),
          { maxPending: this.config.maxPendingTransactions }
        );
        this.errorLogger.error(error, { 
          stage: 'processQueue',
          pendingCount: pendingTxs.length,
          maxPending: this.config.maxPendingTransactions
        });
        throw error;
      }

      const queuedTxs = Array.from(this.queue.values())
        .filter((tx) => tx.status === TransactionStatus.QUEUED)
        .slice(0, this.config.concurrentTransactions - pendingTxs.length);

      if (queuedTxs.length === 0) {
        if (!isPeriodicCheck) {
          this.logger.debug('No queued transactions to process');
        }
        return;
      }

      await Promise.all(queuedTxs.map((tx) => this.executeTransaction(tx)));
    } catch (error) {
      const executorError = createExecutorError(error, {
        isPeriodicCheck,
        queueSize: this.queue.size,
      });
      this.logger.error(RELAYER_EVENTS.ERROR, {
        ...executorError,
        ...executorError.context,
      });
      this.errorLogger.error(executorError, {
        stage: 'processQueue',
        isPeriodicCheck,
        queueSize: this.queue.size,
      });
    }
  }

  protected async executeTransaction(tx: QueuedTransaction): Promise<void> {
    // Log transaction execution start
    this.errorLogger.info(`Starting transaction execution: ${tx.id}`, {
      txId: tx.id,
      depositCount: tx.depositIds.length,
      depositIds: tx.depositIds.map(String),
      expectedProfit: tx.profitability.estimates.expected_profit.toString()
    });
    
    try {
      if (!this.lstContract) {
        const error = new ExecutorError('LST contract not initialized', {}, false);
        this.errorLogger.error(error, { stage: 'executeTransaction', txId: tx.id });
        throw error;
      }

      if (!this.lstContract.REWARD_TOKEN) {
        const error = new ExecutorError(
          'LST contract missing REWARD_TOKEN method',
          {},
          false,
        );
        this.errorLogger.error(error, { 
          stage: 'executeTransaction', 
          txId: tx.id,
          contractAddress: this.lstContract.target?.toString() 
        });
        throw error;
      }

      tx.status = TransactionStatus.PENDING;
      this.queue.set(tx.id, tx);

      // Get queue item ID from txData
      let queueItemId: string | undefined;
      let queueDepositIds: string[] = [];
      if (tx.tx_data) {
        try {
          const txData = JSON.parse(tx.tx_data);
          queueItemId = txData.queueItemId;
          queueDepositIds = txData.depositIds?.map(String) || [];
        } catch (error) {
          this.logger.error('Failed to parse txData for queue item ID', {
            error: error instanceof Error ? error.message : String(error),
            txData: tx.tx_data,
          });
          this.errorLogger.error(
            error instanceof Error ? error : new Error(`Failed to parse txData: ${String(error)}`),
            {
              stage: 'executeTransaction',
              txId: tx.id,
              txData: tx.tx_data
            }
          );
        }
      }

      // Update database with pending status first
      if (this.db && queueItemId) {
        try {
          await this.db.updateTransactionQueueItem(queueItemId, {
            status: TransactionQueueStatus.PENDING,
          });
          this.errorLogger.info(`Updated transaction queue item status to PENDING: ${queueItemId}`, {
            txId: tx.id,
            queueItemId
          });
        } catch (error) {
          this.logger.error('Failed to update transaction queue item status', {
            error: error instanceof Error ? error.message : String(error),
            queueItemId,
          });
          this.errorLogger.error(
            error instanceof Error ? error : new Error(`Failed to update queue item status: ${String(error)}`),
            {
              stage: 'executeTransaction',
              txId: tx.id,
              queueItemId
            }
          );
        }
      }

      // Get reward token and approve if needed
      const rewardTokenAddress = await this.lstContract.REWARD_TOKEN();
      if (!rewardTokenAddress) {
        const error = new ExecutorError(
          'Failed to get reward token address',
          {},
          false,
        );
        this.errorLogger.error(error, {
          stage: 'executeTransaction',
          txId: tx.id,
          contractAddress: this.lstContract.target?.toString()
        });
        throw error;
      }

      this.logger.info('Retrieved reward token address', {
        rewardTokenAddress,
        contractAddress: this.lstContract.target.toString(),
      });
      this.errorLogger.info(`Retrieved reward token address: ${rewardTokenAddress}`, {
        txId: tx.id, 
        contractAddress: this.lstContract.target.toString()
      });

      const rewardTokenAbi = [
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)',
      ] as const;

      const rewardTokenContract = new ethers.Contract(
        rewardTokenAddress,
        rewardTokenAbi,
        this.lstContract.runner,
      ).connect(
        this.relaySigner as unknown as ethers.Signer,
      ) as ethers.Contract & {
        approve(
          spender: string,
          amount: bigint,
        ): Promise<ethers.ContractTransactionResponse>;
        allowance(owner: string, spender: string): Promise<bigint>;
      };

      try {
        // Get payout amount first to check against allowance
        let payoutAmount: bigint;
        try {
          if (typeof this.lstContract.payoutAmount !== 'function') {
            const error = new ContractMethodError('payoutAmount');
            this.errorLogger.error(error, {
              stage: 'executeTransaction',
              txId: tx.id,
              contractAddress: this.lstContract.target?.toString()
            });
            throw error;
          }
          
          const rawPayoutAmount = await this.lstContract.payoutAmount();
          this.logger.info('Raw payout amount details:', {
            value: rawPayoutAmount,
            type: typeof rawPayoutAmount,
            stringified: String(rawPayoutAmount),
          });

          payoutAmount = BigInt(rawPayoutAmount);
          this.logger.info('Converted payout amount:', {
            value: payoutAmount.toString(),
            type: typeof payoutAmount,
          });
          this.errorLogger.info(`Retrieved payout amount: ${payoutAmount.toString()}`, {
            txId: tx.id
          });
        } catch (error) {
          this.logger.error('Failed to get payout amount for allowance check', {
            error: error instanceof Error ? error.message : String(error),
          });
          this.errorLogger.error(
            error instanceof Error ? error : new Error(`Failed to get payout amount: ${String(error)}`),
            {
              stage: 'executeTransaction_payoutAmount',
              txId: tx.id
            }
          );
          throw new ContractMethodError('payoutAmount');
        }

        // Check current allowance
        const signerAddress = await this.relaySigner.getAddress();
        const lstContractAddress = this.lstContract.target.toString();

        this.logger.info('Checking token allowance', {
          signerAddress,
          lstContractAddress,
          rewardToken: rewardTokenAddress,
        });
        this.errorLogger.info(`Checking token allowance for ${signerAddress}`, {
          txId: tx.id,
          signerAddress,
          lstContractAddress,
          rewardToken: rewardTokenAddress
        });

        const allowance = BigInt(
          await rewardTokenContract.allowance(
            signerAddress,
            lstContractAddress,
          ),
        );

        this.logger.info('Current allowance', {
          allowance: allowance.toString(),
          payoutAmount: payoutAmount.toString(),
        });
        this.errorLogger.info(`Current allowance: ${allowance.toString()}`, {
          txId: tx.id,
          payoutAmount: payoutAmount.toString()
        });

        // Use approval amount from config
        const approvalAmount = BigInt(CONFIG.executor.approvalAmount);

        // If allowance is less than payout amount, approve with approval amount
        if (allowance < payoutAmount) {
          this.logger.info('Approving reward token spend', {
            token: rewardTokenAddress,
            spender: lstContractAddress,
            currentAllowance: allowance.toString(),
            payoutAmount: payoutAmount.toString(),
            approvalAmount: approvalAmount.toString(),
          });
          this.errorLogger.info(`Approving reward token spend: ${approvalAmount.toString()}`, {
            txId: tx.id,
            token: rewardTokenAddress,
            spender: lstContractAddress,
            currentAllowance: allowance.toString()
          });

          const approveTx = await rewardTokenContract.approve(
            lstContractAddress,
            approvalAmount,
          );

          this.logger.info('Approval transaction submitted', {
            hash: approveTx.hash,
            gasLimit: approveTx.gasLimit.toString(),
          });
          this.errorLogger.info(`Approval transaction submitted: ${approveTx.hash}`, {
            txId: tx.id,
            gasLimit: approveTx.gasLimit.toString()
          });

          // Wait for the transaction to be mined
          try {
            this.logger.info('Waiting for approval transaction...');
            let receipt;
            try {
              receipt = await pollForReceipt(
                approveTx.hash,
                this.relayProvider as unknown as ethers.Provider,
                this.logger,
                3,
              );
            } catch (confirmError: unknown) {
              // If polling fails, just log the error
              this.logger.warn('Standard wait for approval failed', {
                error:
                  confirmError instanceof Error
                    ? confirmError.message
                    : String(confirmError),
                hash: approveTx.hash,
                errorType:
                  typeof confirmError === 'object' && confirmError !== null
                    ? confirmError.constructor?.name || 'Unknown'
                    : typeof confirmError,
              });
              this.errorLogger.warn(
                confirmError instanceof Error ? confirmError : new Error(`Standard wait for approval failed: ${String(confirmError)}`),
                {
                  stage: 'executeTransaction_approvalWait',
                  txId: tx.id,
                  hash: approveTx.hash
                }
              );

              this.logger.info(
                'Continuing execution despite wait error - approval may still have succeeded',
              );

              // Skip polling and consider it a warning rather than error
              this.logger.debug('Transaction details for debugging', {
                transaction: {
                  hash: approveTx.hash,
                  to: approveTx.to,
                  from: approveTx.from,
                  nonce: approveTx.nonce,
                },
              });
            }

            this.logger.info('Approval transaction confirmed', {
              hash: approveTx.hash,
              blockNumber: receipt?.blockNumber,
            });
            this.errorLogger.info(`Approval transaction confirmed: ${approveTx.hash}`, {
              txId: tx.id,
              blockNumber: receipt?.blockNumber?.toString() || 'unknown'
            });
          } catch (waitError) {
            this.logger.error('Failed waiting for approval transaction', {
              error:
                waitError instanceof Error
                  ? waitError.message
                  : String(waitError),
              hash: approveTx.hash,
            });
            this.errorLogger.error(
              waitError instanceof Error ? waitError : new Error(`Failed waiting for approval transaction: ${String(waitError)}`),
              {
                stage: 'executeTransaction_approvalConfirmation',
                txId: tx.id,
                hash: approveTx.hash
              }
            );
            throw new ExecutorError(
              'Failed waiting for approval confirmation',
              {
                error:
                  waitError instanceof Error
                    ? waitError.message
                    : String(waitError),
              },
              false,
            );
          }
        }
      } catch (error) {
        this.logger.error('Token approval error details', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          rewardToken: rewardTokenAddress,
          contractAddress: this.lstContract.target.toString(),
        });
        this.errorLogger.error(
          error instanceof Error ? error : new Error(`Token approval error: ${String(error)}`),
          {
            stage: 'executeTransaction_tokenApproval',
            txId: tx.id,
            rewardToken: rewardTokenAddress,
            contractAddress: this.lstContract.target.toString()
          }
        );
        throw new ExecutorError(
          'Failed to approve reward token spend',
          { error: error instanceof Error ? error.message : String(error) },
          false,
        );
      }

      // Get the payout amount from contract before executing claim
      let payoutAmount: bigint = BigInt(0);
      try {
        // Verify the contract has the payoutAmount method
        if (typeof this.lstContract.payoutAmount !== 'function') {
          const error = new ContractMethodError('getPayoutAmount');
          this.errorLogger.error(error, {
            stage: 'executeTransaction_payoutAmount',
            txId: tx.id,
            contractAddress: this.lstContract.target?.toString()
          });
          throw error;
        }

        const rawPayoutAmount = await this.lstContract.payoutAmount();
        this.logger.info('Raw payout amount details:', {
          value: rawPayoutAmount,
          type: typeof rawPayoutAmount,
          stringified: String(rawPayoutAmount),
        });

        payoutAmount = rawPayoutAmount;
        this.logger.info('Converted payout amount:', {
          value: payoutAmount.toString(),
          type: typeof payoutAmount,
        });

        // Calculate optimal threshold
        // profitMargin is in percentage (e.g. 10 for 10%)
        // Convert profitMargin to basis points (multiply by 100 for precision)
        // const rawGasCost = await this.gasCostEstimator.estimateGasCostInRewardToken(
        //   this.relayProvider as unknown as ethers.Provider
        // );
        // this.logger.info('Raw gas cost details:', {
        //   value: rawGasCost,
        //   type: typeof rawGasCost,
        //   stringified: String(rawGasCost)
        // });

        // Temporarily use a default gas cost value
        const gasCost = 0n; // Set to 0 for now since we don't have actual values
        this.logger.info('Using default gas cost:', {
          value: gasCost.toString(),
          type: typeof gasCost,
        });

        // Convert profit margin to basis points first
        const profitMargin = CONFIG.profitability.minProfitMargin;
        this.logger.info('Raw profit margin value:', {
          value: profitMargin,
          type: typeof profitMargin,
          source: 'CONFIG.profitability.minProfitMargin',
        });

        if (typeof profitMargin !== 'number' || isNaN(profitMargin)) {
          const error = new Error(`Invalid profit margin value: ${profitMargin}`);
          this.errorLogger.error(error, {
            stage: 'executeTransaction_profitMargin',
            txId: tx.id,
            profitMargin
          });
          throw error;
        }

        const profitMarginBasisPoints = BigInt(Math.floor(profitMargin * 100));
        this.logger.info('Profit margin basis points:', {
          value: profitMarginBasisPoints.toString(),
          type: typeof profitMarginBasisPoints,
          originalValue: profitMargin,
          calculation: `${profitMargin} * 100 = ${profitMargin * 100}`,
        });

        this.logger.info('Pre-calculation values:', {
          payoutAmount: payoutAmount.toString(),
          payoutAmountType: typeof payoutAmount,
          gasCost: gasCost.toString(),
          gasCostType: typeof gasCost,
          profitMarginBasisPoints: profitMarginBasisPoints.toString(),
          profitMarginBasisPointsType: typeof profitMarginBasisPoints,
        });

        // Calculate profit margin amount using basis points
        const baseAmount = payoutAmount + gasCost;
        const profitMarginAmount =
          (baseAmount * profitMarginBasisPoints) / 10000n;

        const optimalThreshold = payoutAmount + gasCost + profitMarginAmount;
        this.logger.info('Final optimal threshold calculation:', {
          value: optimalThreshold.toString(),
          type: typeof optimalThreshold,
          components: {
            payoutAmount: payoutAmount.toString(),
            gasCost: gasCost.toString(),
            profitMarginAmount: profitMarginAmount.toString(),
          },
        });
        this.errorLogger.info(`Calculated optimal threshold: ${optimalThreshold.toString()}`, {
          txId: tx.id,
          payoutAmount: payoutAmount.toString(),
          gasCost: gasCost.toString(),
          profitMarginAmount: profitMarginAmount.toString()
        });

        this.logger.info('Calculated optimal threshold:', {
          payoutAmount: ethers.formatEther(payoutAmount),
          payoutAmountRaw: payoutAmount.toString(),
          gasCost: ethers.formatEther(gasCost),
          gasCostRaw: gasCost.toString(),
          profitMargin: `${profitMargin}%`,
          profitMarginAmount: ethers.formatEther(profitMarginAmount),
          profitMarginAmountRaw: profitMarginAmount.toString(),
          optimalThreshold: ethers.formatEther(optimalThreshold),
          optimalThresholdRaw: optimalThreshold.toString(),
        });

        // Validate that optimal threshold is sufficient
        if (optimalThreshold <= payoutAmount) {
          const error = new TransactionValidationError(
            'Optimal threshold is less than or equal to payout amount',
            {
              optimalThreshold: optimalThreshold.toString(),
              payoutAmount: payoutAmount.toString(),
              depositIds: tx.depositIds.map(String),
            },
          );
          this.errorLogger.error(error, {
            stage: 'executeTransaction_thresholdValidation',
            txId: tx.id
          });
          throw error;
        }

        const depositIds = tx.depositIds;

        // Get current network conditions
        let maxFeePerGas: bigint | undefined;
        let maxPriorityFeePerGas: bigint | undefined;

        try {
          const feeData = await this.relayProvider.getFeeData();
          maxFeePerGas = feeData.maxFeePerGas
            ? BigInt(feeData.maxFeePerGas.toString())
            : undefined;
          maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
            ? BigInt(feeData.maxPriorityFeePerGas.toString())
            : undefined;
            
          this.errorLogger.info('Retrieved network fee data', {
            txId: tx.id,
            maxFeePerGas: maxFeePerGas?.toString() || 'undefined',
            maxPriorityFeePerGas: maxPriorityFeePerGas?.toString() || 'undefined'
          });
        } catch (error) {
          this.logger.error('Failed to get fee data', {
            error: error instanceof Error ? error.message : String(error),
          });
          this.errorLogger.error(
            error instanceof Error ? error : new Error(`Failed to get fee data: ${String(error)}`),
            {
              stage: 'executeTransaction_feeData',
              txId: tx.id
            }
          );
        }

        // Get the relayer's address for reward recipient
        const signerAddress = await this.relaySigner.getAddress();

        // Verify the contract has the claimAndDistributeReward method
        if (typeof this.lstContract.claimAndDistributeReward !== 'function') {
          const error = new ContractMethodError('claimAndDistributeReward');
          this.errorLogger.error(error, {
            stage: 'executeTransaction_contractMethod',
            txId: tx.id,
            contractAddress: this.lstContract.target?.toString()
          });
          throw error;
        }

        // Log transaction parameters before execution
        this.logger.info('Executing claimAndDistributeReward', {
          recipient: signerAddress,
          minExpectedReward: optimalThreshold.toString(),
          depositIds: depositIds.map((id) => id.toString()),
          gasEstimate: tx.profitability.estimates.gas_estimate.toString(),
        });
        this.errorLogger.info(`Executing claimAndDistributeReward for ${depositIds.length} deposits`, {
          txId: tx.id,
          recipient: signerAddress,
          minExpectedReward: optimalThreshold.toString(),
          depositIds: depositIds.map((id) => id.toString())
        });

        // Calculate gas limit with extra buffer for complex operations
        const gasEstimate = tx.profitability.estimates.gas_estimate;
        const baseGasLimit = gasEstimate < 120000n ? 600000n : gasEstimate; // Use minimum 500k gas if estimate is too low
        const calculatedGasLimit = calculateGasLimit(
          baseGasLimit,
          depositIds.length,
          this.logger,
        );

        this.logger.info('Gas limit for transaction', {
          originalEstimate: gasEstimate.toString(),
          baseGasLimit: baseGasLimit.toString(),
          finalGasLimit: calculatedGasLimit.toString(),
          depositCount: depositIds.length,
        });
        this.errorLogger.info(`Calculated gas limit: ${calculatedGasLimit.toString()}`, {
          txId: tx.id,
          originalEstimate: gasEstimate.toString(),
          baseGasLimit: baseGasLimit.toString(),
          depositCount: depositIds.length
        });

        // Store depositIds in tx object for later use in receipt processing
        tx.metadata = {
          queueItemId,
          depositIds: queueDepositIds,
        };

        // Execute via contract with signer
        const response = await this.lstContract
          .claimAndDistributeReward(
            signerAddress,
            optimalThreshold,
            depositIds,
            {
              gasLimit: calculatedGasLimit,
              maxFeePerGas: this.config.gasPolicy?.maxFeePerGas || maxFeePerGas,
              maxPriorityFeePerGas:
                this.config.gasPolicy?.maxPriorityFeePerGas ||
                maxPriorityFeePerGas,
            },
          )
          .catch(async (error: Error) => {
            // Enhanced error handling for Defender 400 errors
            const defenderError = error as DefenderError;
            const isDefender400Error =
              defenderError.message?.includes('status code 400') ||
              defenderError.response?.status === 400;

            if (isDefender400Error) {
              // Get current network state for diagnostics
              const [networkGasPrice, blockNumber, balance] = await Promise.all(
                [
                  this.relayProvider.getFeeData(),
                  this.relayProvider.getBlockNumber(),
                  this.relayProvider.getBalance(signerAddress),
                ],
              ).catch((e) => {
                this.logger.error('Failed to get network diagnostics:', {
                  error: e,
                });
                this.errorLogger.error(
                  e instanceof Error ? e : new Error(`Failed to get network diagnostics: ${String(e)}`),
                  {
                    stage: 'executeTransaction_networkDiagnostics',
                    txId: tx.id
                  }
                );
                return [null, null, null];
              });

              // Log detailed diagnostic information
              this.logger.error('Defender Relayer 400 Error Details:', {
                error: {
                  message: defenderError.message,
                  response: {
                    status: defenderError.response?.status,
                    statusText: defenderError.response?.statusText,
                    data: defenderError.response?.data,
                  },
                  request: {
                    method: defenderError.config?.method,
                    url: defenderError.config?.url,
                    data: defenderError.config?.data,
                  },
                },
                transaction: {
                  recipient: signerAddress,
                  minExpectedReward: optimalThreshold.toString(),
                  depositIds: depositIds.map(String),
                  gasLimit: calculatedGasLimit.toString(),
                  maxFeePerGas: (
                    this.config.gasPolicy?.maxFeePerGas || maxFeePerGas
                  )?.toString(),
                  maxPriorityFeePerGas: (
                    this.config.gasPolicy?.maxPriorityFeePerGas ||
                    maxPriorityFeePerGas
                  )?.toString(),
                },
                networkState: {
                  currentBlock: blockNumber,
                  balance: balance?.toString(),
                  networkGasPrice: {
                    maxFeePerGas: networkGasPrice?.maxFeePerGas?.toString(),
                    maxPriorityFeePerGas:
                      networkGasPrice?.maxPriorityFeePerGas?.toString(),
                    gasPrice: networkGasPrice?.gasPrice?.toString(),
                  },
                },
                relayerConfig: {
                  address: this.config.address,
                  minBalance: this.config.minBalance.toString(),
                  maxPendingTransactions: this.config.maxPendingTransactions,
                  gasPolicyConfig: this.config.gasPolicy,
                },
              });
              this.errorLogger.error(
                new Error(`Defender Relayer 400 Error: ${defenderError.message}`),
                {
                  stage: 'executeTransaction_defender400',
                  txId: tx.id,
                  responseStatus: defenderError.response?.status,
                  responseData: JSON.stringify(defenderError.response?.data),
                  currentBlock: blockNumber,
                  balance: balance?.toString(),
                  networkGasPrice: JSON.stringify({
                    maxFeePerGas: networkGasPrice?.maxFeePerGas?.toString(),
                    maxPriorityFeePerGas: networkGasPrice?.maxPriorityFeePerGas?.toString(),
                    gasPrice: networkGasPrice?.gasPrice?.toString(),
                  })
                }
              );

              // Check specific conditions that might cause 400 errors
              if (balance) {
                const balanceBigInt = BigInt(balance.toString());
                if (balanceBigInt < this.config.minBalance) {
                  const insufficientBalanceError = new InsufficientBalanceError(
                    balanceBigInt,
                    this.config.minBalance,
                  );
                  this.errorLogger.error(insufficientBalanceError, {
                    stage: 'executeTransaction_insufficientBalance',
                    txId: tx.id,
                    balance: balanceBigInt.toString(),
                    minBalance: this.config.minBalance.toString()
                  });
                  throw insufficientBalanceError;
                }
              }

              // Add gas estimation validation
              try {
                // Try to estimate gas for the transaction
                const estimatedGas = await this.lstContract.runner?.provider
                  ?.estimateGas({
                    to: this.lstContract.target,
                    data: this.lstContract.interface.encodeFunctionData(
                      'claimAndDistributeReward',
                      [signerAddress, optimalThreshold, depositIds],
                    ),
                    maxFeePerGas:
                      this.config.gasPolicy?.maxFeePerGas || maxFeePerGas,
                    maxPriorityFeePerGas:
                      this.config.gasPolicy?.maxPriorityFeePerGas ||
                      maxPriorityFeePerGas,
                  })
                  .catch((estimateError: GasEstimationError) => {
                    this.logger.error('Gas estimation failed:', {
                      error: estimateError,
                      message: estimateError.message,
                      data: estimateError.data,
                    });
                    this.errorLogger.error(
                      estimateError instanceof Error ? estimateError : new Error(`Gas estimation failed: ${String(estimateError)}`),
                      {
                        stage: 'executeTransaction_gasEstimation',
                        txId: tx.id,
                        data: JSON.stringify(estimateError.data)
                      }
                    );
                    return null;
                  });

                if (estimatedGas) {
                  const estimatedGasBigInt = BigInt(estimatedGas.toString());
                  if (estimatedGasBigInt > calculatedGasLimit) {
                    const gasLimitError = new ExecutorError(
                      'Estimated gas exceeds calculated limit',
                      {
                        estimatedGas: estimatedGasBigInt.toString(),
                        calculatedLimit: calculatedGasLimit.toString(),
                        difference: (
                          estimatedGasBigInt - calculatedGasLimit
                        ).toString(),
                      },
                      true,
                    );
                    this.errorLogger.error(gasLimitError, {
                      stage: 'executeTransaction_gasLimitExceeded',
                      txId: tx.id
                    });
                    throw gasLimitError;
                  }
                }
              } catch (gasError) {
                this.logger.error('Gas estimation error:', {
                  error:
                    gasError instanceof Error
                      ? gasError.message
                      : String(gasError),
                  transaction: {
                    recipient: signerAddress,
                    minExpectedReward: optimalThreshold.toString(),
                    depositIds: depositIds.map(String),
                  },
                });
                this.errorLogger.error(
                  gasError instanceof Error ? gasError : new Error(`Gas estimation error: ${String(gasError)}`),
                  {
                    stage: 'executeTransaction_gasError',
                    txId: tx.id,
                    recipient: signerAddress,
                    depositIds: depositIds.map(String).join(',')
                  }
                );
              }

              if (networkGasPrice?.maxFeePerGas && maxFeePerGas) {
                const networkMaxFee = BigInt(
                  networkGasPrice.maxFeePerGas.toString(),
                );
                if (networkMaxFee > maxFeePerGas) {
                  const gasPriceError = new ExecutorError(
                    'Network gas price exceeds configured maximum',
                    {
                      networkMaxFee: networkMaxFee.toString(),
                      configuredMaxFee: maxFeePerGas.toString(),
                      difference: (networkMaxFee - maxFeePerGas).toString(),
                    },
                    true,
                  );
                  this.errorLogger.error(gasPriceError, {
                    stage: 'executeTransaction_gasPriceExceeded',
                    txId: tx.id
                  });
                  throw gasPriceError;
                }
              }

              // Check if the error response contains specific Defender error codes
              const defenderErrorData = defenderError.response?.data?.error;
              if (defenderErrorData) {
                switch (defenderErrorData.code) {
                  case 'NONCE_TOO_LOW':
                    const nonceError = new ExecutorError(
                      'Nonce too low - transaction would be replaced',
                      {
                        suggestedNonce: defenderErrorData.suggestedNonce,
                      },
                      true,
                    );
                    this.errorLogger.error(nonceError, {
                      stage: 'executeTransaction_nonceTooLow',
                      txId: tx.id,
                      suggestedNonce: defenderErrorData.suggestedNonce
                    });
                    throw nonceError;
                  case 'INSUFFICIENT_FUNDS':
                    const fundsError = new InsufficientBalanceError(
                      BigInt(balance?.toString() || '0'),
                      this.config.minBalance,
                    );
                    this.errorLogger.error(fundsError, {
                      stage: 'executeTransaction_insufficientFunds',
                      txId: tx.id,
                      balance: balance?.toString() || '0',
                      minBalance: this.config.minBalance.toString()
                    });
                    throw fundsError;
                  case 'GAS_LIMIT_TOO_LOW':
                    const gasLimitError = new ExecutorError(
                      'Gas limit too low for complex transaction',
                      {
                        providedGasLimit: calculatedGasLimit.toString(),
                        suggestedGasLimit: defenderErrorData.suggestedGasLimit,
                      },
                      true,
                    );
                    this.errorLogger.error(gasLimitError, {
                      stage: 'executeTransaction_gasLimitTooLow',
                      txId: tx.id,
                      providedGasLimit: calculatedGasLimit.toString(),
                      suggestedGasLimit: defenderErrorData.suggestedGasLimit
                    });
                    throw gasLimitError;
                  default:
                    const defaultError = new ExecutorError(
                      `Defender API Error: ${defenderErrorData.message}`,
                      {
                        code: defenderErrorData.code,
                        details: defenderErrorData,
                      },
                      false,
                    );
                    this.errorLogger.error(defaultError, {
                      stage: 'executeTransaction_defenderApiError',
                      txId: tx.id,
                      errorCode: defenderErrorData.code
                    });
                    throw defaultError;
                }
              }
            }

            // If not a 400 error or no specific error code, throw the original error
            this.errorLogger.error(
              error instanceof Error ? error : new Error(`Transaction submission error: ${String(error)}`),
              {
                stage: 'executeTransaction_submissionError',
                txId: tx.id,
                depositIds: depositIds.map(String).join(',')
              }
            );
            throw error;
          });

        this.logger.info('Transaction submitted:', {
          hash: response.hash,
          nonce: response.nonce,
          gasLimit: response.gasLimit.toString(),
          maxFeePerGas: response.maxFeePerGas?.toString(),
          maxPriorityFeePerGas: response.maxPriorityFeePerGas?.toString(),
        });
        this.errorLogger.info(`Transaction submitted: ${response.hash}`, {
          txId: tx.id,
          hash: response.hash,
          nonce: response.nonce,
          gasLimit: response.gasLimit.toString()
        });

        // Wait for transaction to be mined
        this.logger.info('Waiting for transaction...');
        try {
          let receipt;
          try {
            receipt = await pollForReceipt(
              response.hash,
              this.relayProvider as unknown as ethers.Provider,
              this.logger,
              3,
            );
            this.errorLogger.info(`Transaction receipt received: ${response.hash}`, {
              txId: tx.id,
              blockNumber: receipt?.blockNumber?.toString() || 'unknown',
              status: receipt?.status?.toString() || 'unknown'
            });
          } catch (confirmError: unknown) {
            // If polling fails, just log the error
            this.logger.warn('Transaction confirmation failed', {
              error:
                confirmError instanceof Error
                  ? confirmError.message
                  : String(confirmError),
              hash: response.hash,
              errorType:
                typeof confirmError === 'object' && confirmError !== null
                  ? confirmError.constructor?.name || 'Unknown'
                  : typeof confirmError,
            });
            this.errorLogger.warn(
              confirmError instanceof Error ? confirmError : new Error(`Transaction confirmation failed: ${String(confirmError)}`),
              {
                stage: 'executeTransaction_confirmationFailed',
                txId: tx.id,
                hash: response.hash
              }
            );

            this.logger.info(
              'Continuing execution despite confirmation error - transaction may still have succeeded',
            );

            // Skip polling and consider it a warning rather than error
            this.logger.debug('Transaction details for debugging', {
              transaction: {
                hash: response.hash,
                to: response.to,
                from: response.from,
                nonce: response.nonce,
              },
            });

            // Continue without receipt - transaction might have gone through anyway
            receipt = null;
          }

          // Process the transaction receipt and clean up queues
          await this.processTransactionReceipt(tx, response, receipt);
        } catch (waitError) {
          this.logger.error('Failed waiting for transaction confirmation', {
            error:
              waitError instanceof Error
                ? waitError.message
                : String(waitError),
            transactionId: tx.id,
            depositIds: depositIds.map(String),
          });
          this.errorLogger.error(
            waitError instanceof Error ? waitError : new Error(`Failed waiting for transaction confirmation: ${String(waitError)}`),
            {
              stage: 'executeTransaction_waitError',
              txId: tx.id,
              hash: response.hash,
              depositIds: depositIds.map(String).join(',')
            }
          );
          throw new ExecutorError(
            'Failed waiting for transaction confirmation',
            {
              error:
                waitError instanceof Error
                  ? waitError.message
                  : String(waitError),
            },
            false,
          );
        }
      } catch (error) {
        await this.handleExecutionError(tx, error);
      }
    } catch (error) {
      await this.handleExecutionError(tx, error);
    }
  }

  // Add or update processTransactionReceipt method
  private async processTransactionReceipt(
    tx: QueuedTransaction,
    response: ethers.ContractTransactionResponse,
    receipt: EthersTransactionReceipt | null,
  ): Promise<void> {
    const isSuccess = receipt && receipt.status === 1;

    // Update transaction status
    tx.status = isSuccess
      ? TransactionStatus.CONFIRMED
      : TransactionStatus.FAILED;
    tx.hash = response.hash;
    tx.gasPrice = 0n; // Set default since it may not be available
    tx.gasLimit = receipt ? BigInt(receipt.gasUsed.toString()) : 0n;
    tx.executedAt = new Date();

    // Logging based on status
    if (isSuccess) {
      this.logger.info(RELAYER_EVENTS.TRANSACTION_CONFIRMED, {
        id: tx.id,
        hash: response.hash,
        blockNumber: receipt?.blockNumber,
        gasUsed: receipt?.gasUsed.toString(),
      });
      this.errorLogger.info(`Transaction confirmed: ${tx.id}`, {
        id: tx.id,
        hash: response.hash,
        blockNumber: receipt?.blockNumber,
        gasUsed: receipt?.gasUsed.toString(),
      });
    } else {
      this.logger.warn(RELAYER_EVENTS.TRANSACTION_FAILED, {
        id: tx.id,
        hash: response.hash,
      });
      this.errorLogger.warn(`Transaction failed: ${tx.id}`, {
        id: tx.id,
        hash: response.hash,
        receipt: receipt ? JSON.stringify(receipt) : 'null',
      });
    }

    // Clean up queue items regardless of success or failure
    await this.cleanupQueueItems(tx, response.hash);

    // Update in-memory queue and then remove
    this.queue.set(tx.id, tx);
    this.queue.delete(tx.id);
  }

  // Add method to clean up queue items
  private async cleanupQueueItems(tx: QueuedTransaction, txHash: string): Promise<void> {
    if (!this.db) {
      this.logger.warn('Database not initialized, skipping cleanup');
      this.errorLogger.warn('Database not initialized, skipping cleanup', {
        txId: tx.id,
        txHash
      });
      return;
    }

    if (!tx.depositIds || tx.depositIds.length === 0) {
      this.logger.warn('No deposit IDs in transaction, skipping cleanup');
      this.errorLogger.warn('No deposit IDs in transaction, skipping cleanup', {
        txId: tx.id,
        txHash
      });
      return;
    }

    try {
      // Only proceed with deletion if transaction is confirmed
      if (tx.status !== TransactionStatus.CONFIRMED) {
        this.logger.info('Skipping cleanup for unconfirmed transaction:', {
          txHash,
          status: tx.status
        });
        return;
      }

      // Mark deposit IDs as being cleaned up
      const depositIdStrings = tx.depositIds.map(String);
      depositIdStrings.forEach(id => this.cleanupInProgress.add(id));
      
      try {
        // First try to get queueItemId from tx metadata or tx_data
        let queueItemId: string | undefined;
        if (tx.metadata?.queueItemId) {
          queueItemId = tx.metadata.queueItemId;
        } else if (tx.tx_data && typeof tx.tx_data === 'string') {
          try {
            const txData = JSON.parse(tx.tx_data);
            queueItemId = txData.queueItemId;
          } catch (error) {
            this.logger.warn('Failed to parse tx_data for queueItemId:', {
              error: error instanceof Error ? error.message : String(error),
              txData: tx.tx_data
            });
            this.errorLogger.warn(
              error instanceof Error ? error : new Error(`Failed to parse tx_data: ${String(error)}`), 
              {
                stage: 'cleanupQueueItems',
                txId: tx.id,
                txData: tx.tx_data
              }
            );
          }
        }

        // If we don't have a queueItemId, try to find it in the database
        if (!queueItemId) {
          // Try to find by transaction hash first
          const itemsByHash = await this.db.getTransactionQueueItemsByHash(txHash);
          if (itemsByHash.length > 0) {
            queueItemId = itemsByHash[0]?.id;
          } else {
            // Try to find by deposit IDs
            for (const depositId of tx.depositIds) {
              const item = await this.db.getTransactionQueueItemByDepositId(depositId.toString());
              if (item) {
                queueItemId = item.id;
                break;
              }
            }
          }
        }

        // If we found a queue item, delete it
        if (queueItemId) {
          this.logger.info('Deleting transaction queue item:', {
            queueItemId,
            txHash
          });
          
          await this.db.deleteTransactionQueueItem(queueItemId);
          this.errorLogger.info(`Deleted transaction queue item: ${queueItemId}`, {
            txHash,
            queueItemId
          });
        } else {
          this.logger.warn('Could not find transaction queue item to delete:', {
            txHash,
            depositIds: tx.depositIds.map(String)
          });
          this.errorLogger.warn('Could not find transaction queue item to delete', {
            txHash,
            depositIds: tx.depositIds.map(String)
          });
        }

        // Clean up any associated processing queue items
        for (const depositId of tx.depositIds) {
          const processingItem = await this.db.getProcessingQueueItemByDepositId(depositId.toString());
          if (processingItem) {
            await this.db.deleteProcessingQueueItem(processingItem.id);
            this.logger.info('Deleted processing queue item:', {
              processingItemId: processingItem.id,
              depositId: depositId.toString()
            });
            this.errorLogger.info(`Deleted processing queue item: ${processingItem.id}`, {
              depositId: depositId.toString()
            });
          }
        }
      } finally {
        // Always remove from cleanupInProgress set, even if there was an error
        depositIdStrings.forEach(id => this.cleanupInProgress.delete(id));
      }
    } catch (error) {
      this.logger.error('Failed to delete confirmed transaction:', {
        error: error instanceof Error ? error.message : String(error),
        txHash,
        stack: error instanceof Error ? error.stack : undefined
      });
      this.errorLogger.error(
        error instanceof Error ? error : new Error(`Failed to delete confirmed transaction: ${String(error)}`),
        {
          stage: 'cleanupQueueItems',
          txHash,
          txId: tx.id,
          depositIds: tx.depositIds.map(String)
        }
      );
      throw error;
    }
  }

  // Update handleExecutionError to use errorLogger
  private async handleExecutionError(
    tx: QueuedTransaction,
    error: unknown,
  ): Promise<void> {
    tx.status = TransactionStatus.FAILED;
    tx.error = error as Error;
    this.queue.set(tx.id, tx);

    const executorError = new Error(
      'Transaction execution failed',
    ) as GovLstExecutorError;
    executorError.context = {
      id: tx.id,
      depositIds: tx.depositIds.map(String),
      error: error instanceof Error ? error.message : String(error),
    };
    this.logger.error(RELAYER_EVENTS.ERROR, {
      ...executorError,
      ...executorError.context,
    });
    
    // Log with errorLogger
    this.errorLogger.error(
      error instanceof BaseError ? error : executorError,
      {
        stage: 'executeTransaction',
        txId: tx.id,
        depositIds: tx.depositIds.map(String),
        originalError: error instanceof Error ? error.message : String(error),
      }
    );

    // Clean up queue items using the same method
    await this.cleanupQueueItems(tx, tx.hash || '');

    // Remove from in-memory queue
    this.queue.delete(tx.id);
  }
}
