import { ethers } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { IExecutor } from '../interfaces/IExecutor';
import {
  RelayerExecutorConfig,
  QueuedTransaction,
  TransactionStatus,
  QueueStats,
  TransactionReceipt,
  EthersTransactionReceipt,
} from '../interfaces/types';
import { GovLstProfitabilityCheck } from '@/profitability/interfaces/types';
import { DatabaseWrapper } from '@/database';
import {
  DefenderRelayProvider,
  DefenderRelaySigner,
} from '@openzeppelin/defender-relay-client/lib/ethers';
import { TransactionQueueStatus } from '@/database/interfaces/types';
import {
  ContractMethodError,
  ExecutorError,
  InsufficientBalanceError,
  TransactionValidationError,
} from '@/configuration/errors';
import { CONFIG } from '@/configuration';
import {
  calculateGasLimit,
  pollForReceipt,
  calculateQueueStats,
} from '@/configuration/helpers';
import { ErrorLogger, createErrorLogger } from '@/configuration/errorLogger';
import { DefenderError, GasEstimationError } from '../interfaces/types';
import { RELAYER_QUEUE } from './constants';
import {
  cleanupQueueItems as cleanupQueueItemsHelper,
  handleExecutionError as handleExecutionErrorHelper,
  queueTransactionWithValidation,
  validateRelayerTransaction,
  transferOutTips as transferOutTipsHelper,
  processTransactionReceipt as processTransactionReceiptHelper,
  processQueue as processQueueHelper,
} from './helpers';
import { GasCostEstimator } from '@/prices/GasCostEstimator';
import { SimulationService } from '@/simulation';
import { SimulationTransaction } from '@/simulation/interfaces';

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
  private cleanupInProgress: Set<string> = new Set(); // Add cleanup lock set
  private readonly gasCostEstimator: GasCostEstimator;
  private readonly simulationService: SimulationService | null;

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
    this.gasCostEstimator = new GasCostEstimator();

    // Initialize simulation service (with fallback)
    try {
      this.simulationService = new SimulationService();
      this.logger.info(
        'Initialized simulation service for transaction validation',
      );
    } catch (error) {
      this.logger.warn(
        'Failed to initialize simulation service, will use fallback gas estimation',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      this.simulationService = null;
    }

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
  }

  // Add setDatabase method
  setDatabase(db: DatabaseWrapper): void {
    this.db = db;
    this.logger.info('Database set for executor');
    // Update the errorLogger with the database
    this.errorLogger = createErrorLogger('RelayerExecutor', db);
    this.logger.info('ErrorLogger initialized with database');
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.startQueueProcessor();
    this.logger.info('RelayerExecutor started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.stopQueueProcessor();
    this.logger.info('RelayerExecutor stopped');
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
    return queueTransactionWithValidation(
      depositIds,
      profitability,
      txData,
      this.config,
      this.queue,
      this.isRunning,
      this.validateTransaction.bind(this),
      this.logger,
      this.errorLogger,
      this.cleanupInProgress,
    );
  }

  async validateTransaction(
    depositIds: bigint[],
    profitability: GovLstProfitabilityCheck,
  ): Promise<{ isValid: boolean; error: TransactionValidationError | null }> {
    try {
      // Try to get a better gas estimate using simulation if available
      if (this.simulationService) {
        try {
          const signerAddress = await this.relaySigner.getAddress();
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

      return validateRelayerTransaction(
        depositIds,
        profitability,
        this.queue,
        this.relayProvider as unknown as ethers.Provider,
        this.lstContract,
      );
    } catch (error) {
      const validationError = new TransactionValidationError(
        error instanceof Error ? error.message : String(error),
        { depositIds: depositIds.map(String) },
      );
      this.errorLogger.error(validationError, {
        stage: 'transaction_validation',
        depositIds: depositIds.map(String),
      });
      return { isValid: false, error: validationError };
    }
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
    return transferOutTipsHelper(
      this.config,
      this.relayProvider as unknown as ethers.Provider,
      this.relaySigner as unknown as ethers.Signer,
      this.logger,
      this.errorLogger,
    );
  }

  async clearQueue(): Promise<void> {
    this.queue.clear();
  }

  protected startQueueProcessor(): void {
    if (this.processingInterval) {
      return;
    }
    this.processingInterval = setInterval(
      () =>
        processQueueHelper(
          true,
          this.isRunning,
          this.config,
          this.relayProvider as unknown as ethers.Provider,
          this.queue,
          this.executeTransaction.bind(this),
          this.logger,
          this.errorLogger,
          this.db,
        ),
      RELAYER_QUEUE.PROCESSOR_INTERVAL,
    );
  }

  protected stopQueueProcessor(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
  }

  protected async executeTransaction(tx: QueuedTransaction): Promise<void> {
    // Log transaction execution start
    this.logger.info(`Starting transaction execution: ${tx.id}`, {
      txId: tx.id,
      depositCount: tx.depositIds.length,
      depositIds: tx.depositIds.map(String),
      expectedProfit: tx.profitability.estimates.expected_profit.toString(),
    });

    try {
      if (!this.lstContract) {
        const error = new ExecutorError(
          'LST contract not initialized',
          {},
          false,
        );
        this.errorLogger.error(error, {
          stage: 'executeTransaction',
          txId: tx.id,
        });
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
          contractAddress: this.lstContract.target?.toString(),
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
            error instanceof Error
              ? error
              : new Error(`Failed to parse txData: ${String(error)}`),
            {
              stage: 'executeTransaction',
              txId: tx.id,
              txData: tx.tx_data,
            },
          );
        }
      }

      // Update database with pending status first
      if (this.db && queueItemId) {
        try {
          await this.db.updateTransactionQueueItem(queueItemId, {
            status: TransactionQueueStatus.PENDING,
          });
          this.logger.info(
            `Updated transaction queue item status to PENDING: ${queueItemId}`,
            {
              txId: tx.id,
              queueItemId,
            },
          );
        } catch (error) {
          this.logger.error('Failed to update transaction queue item status', {
            error: error instanceof Error ? error.message : String(error),
            queueItemId,
          });
          this.errorLogger.error(
            error instanceof Error
              ? error
              : new Error(
                  `Failed to update queue item status: ${String(error)}`,
                ),
            {
              stage: 'executeTransaction',
              txId: tx.id,
              queueItemId,
            },
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
          contractAddress: this.lstContract.target?.toString(),
        });
        throw error;
      }

      this.logger.info('Retrieved reward token address', {
        rewardTokenAddress,
        contractAddress: this.lstContract.target.toString(),
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
              contractAddress: this.lstContract.target?.toString(),
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
          this.logger.info(
            `Retrieved payout amount: ${payoutAmount.toString()}`,
            {
              txId: tx.id,
            },
          );
        } catch (error) {
          this.logger.error('Failed to get payout amount for allowance check', {
            error: error instanceof Error ? error.message : String(error),
          });
          this.errorLogger.error(
            error instanceof Error
              ? error
              : new Error(`Failed to get payout amount: ${String(error)}`),
            {
              stage: 'executeTransaction_payoutAmount',
              txId: tx.id,
            },
          );
          throw new ContractMethodError('payoutAmount');
        }

        // Check current allowance
        const signerAddress = await this.relaySigner.getAddress();
        const lstContractAddress = this.lstContract.target.toString();

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

          const approveTx = await rewardTokenContract.approve(
            lstContractAddress,
            approvalAmount,
          );
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
          } catch (waitError) {
            this.logger.error('Failed waiting for approval transaction', {
              error:
                waitError instanceof Error
                  ? waitError.message
                  : String(waitError),
              hash: approveTx.hash,
            });
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
            contractAddress: this.lstContract.target?.toString(),
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

        // Calculate gas limit with extra buffer for complex operations based on depositIds count
        const depositIds = tx.depositIds;
        const gasEstimate = tx.profitability.estimates.gas_estimate;

        // Significantly increased base gas limit (2x the previous minimum)
        const baseGasLimit =
          gasEstimate < 300000n ? 1200000n : gasEstimate * 2n;

        // Calculate gas limit with deposit count scaling
        const calculatedGasLimit = calculateGasLimit(
          baseGasLimit,
          depositIds.length,
          this.logger,
        );
        // Calculate real gas cost in reward tokens
        let gasCost: bigint;

        // Only estimate gas cost if includeGasCost is enabled
        if (CONFIG.profitability.includeGasCost) {
          try {
            // Use the GasCostEstimator to get a real gas cost estimate based on calculated gas limit
            gasCost = await this.gasCostEstimator.estimateGasCostInRewardToken(
              this.relayProvider as unknown as ethers.Provider,
              calculatedGasLimit,
            );

            // Cap gas cost to prevent excessive thresholds - max 20% of payout (reduced from 25%)
            const maxGasCost = payoutAmount / 5n;
            if (gasCost > maxGasCost) {
              this.logger.info('Capping excessive gas cost estimate', {
                originalGasCost: gasCost.toString(),
                cappedGasCost: maxGasCost.toString(),
                payoutAmount: payoutAmount.toString(),
                ratio: 'Max 20% of payout',
                calculatedGasLimit: calculatedGasLimit.toString(),
              });
              gasCost = maxGasCost;
            }

            this.logger.info('Calculated gas cost in reward tokens:', {
              gasCost: gasCost.toString(),
              gasLimit: calculatedGasLimit.toString(),
            });
          } catch (error) {
            this.logger.error('Failed to estimate gas cost in reward tokens', {
              error: error instanceof Error ? error.message : String(error),
            });

            // Use a safe fallback - but much lower than before
            // Base rate of 1% plus only 0.25% per deposit, capped at 5%
            const basePercentage = 1n;
            const perDepositPercentage = 25n; // 0.25% = 25 basis points per deposit
            let fallbackPercentage =
              basePercentage +
              (BigInt(depositIds.length) * perDepositPercentage) / 100n;

            // Cap at 5% to avoid excessive gas estimates (reduced from 10%)
            if (fallbackPercentage > 5n) {
              fallbackPercentage = 5n;
            }

            gasCost = (payoutAmount * fallbackPercentage) / 100n;

            this.logger.info('Using fallback gas cost calculation:', {
              gasCost: gasCost.toString(),
              fallbackPercentage: fallbackPercentage.toString(),
              basePercentage: basePercentage.toString(),
              perDepositPercentage: perDepositPercentage.toString(),
              depositCount: depositIds.length,
              payoutAmount: payoutAmount.toString(),
            });
          }
        } else {
          // If gas cost estimation is disabled, use a minimal amount (0.01% of payout)
          gasCost = payoutAmount / 100n;
        }

        // Get profit margin directly from CONFIG to ensure we use the environment variable value
        const profitMargin = +CONFIG.profitability.minProfitMargin;

        if (
          typeof profitMargin !== 'number' ||
          isNaN(profitMargin) ||
          profitMargin <= 0
        ) {
          const error = new Error(
            `Invalid profit margin value: ${profitMargin}. Must be a positive number.`,
          );
          this.errorLogger.error(error, {
            stage: 'executeTransaction_profitMargin',
            txId: tx.id,
            profitMargin,
            envValue: process.env.PROFITABILITY_MIN_PROFIT_MARGIN_PERCENT,
          });
          throw error;
        }

        // Scale profit margin based on deposit count, but NEVER go below configured minimum
        // Base rate is the configured minimum profit margin
        const depositCount = BigInt(depositIds.length);
        // Convert to basis points (0.05% = 5 basis points per deposit, max 20 basis points)
        const depositScalingBasisPoints = BigInt(
          Math.min(20, Number(depositCount) * 5),
        );

        // Start with the minimum profit margin in basis points
        const minProfitMarginBasisPoints = BigInt(
          Math.floor(profitMargin * 100),
        );
        // Add the scaling factor (cap at 1500 basis points = 15%)
        const scaledProfitMarginBasisPoints = BigInt(
          Math.min(
            1500,
            Number(minProfitMarginBasisPoints + depositScalingBasisPoints),
          ),
        );

        this.logger.info('Scaled profit margin for transaction complexity:', {
          configuredMinProfitMargin: `${profitMargin}%`,
          depositCount: depositIds.length,
          depositScalingBasisPoints: depositScalingBasisPoints.toString(),
          minProfitMarginBasisPoints: minProfitMarginBasisPoints.toString(),
          scaledProfitMarginBasisPoints:
            scaledProfitMarginBasisPoints.toString(),
          effectiveScaledMargin: `${Number(scaledProfitMarginBasisPoints) / 100}%`,
          cap: '15%',
          floor: `${profitMargin}%`,
        });

        // Already in basis points (100 = 1%)
        const profitMarginBasisPoints = scaledProfitMarginBasisPoints;
        this.logger.info('Profit margin basis points:', {
          value: profitMarginBasisPoints.toString(),
          type: typeof profitMarginBasisPoints,
          originalValue: `${Number(profitMarginBasisPoints) / 100}%`,
          effectivePercentage: `${Number(profitMarginBasisPoints) / 100}%`,
        });

        this.logger.info('Pre-calculation values:', {
          payoutAmount: payoutAmount.toString(),
          payoutAmountType: typeof payoutAmount,
          gasCost: gasCost.toString(),
          gasCostType: typeof gasCost,
          profitMarginBasisPoints: profitMarginBasisPoints.toString(),
          profitMarginBasisPointsType: typeof profitMarginBasisPoints,
          minimumProfitMarginBasisPoints: minProfitMarginBasisPoints.toString(),
        });

        // Calculate base amount including gas cost if enabled
        const baseAmount =
          payoutAmount + (CONFIG.profitability.includeGasCost ? gasCost : 0n);

        // Calculate minimum required profit
        // If profitMargin is 1 (100%), this calculates:
        // baseAmount * 100 / 10000 = 1% of baseAmount
        const minProfitAmount =
          (baseAmount * BigInt(Math.floor(profitMargin * 100))) / 10000n;

        // Calculate scaled profit margin amount (may be higher than minimum)
        const scaledProfitAmount =
          (baseAmount * profitMarginBasisPoints) / 10000n;

        // Use the larger of minimum or scaled profit
        const profitMarginAmount =
          scaledProfitAmount > minProfitAmount
            ? scaledProfitAmount
            : minProfitAmount;

        // Calculate optimal threshold including gas cost (only if enabled) and profit margin
        const optimalThreshold =
          payoutAmount +
          (CONFIG.profitability.includeGasCost ? gasCost : 0n) +
          profitMarginAmount;

        // CRITICAL: Final safety check - ensure threshold is at most 85% of expected profit
        const expectedProfit = tx.profitability.estimates.expected_profit;

        // Base threshold - must be greater than payout amount plus minimum profit
        const minThreshold =
          payoutAmount + (payoutAmount * minProfitMarginBasisPoints) / 10000n;

        // Calculate maximum allowed threshold (85% of expected profit)
        const maxAllowedThreshold = (expectedProfit * 85n) / 100n;

        // Determine final threshold:
        let finalThreshold: bigint;

        if (optimalThreshold <= minThreshold) {
          this.logger.info(
            'Optimal threshold below minimum, using minimum threshold',
            {
              optimalThreshold: optimalThreshold.toString(),
              minThreshold: minThreshold.toString(),
              minimumProfitMargin: `${profitMargin}%`,
            },
          );
          finalThreshold = minThreshold;
        } else if (optimalThreshold > maxAllowedThreshold) {
          // Before using maxAllowedThreshold, verify it provides minimum profit margin
          const maxAllowedProfit =
            maxAllowedThreshold -
            payoutAmount -
            (CONFIG.profitability.includeGasCost ? gasCost : 0n);
          const maxAllowedProfitMargin =
            (maxAllowedProfit * 10000n) / baseAmount;

          if (maxAllowedProfitMargin < minProfitMarginBasisPoints) {
            this.logger.info(
              'Max allowed threshold does not meet minimum profit margin, using minimum threshold',
              {
                maxAllowedThreshold: maxAllowedThreshold.toString(),
                maxAllowedProfitMargin: `${Number(maxAllowedProfitMargin) / 100}%`,
                requiredMinimum: `${profitMargin}%`,
                usingThreshold: minThreshold.toString(),
              },
            );
            finalThreshold = minThreshold;
          } else {
            this.logger.info('Using maximum allowed threshold', {
              originalThreshold: optimalThreshold.toString(),
              maxAllowedThreshold: maxAllowedThreshold.toString(),
              effectiveProfitMargin: `${Number(maxAllowedProfitMargin) / 100}%`,
            });
            finalThreshold = maxAllowedThreshold;
          }
        } else {
          finalThreshold = optimalThreshold;
        }

        this.logger.info('Final threshold calculation details:', {
          value: finalThreshold.toString(),
          components: {
            payoutAmount: payoutAmount.toString(),
            gasCost: gasCost.toString(),
            gasCostIncluded: CONFIG.profitability.includeGasCost,
            profitMarginAmount: profitMarginAmount.toString(),
            expectedProfit: expectedProfit.toString(),
            effectiveProfitMargin: CONFIG.profitability.includeGasCost
              ? `${Number(((finalThreshold - payoutAmount - gasCost) * 10000n) / baseAmount) / 100}%`
              : `${Number(((finalThreshold - payoutAmount) * 10000n) / baseAmount) / 100}%`,
            minimumRequiredProfitMargin: `${profitMargin}%`,
          },
        });

        this.logger.info('Calculated optimal threshold:', {
          payoutAmount: ethers.formatEther(payoutAmount),
          payoutAmountRaw: payoutAmount.toString(),
          gasCost: ethers.formatEther(gasCost),
          gasCostRaw: gasCost.toString(),
          gasCostIncluded: CONFIG.profitability.includeGasCost,
          profitMargin: `${Number(profitMarginBasisPoints) / 100}%`,
          profitMarginAmount: ethers.formatEther(profitMarginAmount),
          profitMarginAmountRaw: profitMarginAmount.toString(),
          optimalThreshold: ethers.formatEther(finalThreshold),
          optimalThresholdRaw: finalThreshold.toString(),
          expectedProfit: ethers.formatEther(expectedProfit),
          expectedProfitRaw: expectedProfit.toString(),
        });

        // Validation check should never fail now since we ensure finalThreshold > payoutAmount
        if (finalThreshold <= payoutAmount) {
          const error = new TransactionValidationError(
            'Optimal threshold is less than or equal to payout amount',
            {
              optimalThreshold: finalThreshold.toString(),
              payoutAmount: payoutAmount.toString(),
              depositIds: tx.depositIds.map(String),
            },
          );
          this.errorLogger.error(error, {
            stage: 'executeTransaction_thresholdValidation',
            txId: tx.id,
          });
          throw error;
        }

        // Verify that expected profit is greater than our calculated threshold
        // This should now always pass due to our capping logic above
        if (tx.profitability.estimates.expected_profit < finalThreshold) {
          const error = new TransactionValidationError(
            'Expected profit less than optimal threshold with gas costs',
            {
              expectedProfit:
                tx.profitability.estimates.expected_profit.toString(),
              calculatedThreshold: finalThreshold.toString(),
              difference: (
                finalThreshold - tx.profitability.estimates.expected_profit
              ).toString(),
              depositIds: depositIds.map(String),
              gasCostIncluded: CONFIG.profitability.includeGasCost,
            },
          );
          this.errorLogger.error(error, {
            stage: 'executeTransaction_profitValidation',
            txId: tx.id,
          });
          throw error;
        }

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

          // Apply moderate boost to gas values for reliable inclusion
          if (maxFeePerGas) {
            maxFeePerGas = (maxFeePerGas * 120n) / 100n;
          }

          if (maxPriorityFeePerGas) {
            maxPriorityFeePerGas = (maxPriorityFeePerGas * 130n) / 100n;
          }

          this.logger.info(
            'Retrieved and moderately boosted network fee data',
            {
              txId: tx.id,
              maxFeePerGas: maxFeePerGas?.toString() || 'undefined',
              maxPriorityFeePerGas:
                maxPriorityFeePerGas?.toString() || 'undefined',
              boostedBy: 'Fee: 20%, Priority: 30%',
            },
          );
        } catch (error) {
          this.logger.error('Failed to get fee data', {
            error: error instanceof Error ? error.message : String(error),
          });
          this.errorLogger.error(
            error instanceof Error
              ? error
              : new Error(`Failed to get fee data: ${String(error)}`),
            {
              stage: 'executeTransaction_feeData',
              txId: tx.id,
            },
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
            contractAddress: this.lstContract.target?.toString(),
          });
          throw error;
        }

        // Log transaction parameters before execution
        this.logger.info('Executing claimAndDistributeReward', {
          recipient: signerAddress,
          minExpectedReward: finalThreshold.toString(),
          depositIds: depositIds.map((id) => id.toString()),
          gasEstimate: tx.profitability.estimates.gas_estimate.toString(),
          calculatedGasLimit: calculatedGasLimit.toString(),
          maxFeePerGas: maxFeePerGas?.toString() || 'undefined',
          maxPriorityFeePerGas: maxPriorityFeePerGas?.toString() || 'undefined',
        });

        // Store depositIds in tx object for later use in receipt processing
        tx.metadata = {
          queueItemId,
          depositIds: queueDepositIds,
        };

        // Run transaction simulation before submitting to chain
        // This will validate if the transaction will likely succeed and provide optimal gas estimates
        let simulationGasLimit: bigint | null = null;
        try {
          const simulationResult = await this.simulateTransaction(
            tx,
            depositIds,
            signerAddress,
            finalThreshold,
            calculatedGasLimit,
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
            this.errorLogger.error(
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

            // Update transaction status to failed
            tx.status = TransactionStatus.FAILED;
            tx.error = new Error(
              `Simulation failed: ${simulationResult.error}`,
            );
            this.queue.set(tx.id, tx);

            // Cleanup the queue item
            await cleanupQueueItemsHelper(
              tx,
              '',
              this.db,
              this.logger,
              this.errorLogger,
            );

            // Remove from queue and exit
            this.queue.delete(tx.id);
            return;
          }

          // If simulation succeeded and provided gas estimate, use it if it's better
          if (simulationResult.gasEstimate) {
            this.logger.info('Using gas limit from simulation', {
              txId: tx.id,
              originalLimit: calculatedGasLimit.toString(),
              simulationEstimate: simulationResult.gasEstimate.toString(),
              optimizedLimit:
                simulationResult.optimizedGasLimit?.toString() || 'N/A',
            });

            // If optimized gas limit is available and higher than our calculated limit, use it
            if (
              simulationResult.optimizedGasLimit &&
              simulationResult.optimizedGasLimit > calculatedGasLimit
            ) {
              simulationGasLimit = simulationResult.optimizedGasLimit;
            } else if (simulationResult.gasEstimate) {
              // Otherwise use the gas estimate with buffer
              simulationGasLimit = simulationResult.gasEstimate;
            }
          }
        } catch (simError) {
          // If simulation fails with an exception, log but continue with original gas parameters
          this.logger.warn(
            'Transaction simulation error, continuing with standard parameters',
            {
              error:
                simError instanceof Error ? simError.message : String(simError),
              txId: tx.id,
            },
          );
          this.errorLogger.warn(
            simError instanceof Error
              ? simError
              : new Error(`Simulation error: ${String(simError)}`),
            {
              stage: 'executeTransaction_simulationError',
              txId: tx.id,
            },
          );
        }

        // Select the final gas limit to use
        const finalSimulatedGasLimit = simulationGasLimit || calculatedGasLimit;

        // Use the limit from simulation if available
        if (simulationGasLimit && simulationGasLimit !== calculatedGasLimit) {
          this.logger.info('Using gas limit from simulation', {
            txId: tx.id,
            originalLimit: calculatedGasLimit.toString(),
            simulationLimit: simulationGasLimit.toString(),
            finalLimit: finalSimulatedGasLimit.toString(),
          });
        }

        // Execute via contract with signer with increased gas parameters
        const response = await this.lstContract
          .claimAndDistributeReward(signerAddress, finalThreshold, depositIds, {
            gasLimit: finalSimulatedGasLimit,
            maxFeePerGas: this.config.gasPolicy?.maxFeePerGas || maxFeePerGas,
            maxPriorityFeePerGas:
              this.config.gasPolicy?.maxPriorityFeePerGas ||
              maxPriorityFeePerGas,
          })
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
                  e instanceof Error
                    ? e
                    : new Error(
                        `Failed to get network diagnostics: ${String(e)}`,
                      ),
                  {
                    stage: 'executeTransaction_networkDiagnostics',
                    txId: tx.id,
                  },
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
                  minExpectedReward: finalThreshold.toString(),
                  depositIds: depositIds.map(String),
                  gasLimit: finalSimulatedGasLimit.toString(),
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
                new Error(
                  `Defender Relayer 400 Error: ${defenderError.message}`,
                ),
                {
                  stage: 'executeTransaction_defender400',
                  txId: tx.id,
                  responseStatus: defenderError.response?.status,
                  responseData: JSON.stringify(defenderError.response?.data),
                  currentBlock: blockNumber,
                  balance: balance?.toString(),
                  networkGasPrice: JSON.stringify({
                    maxFeePerGas: networkGasPrice?.maxFeePerGas?.toString(),
                    maxPriorityFeePerGas:
                      networkGasPrice?.maxPriorityFeePerGas?.toString(),
                    gasPrice: networkGasPrice?.gasPrice?.toString(),
                  }),
                },
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
                    minBalance: this.config.minBalance.toString(),
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
                      [signerAddress, finalThreshold, depositIds],
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
                      estimateError instanceof Error
                        ? estimateError
                        : new Error(
                            `Gas estimation failed: ${String(estimateError)}`,
                          ),
                      {
                        stage: 'executeTransaction_gasEstimation',
                        txId: tx.id,
                        data: JSON.stringify(estimateError.data),
                      },
                    );
                    return null;
                  });

                if (estimatedGas) {
                  const estimatedGasBigInt = BigInt(estimatedGas.toString());
                  if (estimatedGasBigInt > finalSimulatedGasLimit) {
                    // If estimated gas exceeds our limit, increase by 30% over estimated gas
                    const newGasLimit = (estimatedGasBigInt * 130n) / 100n;
                    this.logger.info(
                      'Increasing gas limit based on estimation',
                      {
                        originalGasLimit: finalSimulatedGasLimit.toString(),
                        estimatedGas: estimatedGasBigInt.toString(),
                        newGasLimit: newGasLimit.toString(),
                      },
                    );
                    simulationGasLimit = newGasLimit;
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
                    minExpectedReward: finalThreshold.toString(),
                    depositIds: depositIds.map(String),
                  },
                });
                this.errorLogger.error(
                  gasError instanceof Error
                    ? gasError
                    : new Error(`Gas estimation error: ${String(gasError)}`),
                  {
                    stage: 'executeTransaction_gasError',
                    txId: tx.id,
                    recipient: signerAddress,
                    depositIds: depositIds.map(String).join(','),
                  },
                );
              }

              if (networkGasPrice?.maxFeePerGas && maxFeePerGas) {
                const networkMaxFee = BigInt(
                  networkGasPrice.maxFeePerGas.toString(),
                );
                if (networkMaxFee > maxFeePerGas) {
                  // If network gas price exceeds our configured max, use a 20% buffer on network price
                  maxFeePerGas = (networkMaxFee * 120n) / 100n;
                  this.logger.info(
                    'Adjusting maxFeePerGas to current network conditions',
                    {
                      networkFee: networkMaxFee.toString(),
                      adjustedFee: maxFeePerGas.toString(),
                    },
                  );
                }
              }

              // Check if the error response contains specific Defender error codes
              const defenderErrorData = defenderError.response?.data?.error;
              if (defenderErrorData) {
                switch (defenderErrorData.code) {
                  case 'NONCE_TOO_LOW': {
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
                      suggestedNonce: defenderErrorData.suggestedNonce,
                    });
                    throw nonceError;
                  }
                  case 'INSUFFICIENT_FUNDS': {
                    const fundsError = new InsufficientBalanceError(
                      BigInt(balance?.toString() || '0'),
                      this.config.minBalance,
                    );
                    this.errorLogger.error(fundsError, {
                      stage: 'executeTransaction_insufficientFunds',
                      txId: tx.id,
                      balance: balance?.toString() || '0',
                      minBalance: this.config.minBalance.toString(),
                    });
                    throw fundsError;
                  }
                  case 'GAS_LIMIT_TOO_LOW': {
                    // If suggested gas limit is provided, use it with a buffer
                    if (defenderErrorData.suggestedGasLimit) {
                      const suggestedGasLimit = BigInt(
                        String(defenderErrorData.suggestedGasLimit),
                      );
                      const newGasLimit = (suggestedGasLimit * 130n) / 100n; // Add 30% buffer

                      this.logger.info(
                        'Adjusting gas limit based on suggested value',
                        {
                          suggestedGasLimit: suggestedGasLimit.toString(),
                          newGasLimit: newGasLimit.toString(),
                        },
                      );

                      // Retry with new gas limit
                      return this.lstContract.claimAndDistributeReward(
                        signerAddress,
                        finalThreshold,
                        depositIds,
                        {
                          gasLimit: newGasLimit,
                          maxFeePerGas:
                            this.config.gasPolicy?.maxFeePerGas || maxFeePerGas,
                          maxPriorityFeePerGas:
                            this.config.gasPolicy?.maxPriorityFeePerGas ||
                            maxPriorityFeePerGas,
                        },
                      );
                    }

                    const gasLimitError = new ExecutorError(
                      'Gas limit too low for complex transaction',
                      {
                        providedGasLimit: finalSimulatedGasLimit.toString(),
                        suggestedGasLimit: defenderErrorData.suggestedGasLimit,
                      },
                      true,
                    );
                    this.errorLogger.error(gasLimitError, {
                      stage: 'executeTransaction_gasLimitTooLow',
                      txId: tx.id,
                      providedGasLimit: finalSimulatedGasLimit.toString(),
                      suggestedGasLimit: defenderErrorData.suggestedGasLimit,
                    });
                    throw gasLimitError;
                  }
                  default: {
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
                      errorCode: defenderErrorData.code,
                    });
                    throw defaultError;
                  }
                }
              }

              // Check if the error message contains "out of gas" or "reentrancy sentry"
              const errorMessage = defenderError.message || '';
              if (
                errorMessage.includes('out of gas') ||
                errorMessage.includes('reentrancy sentry') ||
                errorMessage.includes('exceeds block gas limit')
              ) {
                this.logger.error(
                  'Gas limit too low for reentrancy protection',
                  {
                    error: errorMessage,
                    currentGasLimit: finalSimulatedGasLimit.toString(),
                  },
                );

                // Double the gas limit and retry
                const newGasLimit = finalSimulatedGasLimit * 2n;
                this.logger.info(
                  'Doubling gas limit for reentrancy protection',
                  {
                    originalGasLimit: finalSimulatedGasLimit.toString(),
                    newGasLimit: newGasLimit.toString(),
                  },
                );

                // Retry with doubled gas limit
                return this.lstContract.claimAndDistributeReward(
                  signerAddress,
                  finalThreshold,
                  depositIds,
                  {
                    gasLimit: newGasLimit,
                    maxFeePerGas:
                      this.config.gasPolicy?.maxFeePerGas || maxFeePerGas,
                    maxPriorityFeePerGas:
                      this.config.gasPolicy?.maxPriorityFeePerGas ||
                      maxPriorityFeePerGas,
                  },
                );
              }
            }

            // If not a 400 error or no specific error code, throw the original error
            this.errorLogger.error(
              error instanceof Error
                ? error
                : new Error(`Transaction submission error: ${String(error)}`),
              {
                stage: 'executeTransaction_submissionError',
                txId: tx.id,
                depositIds: depositIds.map(String).join(','),
              },
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
            this.logger.info(`Transaction receipt received: ${response.hash}`, {
              txId: tx.id,
              blockNumber: receipt?.blockNumber?.toString() || 'unknown',
              status: receipt?.status?.toString() || 'unknown',
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
          await processTransactionReceiptHelper(
            tx,
            response,
            receipt,
            this.logger,
            this.errorLogger,
            async (txArg, txHashArg) => {
              await cleanupQueueItemsHelper(
                txArg,
                txHashArg,
                this.db,
                this.logger,
                this.errorLogger,
              );

              // Check if we need to swap tokens for ETH after transaction
              await this.checkAndSwapTokensIfNeeded();
            },
          );
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
            waitError instanceof Error
              ? waitError
              : new Error(
                  `Failed waiting for transaction confirmation: ${String(waitError)}`,
                ),
            {
              stage: 'executeTransaction_waitError',
              txId: tx.id,
              hash: response.hash,
              depositIds: depositIds.map(String).join(','),
            },
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
        await handleExecutionErrorHelper(
          tx,
          error,
          this.logger,
          this.errorLogger,
          this.queue,
          async (txArg, txHashArg) => {
            await cleanupQueueItemsHelper(
              txArg,
              txHashArg,
              this.db,
              this.logger,
              this.errorLogger,
            );

            // Check token swap needs even after error
            await this.checkAndSwapTokensIfNeeded();
          },
        );
      }
    } catch (error) {
      await handleExecutionErrorHelper(
        tx,
        error,
        this.logger,
        this.errorLogger,
        this.queue,
        async (txArg, txHashArg) => {
          await cleanupQueueItemsHelper(
            txArg,
            txHashArg,
            this.db,
            this.logger,
            this.errorLogger,
          );
        },
      );
    }
  }

  /**
   * Simulates a transaction to verify it will succeed and estimate gas costs
   * This uses Tenderly simulation API to validate the transaction without submitting to the chain
   *
   * @param tx The transaction to simulate
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
      const data = this.lstContract.interface.encodeFunctionData(
        'claimAndDistributeReward',
        [signerAddress, minExpectedReward, depositIds],
      );

      const contractAddress = this.lstContract.target.toString();

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
      const data = this.lstContract.interface.encodeFunctionData(
        'claimAndDistributeReward',
        [recipient, reward, depositIds],
      );

      // Create simulation transaction with a high gas limit to ensure it doesn't fail due to gas
      const simulationTx: SimulationTransaction = {
        from: recipient,
        to: this.lstContract.target.toString(),
        data,
        gas: 5000000, // 10M gas as a high limit for estimation
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
      // Check relayer ETH balance
      const relayerBalance =
        await this.lstContract.runner?.provider?.getBalance(
          await this.relaySigner.getAddress(),
        );

      if (!relayerBalance) {
        this.logger.warn('Unable to get relayer balance');
        return;
      }

      const minEthBalance = ethers.parseEther('0.1'); // 0.1 ETH threshold

      if (relayerBalance < minEthBalance) {
        this.logger.info(
          'Relayer ETH balance below threshold, attempting to swap tokens',
          {
            currentBalance: ethers.formatEther(relayerBalance),
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
        this.errorLogger.error(
          error instanceof Error ? error : new Error(String(error)),
          {
            stage: 'relayer-executor-check-eth-balance',
          },
        );
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
      if (typeof this.lstContract.REWARD_TOKEN !== 'function') {
        throw new Error('REWARD_TOKEN method not found on contract');
      }

      const rewardTokenAddress = await this.lstContract.REWARD_TOKEN();
      if (!rewardTokenAddress) {
        throw new Error('Failed to get reward token address');
      }

      // Get relayer address
      const signerAddress = await this.relaySigner.getAddress();

      // Create token contract
      const tokenAbi = [
        'function balanceOf(address account) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
        'function decimals() view returns (uint8)',
      ] as const;

      const tokenContract = new ethers.Contract(
        rewardTokenAddress,
        tokenAbi,
        this.relaySigner as unknown as ethers.Signer,
      ) as ethers.Contract & {
        balanceOf(account: string): Promise<bigint>;
        approve(
          spender: string,
          amount: bigint,
        ): Promise<ethers.ContractTransactionResponse>;
        decimals(): Promise<number>;
      };

      // Create Uniswap router contract - use relaySigner directly
      const uniswapAbi = [
        'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
        'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)',
      ] as const;

      const uniswapRouter = new ethers.Contract(
        CONFIG.executor.swap.uniswapRouterAddress,
        uniswapAbi,
        this.relaySigner as unknown as ethers.Signer,
      ) as ethers.Contract & {
        swapExactTokensForETH(
          amountIn: bigint,
          amountOutMin: bigint,
          path: string[],
          to: string,
          deadline: number,
        ): Promise<ethers.ContractTransactionResponse>;
        getAmountsOut(amountIn: bigint, path: string[]): Promise<bigint[]>;
      };

      // Get token balance
      const tokenBalance = await tokenContract.balanceOf(signerAddress);
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
      const payoutAmount = await this.lstContract.payoutAmount();

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

      // Wait for receipt
      const approvalReceipt = await pollForReceipt(
        approveTx.hash,
        this.relayProvider as unknown as ethers.Provider,
        this.logger,
        1,
      );

      if (!approvalReceipt || approvalReceipt.status !== 1) {
        throw new Error('Approval transaction failed');
      }

      this.logger.info('Approval confirmed', {
        hash: approveTx.hash,
        blockNumber: approvalReceipt.blockNumber,
      });

      // Execute the swap
      const swapTx = await uniswapRouter.swapExactTokensForETH(
        swapAmount,
        minOutputWithSlippage,
        path,
        signerAddress,
        deadline,
      );

      this.logger.info('Swap transaction submitted', {
        hash: swapTx.hash,
      });

      // Wait for swap to be mined
      const swapReceipt = await pollForReceipt(
        swapTx.hash,
        this.relayProvider as unknown as ethers.Provider,
        this.logger,
        1,
      );

      if (!swapReceipt) {
        throw new Error('No receipt returned from swap transaction');
      }

      this.logger.info('Token swap successful', {
        hash: swapTx.hash,
        gasUsed: swapReceipt.gasUsed?.toString(),
        blockNumber: swapReceipt.blockNumber,
        tokensSwapped: ethers.formatUnits(swapAmount, decimals),
      });
    } catch (error) {
      this.logger.error('Token swap failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      if (this.errorLogger) {
        this.errorLogger.error(
          error instanceof Error ? error : new Error(String(error)),
          {
            stage: 'relayer-executor-token-swap-error',
          },
        );
      }
    }
  }
}
