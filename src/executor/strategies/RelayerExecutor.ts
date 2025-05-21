import { ethers, Provider, Signer } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { IExecutor } from '../interfaces/IExecutor';
import {
  RelayerExecutorConfig,
  QueuedTransaction,
  TransactionStatus,
  QueueStats,
  TransactionReceipt,
  EthersTransactionReceipt,
  DefenderTransactionRequest,
  RelayerTransactionState,
} from '../interfaces/types';
import { GovLstProfitabilityCheck } from '@/profitability/interfaces/types';
import { DatabaseWrapper } from '@/database';
import {
  DefenderRelayProvider,
  DefenderRelaySigner,
} from '@openzeppelin/defender-relay-client/lib/ethers';
import {
  TransactionQueueStatus,
  TransactionDetails,
  TransactionDetailsStatus,
} from '@/database/interfaces/types';
import {
  ContractMethodError,
  ExecutorError,
  InsufficientBalanceError,
  TransactionValidationError,
} from '@/configuration/errors';
import { CONFIG } from '@/configuration';
import { ErrorLogger, createErrorLogger } from '@/configuration/errorLogger';
import { DefenderError, GasEstimationError } from '../interfaces/types';
import { RELAYER_QUEUE } from './constants';
import {
  cleanupQueueItems,
  handleExecutionError,
  queueTransactionWithValidation,
  validateRelayerTransaction,
  transferOutTips,
  processTransactionReceipt,
  processQueue,
} from './helpers';
import { pollForReceipt, calculateGasLimit, calculateQueueStats } from '@/configuration/helpers';
import { simulateTransaction, estimateGasUsingSimulation } from './simulation-helpers';
import { handlePendingRelayerTransactions, cleanupStaleTransactions as cleanupStaleDefenderTransactions } from './defender-helpers';
import { checkAndSwapTokensIfNeeded } from './token-swap-helpers';
import { Defender } from '@openzeppelin/defender-sdk';
import { GasCostEstimator } from '@/prices/GasCostEstimator';
import { SimulationService } from '@/simulation';
import { handleFlashbotsSimulationAndReplacement } from './defender-helpers';
import { handleStartupCleanup } from './defender-helpers';

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
  private cleanupInProgress: Set<string> = new Set();
  private readonly gasCostEstimator: GasCostEstimator;
  private readonly simulationService: SimulationService | null;

  // Add new state tracking
  private pendingTransactions: Map<string, RelayerTransactionState> = new Map();
  private readonly TX_TIMEOUT = 60 * 60 * 1000; // 1 hour
  private readonly CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
  private cleanupInterval: NodeJS.Timeout | null = null;

  // Add a property to store the defender client instance
  private defenderClient: Defender | null = null;

  // Track replaced transactions by nonce
  private replacedNonces: Set<number> = new Set();
  private lastReplacementTime: number = 0;
  private readonly REPLACEMENT_COOLDOWN = 30 * 60 * 1000; // 30 minutes

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
      this.logger.info('Initialized simulation service for transaction validation');
    } catch (error) {
      this.logger.warn('Failed to initialize simulation service, will use fallback gas estimation', {
        error: error instanceof Error ? error.message : String(error),
      });
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
      const executorError = new ExecutorError('Failed to initialize Defender SDK', {
        error: error instanceof Error ? error.message : String(error),
      }, false);
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

    // Add cleanup interval
    this.cleanupInterval = setInterval(() => {
      cleanupStaleDefenderTransactions(
        this.pendingTransactions,
        this.TX_TIMEOUT,
        this.defenderClient,
        CONFIG.govlst.address,
        this.logger,
      );
    }, this.CLEANUP_INTERVAL);

    // Instantiate a Defender SDK client for auxiliary relayer operations
    this.defenderClient = new Defender({
      apiKey: this.config.apiKey,
      apiSecret: this.config.apiSecret,
    });
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

    // Run startup cleanup
    try {
      await handleStartupCleanup(
        this.defenderClient,
        CONFIG.profitability.rewardTokenAddress,
        CONFIG.govlst.address,
        this.logger,
      );
    } catch (error) {
      this.logger.error('Failed to run startup cleanup:', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue starting up even if cleanup fails
    }

    this.startQueueProcessor();
    this.logger.info('RelayerExecutor started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.stopQueueProcessor();

    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

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
          const payoutAmount = profitability.estimates.payout_amount || BigInt(0);

          // Use a minimal expected reward for estimation
          const simulatedGas = await estimateGasUsingSimulation(
            depositIds,
            signerAddress,
            payoutAmount,
            this.lstContract,
            this.simulationService,
            this.logger,
          );

          if (simulatedGas !== null && simulatedGas > profitability.estimates.gas_estimate) {
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
          this.logger.warn('Simulation-based gas estimation failed during validation', {
            error: error instanceof Error ? error.message : String(error),
            depositIds: depositIds.map(String),
          });
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

  async getTransactionReceipt(hash: string): Promise<TransactionReceipt | null> {
    const receipt = (await this.lstContract.runner?.provider?.getTransactionReceipt(
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
    return transferOutTips(
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
    this.processingInterval = setInterval(() => {
      // Run the queue processor
      processQueue(
        true,
        this.isRunning,
        this.config,
        this.relayProvider as unknown as ethers.Provider,
        this.queue,
        this.executeTransaction.bind(this),
        this.logger,
        this.errorLogger,
        this.db,
      );
    }, RELAYER_QUEUE.PROCESSOR_INTERVAL);
  }

  protected stopQueueProcessor(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
  }

  protected async executeTransaction(tx: QueuedTransaction): Promise<void> {
    // STEP 1: Before doing anything else, check the relayer for on-chain pending transactions.
    try {
      const pendingHandled = await handlePendingRelayerTransactions(
        this.defenderClient,
        this.logger,
        CONFIG.govlst.address,
      );
      if (pendingHandled) {
        // We already submitted replacement transactions – exit early to avoid spamming the mempool.
        this.logger.info('Exiting executeTransaction early – pending transactions were replaced');
        return;
      }
    } catch (checkErr) {
      this.logger.error('Failed to inspect/replace pending transactions (continuing execution)', {
        error: checkErr instanceof Error ? checkErr.message : String(checkErr),
      });
    }

    // Check for existing pending transaction first
    const pendingTx = this.pendingTransactions.get(tx.id);
    if (pendingTx) {
      const now = Date.now();
      if (now - pendingTx.submittedAt > this.TX_TIMEOUT) {
        await cleanupStaleDefenderTransactions(
          this.pendingTransactions,
          this.TX_TIMEOUT,
          this.defenderClient,
          CONFIG.govlst.address,
          this.logger,
        );
      }
      return; // Exit early if transaction is already pending
    }

    // Initialize transaction tracking data
    const txStartTime = new Date();
    let transactionDetailsId: string | undefined;

    try {
      if (!this.lstContract) {
        const error = new ExecutorError('LST contract not initialized', {}, false);
        this.errorLogger.error(error, {
          stage: 'executeTransaction',
          txId: tx.id,
        });
        throw error;
      }

      // Check for existence of REWARD_TOKEN (either as a property or a function)
      try {
        // Test if we can access REWARD_TOKEN (without calling it yet)
        const hasRewardToken = typeof this.lstContract.REWARD_TOKEN !== 'undefined';
        if (!hasRewardToken) {
          const error = new ExecutorError('LST contract missing REWARD_TOKEN property or method', {}, false);
          this.errorLogger.error(error, {
            stage: 'executeTransaction',
            txId: tx.id,
            contractAddress: this.lstContract.target?.toString(),
          });
          throw error;
        }
      } catch (error) {
        const execError = new ExecutorError('Failed to access REWARD_TOKEN on LST contract', {
          error: error instanceof Error ? error.message : String(error),
        }, false);
        this.errorLogger.error(execError, {
          stage: 'executeTransaction_checkRewardToken',
          txId: tx.id,
          contractAddress: this.lstContract.target?.toString(),
        });
        throw execError;
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
          this.logger.info(`Updated transaction queue item status to PENDING: ${queueItemId}`, {
            txId: tx.id,
            queueItemId,
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
              queueItemId,
            },
          );
        }
      }

      // Get reward token address - first try contract, then fallback to config
      let rewardTokenAddress: string;
      try {
        // Check if REWARD_TOKEN is a function (most likely) or a property
        if (typeof this.lstContract.REWARD_TOKEN === 'function') {
          // Call it as a function
          const contractToken = await this.lstContract.REWARD_TOKEN();
          rewardTokenAddress = String(contractToken);
        } else {
          // Try accessing it as a property
          const contractToken = this.lstContract.REWARD_TOKEN;
          rewardTokenAddress = String(contractToken);
        }

        if (!rewardTokenAddress) {
          throw new Error('REWARD_TOKEN not found on contract');
        }

        this.logger.info('Retrieved reward token address', {
          address: rewardTokenAddress,
          contractAddress: this.lstContract.target.toString(),
        });
      } catch (error) {
        // Fallback to config value
        rewardTokenAddress = CONFIG.profitability.rewardTokenAddress;
        if (!rewardTokenAddress) {
          throw new Error('No reward token address available in contract or config');
        }
        this.logger.info('Using reward token address from config', {
          address: rewardTokenAddress,
        });
      }

      const rewardTokenAbi = [
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)',
      ] as const;

      const rewardTokenContract = new ethers.Contract(
        rewardTokenAddress,
        rewardTokenAbi,
        this.lstContract.runner,
      ).connect(this.relaySigner as unknown as ethers.Signer) as ethers.Contract & {
        approve(spender: string, amount: bigint): Promise<ethers.ContractTransactionResponse>;
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
          this.logger.info(`Retrieved payout amount: ${payoutAmount.toString()}`, {
            txId: tx.id,
          });
        } catch (error) {
          this.logger.error('Failed to get payout amount for allowance check', {
            error: error instanceof Error ? error.message : String(error),
          });
          this.errorLogger.error(
            error instanceof Error ? error : new Error(`Failed to get payout amount: ${String(error)}`),
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
          await rewardTokenContract.allowance(signerAddress, lstContractAddress),
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

          const approveTx = await rewardTokenContract.approve(lstContractAddress, approvalAmount);
          // Wait for the transaction to be mined
          try {
            this.logger.info('Waiting for approval transaction...');
            let receipt;
            try {
              receipt = await pollForReceipt(approveTx.hash, this.relayProvider as unknown as ethers.Provider, this.logger, 3);
            } catch (confirmError: unknown) {
              // If polling fails, just log the error
              this.logger.warn('Standard wait for approval failed', {
                error: confirmError instanceof Error ? confirmError.message : String(confirmError),
                hash: approveTx.hash,
                errorType:
                  typeof confirmError === 'object' && confirmError !== null
                    ? confirmError.constructor?.name || 'Unknown'
                    : typeof confirmError,
              });

              this.logger.info('Continuing execution despite wait error - approval may still have succeeded');

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
              error: waitError instanceof Error ? waitError.message : String(waitError),
              hash: approveTx.hash,
            });
            throw new ExecutorError('Failed waiting for approval confirmation', {
              error: waitError instanceof Error ? waitError.message : String(waitError),
            }, false);
          }
        }
      } catch (error) {
        this.logger.error('Token approval error details', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          rewardToken: rewardTokenAddress,
          contractAddress: this.lstContract.target.toString(),
        });
        throw new ExecutorError('Failed to approve reward token spend', {
          error: error instanceof Error ? error.message : String(error),
        }, false);
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
        const baseGasLimit = gasEstimate < 300000n ? 1200000n : gasEstimate * 2n;

        // Calculate gas limit with deposit count scaling
        const calculatedGasLimit = calculateGasLimit(baseGasLimit, depositIds.length, this.logger);
        
        // Calculate real gas cost in reward tokens
        let gasCost: bigint;

        try {
          // Use the GasCostEstimator to get a real gas cost estimate based on calculated gas limit
          gasCost = await this.gasCostEstimator.estimateGasCostInRewardToken(
            this.relayProvider as unknown as ethers.Provider,
            calculatedGasLimit,
          );

          // Simple safety check - if gas cost is unreasonable, use a flat value
          if (
            gasCost < ethers.parseUnits(CONFIG.executor.minGasCost, 18) ||
            gasCost > ethers.parseUnits(CONFIG.executor.maxGasCost, 18)
          ) {
            this.logger.warn('Gas cost outside reasonable range, using flat default', {
              calculatedGasCost: ethers.formatUnits(gasCost, 18),
              usingDefaultCost: CONFIG.executor.avgGasCost,
              calculatedGasLimit: calculatedGasLimit.toString(),
            });
            gasCost = ethers.parseUnits(CONFIG.executor.avgGasCost, 18); // Flat avgGasCost tokens
          }

          this.logger.info('Calculated gas cost in reward tokens:', {
            gasCost: gasCost.toString(),
            gasLimit: calculatedGasLimit.toString(),
          });
        } catch (error) {
          this.logger.error('Failed to estimate gas cost in reward tokens', {
            error: error instanceof Error ? error.message : String(error),
          });

          // Use flat default when estimation fails
          gasCost = ethers.parseUnits(CONFIG.executor.avgGasCost, 18); // Flat avgGasCost tokens

          this.logger.info('Using default gas cost:', {
            gasCost: gasCost.toString(),
            gasLimit: calculatedGasLimit.toString(),
          });
        }

        // Get profit margin directly from CONFIG to ensure we use the environment variable value
        const profitMargin = +CONFIG.profitability.minProfitMargin;

        if (typeof profitMargin !== 'number' || isNaN(profitMargin) || profitMargin <= 0) {
          const error = new Error(`Invalid profit margin value: ${profitMargin}. Must be a positive number.`);
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
        const depositScalingBasisPoints = BigInt(Math.min(20, Number(depositCount) * 5));

        // Start with the minimum profit margin in basis points
        const minProfitMarginBasisPoints = BigInt(Math.floor(profitMargin * 100));
        // Add the scaling factor (cap at 1500 basis points = 15%)
        const scaledProfitMarginBasisPoints = BigInt(
          Math.min(1500, Number(minProfitMarginBasisPoints + depositScalingBasisPoints)),
        );

        // Already in basis points (100 = 1%)
        const profitMarginBasisPoints = scaledProfitMarginBasisPoints;

        // Simple threshold calculation - always include gas cost if enabled, apply profit margin to payout
        const profitMarginAmount = (payoutAmount * profitMarginBasisPoints) / 10000n;
        const finalThreshold =
          payoutAmount +
          (CONFIG.profitability.includeGasCost ? gasCost : 0n) +
          profitMarginAmount;

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

          // Apply slight boost to gas values for reliable inclusion
          if (maxFeePerGas) {
            maxFeePerGas = (maxFeePerGas * 125n) / 100n;
          }

          if (maxPriorityFeePerGas) {
            maxPriorityFeePerGas = (maxPriorityFeePerGas * 125n) / 100n;
          }

          // NEW: Prefer the higher of network fee data or any configured override
          const configuredMaxFeePerGas = this.config.gasPolicy?.maxFeePerGas;
          const configuredMaxPriorityFeePerGas = this.config.gasPolicy?.maxPriorityFeePerGas;

          const finalMaxFeePerGas =
            configuredMaxFeePerGas && maxFeePerGas
              ? maxFeePerGas > configuredMaxFeePerGas
                ? maxFeePerGas
                : configuredMaxFeePerGas
              : configuredMaxFeePerGas || maxFeePerGas;

          const finalMaxPriorityFeePerGas =
            configuredMaxPriorityFeePerGas && maxPriorityFeePerGas
              ? maxPriorityFeePerGas > configuredMaxPriorityFeePerGas
                ? maxPriorityFeePerGas
                : configuredMaxPriorityFeePerGas
              : configuredMaxPriorityFeePerGas || maxPriorityFeePerGas;

          maxFeePerGas = finalMaxFeePerGas;
          maxPriorityFeePerGas = finalMaxPriorityFeePerGas;

          this.logger.info('Calculated final gas parameters', {
            txId: tx.id,
            finalMaxFeePerGas: finalMaxFeePerGas?.toString() || 'undefined',
            finalMaxPriorityFeePerGas: finalMaxPriorityFeePerGas?.toString() || 'undefined',
            configuredMaxFeePerGas: configuredMaxFeePerGas?.toString() || 'undefined',
            configuredMaxPriorityFeePerGas: configuredMaxPriorityFeePerGas?.toString() || 'undefined',
          });
        } catch (error) {
          this.logger.error('Failed to get fee data', {
            error: error instanceof Error ? error.message : String(error),
          });
          this.errorLogger.error(
            error instanceof Error ? error : new Error(`Failed to get fee data: ${String(error)}`),
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
          const simulationResult = await simulateTransaction(
            tx,
            depositIds,
            signerAddress,
            finalThreshold,
            calculatedGasLimit,
            this.lstContract,
            this.simulationService,
            this.logger,
          );

          if (!simulationResult.success) {
            // If simulation explicitly failed (not due to service error), reject the transaction
            this.logger.error('Transaction simulation explicitly failed, removing from queue', {
              txId: tx.id,
              error: simulationResult.error,
            });
            this.errorLogger.error(
              new TransactionValidationError(`Transaction simulation failed: ${simulationResult.error}`, {
                depositIds: depositIds.map(String),
              }),
              {
                stage: 'executeTransaction_simulation',
                txId: tx.id,
                error: simulationResult.error,
              },
            );

            // Update transaction status to failed
            tx.status = TransactionStatus.FAILED;
            tx.error = new Error(`Simulation failed: ${simulationResult.error}`);
            this.queue.set(tx.id, tx);

            // Cleanup the queue item
            await cleanupQueueItems(tx, '', this.db, this.logger, this.errorLogger);

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
              optimizedLimit: simulationResult.optimizedGasLimit?.toString() || 'N/A',
            });

            // If optimized gas limit is available and higher than our calculated limit, use it
            if (simulationResult.optimizedGasLimit && simulationResult.optimizedGasLimit > calculatedGasLimit) {
              simulationGasLimit = simulationResult.optimizedGasLimit;
            } else if (simulationResult.gasEstimate) {
              // Otherwise use the gas estimate with buffer
              simulationGasLimit = simulationResult.gasEstimate;
            }
          }
        } catch (simError) {
          // If simulation fails with an exception, log but continue with original gas parameters
          this.logger.warn('Transaction simulation error, continuing with standard parameters', {
            error: simError instanceof Error ? simError.message : String(simError),
            txId: tx.id,
          });
          this.errorLogger.warn(
            simError instanceof Error ? simError : new Error(`Simulation error: ${String(simError)}`),
            {
              stage: 'executeTransaction_simulationError',
              txId: tx.id,
            },
          );

          // Instead of continuing, treat simulation errors as a failure
          this.logger.error('Treating simulation error as a failure, removing from queue', {
            txId: tx.id,
            error: simError instanceof Error ? simError.message : String(simError),
          });

          // Update transaction status to failed
          tx.status = TransactionStatus.FAILED;
          tx.error = new Error(`Simulation error: ${simError instanceof Error ? simError.message : String(simError)}`);
          this.queue.set(tx.id, tx);

          // Cleanup the queue item
          await cleanupQueueItems(tx, '', this.db, this.logger, this.errorLogger);

          // Remove from queue and exit
          this.queue.delete(tx.id);
          return;
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

        // Save transaction details before execution
        if (this.db) {
          try {
            // Get network information
            const chainId = await this.lstContract.runner?.provider
              ?.getNetwork()
              .then((network) => network.chainId.toString())
              .catch(() => 'unknown');

            // Create transaction details record
            const txDetails: Omit<TransactionDetails, 'id' | 'created_at' | 'updated_at'> = {
              transaction_id: tx.id,
              status: TransactionDetailsStatus.PENDING,
              deposit_ids: tx.depositIds.map(String),
              recipient_address: signerAddress,
              min_expected_reward: finalThreshold.toString(),
              payout_amount: payoutAmount.toString(),
              profit_margin_amount: profitMarginAmount.toString(),
              gas_cost_estimate: gasCost.toString(),
              gas_limit: finalSimulatedGasLimit.toString(),
              expected_profit: tx.profitability.estimates.expected_profit.toString(),
              contract_address: this.lstContract.target.toString(),
              network_id: chainId || '1', // Default to mainnet if unknown
              tx_queue_item_id: queueItemId,
              start_time: txStartTime.toISOString(),
              max_fee_per_gas: (this.config.gasPolicy?.maxFeePerGas || maxFeePerGas)?.toString(),
              max_priority_fee_per_gas: (this.config.gasPolicy?.maxPriorityFeePerGas || maxPriorityFeePerGas)?.toString(),
              reward_token_price_usd: undefined,
              eth_price_usd: undefined,
            };

            const savedDetails = await this.db.createTransactionDetails(txDetails);
            transactionDetailsId = savedDetails.id;

            this.logger.info('Created transaction details record', {
              txId: tx.id,
              transactionDetailsId: transactionDetailsId,
            });
          } catch (dbError) {
            // Log but continue with transaction execution
            this.logger.error('Failed to create transaction details record', {
              error: dbError instanceof Error ? dbError.message : String(dbError),
              txId: tx.id,
            });
            this.errorLogger.error(
              dbError instanceof Error ? dbError : new Error(`Failed to create transaction details: ${String(dbError)}`),
              {
                stage: 'executeTransaction_saveTxDetails',
                txId: tx.id,
              },
            );
          }
        }

        // Execute via contract with signer with increased gas parameters
        this.logger.info('Attempting claimAndDistributeReward with params:', {
          recipient: signerAddress,
          minExpectedReward: finalThreshold.toString(),
          depositIds: depositIds.map(String),
          gasLimit: finalSimulatedGasLimit.toString(),
          maxFeePerGas: (
            this.config.gasPolicy?.maxFeePerGas || maxFeePerGas
          )?.toString(),
          maxPriorityFeePerGas: (
            this.config.gasPolicy?.maxPriorityFeePerGas || maxPriorityFeePerGas
          )?.toString(),
          contractAddress: this.lstContract.target.toString(),
          payoutAmount: payoutAmount.toString(),
          profitMarginAmount: profitMarginAmount.toString(),
          gasCost: gasCost.toString(),
        });

        let response = await this.lstContract
          .claimAndDistributeReward(signerAddress, finalThreshold, depositIds, {
            gasLimit: finalSimulatedGasLimit,
            maxFeePerGas,
            maxPriorityFeePerGas,
            isPrivate: this.config.isPrivate,
            privateMode: this.config.isPrivate ? 'flashbots-fast' : undefined,
            // Always use fast mode for Flashbots if private transactions are enabled
            flashbots: this.config.isPrivate ? 'fast' : undefined,
            validForSeconds: 900,
            validUntil: new Date(Date.now() + 1000 * 60 * 15).toISOString(),
          } as DefenderTransactionRequest)
          .catch(async (error: Error) => {
            // Enhanced error handling for Defender 400 errors
            const defenderError = error as DefenderError;
            const isDefender400Error =
              defenderError.message?.includes('status code 400') ||
              defenderError.response?.status === 400;

            if (isDefender400Error) {
              // Get current network state for diagnostics
              const [networkGasPrice, blockNumber, balance] = await Promise.all([
                this.relayProvider.getFeeData(),
                this.relayProvider.getBlockNumber(),
                this.relayProvider.getBalance(signerAddress),
              ]).catch((e) => {
                this.logger.error('Failed to get network diagnostics:', {
                  error: e,
                });
                this.errorLogger.error(
                  e instanceof Error ? e : new Error(`Failed to get network diagnostics: ${String(e)}`),
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
                  maxFeePerGas: maxFeePerGas?.toString(),
                  maxPriorityFeePerGas: maxPriorityFeePerGas?.toString(),
                },
                networkState: {
                  currentBlock: blockNumber,
                  balance: balance?.toString(),
                  networkGasPrice: {
                    maxFeePerGas: networkGasPrice?.maxFeePerGas?.toString(),
                    maxPriorityFeePerGas: networkGasPrice?.maxPriorityFeePerGas?.toString(),
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
              this.errorLogger.error(new Error(`Defender Relayer 400 Error: ${defenderError.message}`), {
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
                }),
              });

              // Check specific conditions that might cause 400 errors
              if (balance) {
                const balanceBigInt = BigInt(balance.toString());
                if (balanceBigInt < this.config.minBalance) {
                  const insufficientBalanceError = new InsufficientBalanceError(balanceBigInt, this.config.minBalance);
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
                const estimatedGas = await this.lstContract.runner?.provider?.estimateGas({
                  to: this.lstContract.target,
                  data: this.lstContract.interface.encodeFunctionData('claimAndDistributeReward', [
                    signerAddress,
                    finalThreshold,
                    depositIds,
                  ]),
                  maxFeePerGas: maxFeePerGas,
                  maxPriorityFeePerGas: maxPriorityFeePerGas,
                }).catch((estimateError: GasEstimationError) => {
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
                    this.logger.info('Increasing gas limit based on estimation', {
                      originalGasLimit: finalSimulatedGasLimit.toString(),
                      estimatedGas: estimatedGasBigInt.toString(),
                      newGasLimit: newGasLimit.toString(),
                    });
                    simulationGasLimit = newGasLimit;
                  }
                }
              } catch (gasError) {
                this.logger.error('Gas estimation error:', {
                  error: gasError instanceof Error ? gasError.message : String(gasError),
                  transaction: {
                    recipient: signerAddress,
                    minExpectedReward: finalThreshold.toString(),
                    depositIds: depositIds.map(String),
                  },
                });
                this.errorLogger.error(
                  gasError instanceof Error ? gasError : new Error(`Gas estimation error: ${String(gasError)}`),
                  {
                    stage: 'executeTransaction_gasError',
                    txId: tx.id,
                    recipient: signerAddress,
                    depositIds: depositIds.map(String).join(','),
                  },
                );
              }

              if (networkGasPrice?.maxFeePerGas && maxFeePerGas) {
                const networkMaxFee = BigInt(networkGasPrice.maxFeePerGas.toString());
                if (networkMaxFee > maxFeePerGas) {
                  // If network gas price exceeds our configured max, use a 25% buffer on network price
                  maxFeePerGas = (networkMaxFee * 125n) / 100n;
                  this.logger.info('Adjusting maxFeePerGas to current network conditions', {
                    networkFee: networkMaxFee.toString(),
                    adjustedFee: maxFeePerGas.toString(),
                  });
                }
              }

              // Check if the error response contains specific Defender error codes
              const defenderErrorData = defenderError.response?.data?.error;
              if (defenderErrorData) {
                switch (defenderErrorData.code) {
                  case 'NONCE_TOO_LOW': {
                    const nonceError = new ExecutorError('Nonce too low - transaction would be replaced', {
                      suggestedNonce: defenderErrorData.suggestedNonce,
                    }, true);
                    this.errorLogger.error(nonceError, {
                      stage: 'executeTransaction_nonceTooLow',
                      txId: tx.id,
                      suggestedNonce: defenderErrorData.suggestedNonce,
                    });
                    throw nonceError;
                  }
                  case 'INSUFFICIENT_FUNDS': {
                    const fundsError = new InsufficientBalanceError(BigInt(balance?.toString() || '0'), this.config.minBalance);
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
                      const suggestedGasLimit = BigInt(String(defenderErrorData.suggestedGasLimit));
                      const newGasLimit = (suggestedGasLimit * 125n) / 100n; // Add 25% buffer

                      this.logger.info('Adjusting gas limit based on suggested value', {
                        suggestedGasLimit: suggestedGasLimit.toString(),
                        newGasLimit: newGasLimit.toString(),
                      });

                      // Retry with new gas limit
                      return this.lstContract.claimAndDistributeReward(signerAddress, finalThreshold, depositIds, {
                        gasLimit: newGasLimit,
                        maxFeePerGas,
                        maxPriorityFeePerGas,
                        isPrivate: this.config.isPrivate,
                      } as DefenderTransactionRequest);
                    }

                    const gasLimitError = new ExecutorError('Gas limit too low for complex transaction', {
                      providedGasLimit: finalSimulatedGasLimit.toString(),
                      suggestedGasLimit: defenderErrorData.suggestedGasLimit,
                    }, true);
                    this.errorLogger.error(gasLimitError, {
                      stage: 'executeTransaction_gasLimitTooLow',
                      txId: tx.id,
                      providedGasLimit: finalSimulatedGasLimit.toString(),
                      suggestedGasLimit: defenderErrorData.suggestedGasLimit,
                    });
                    throw gasLimitError;
                  }
                  default: {
                    const defaultError = new ExecutorError(`Defender API Error: ${defenderErrorData.message}`, {
                      code: defenderErrorData.code,
                      details: defenderErrorData,
                    }, false);
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
                this.logger.error('Gas limit too low for reentrancy protection', {
                  error: errorMessage,
                  currentGasLimit: finalSimulatedGasLimit.toString(),
                });

                // Double the gas limit and retry
                const newGasLimit = finalSimulatedGasLimit * 2n;
                this.logger.info('Doubling gas limit for reentrancy protection', {
                  originalGasLimit: finalSimulatedGasLimit.toString(),
                  newGasLimit: newGasLimit.toString(),
                });

                // Retry with doubled gas limit
                return this.lstContract.claimAndDistributeReward(signerAddress, finalThreshold, depositIds, {
                  gasLimit: newGasLimit,
                  maxFeePerGas,
                  maxPriorityFeePerGas,
                  isPrivate: this.config.isPrivate,
                } as DefenderTransactionRequest);
              }
            }

            // If not a 400 error or no specific error code, throw the original error
            this.errorLogger.error(
              error instanceof Error ? error : new Error(`Transaction submission error: ${String(error)}`),
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

        // Initialize receipt variable
        let receipt: EthersTransactionReceipt | null = null;

        // NEW: Check Flashbots simulation status and handle replacement if needed
        try {
          const { isIncluded, replacementHash } = await handleFlashbotsSimulationAndReplacement(
            response.hash,
            this.defenderClient,
            rewardTokenAddress,
            CONFIG.govlst.address,
            this.logger,
          );

          if (!isIncluded) {
            if (replacementHash) {
              this.logger.info('Original transaction was cancelled and replaced:', {
                originalHash: response.hash,
                replacementHash,
              });
              
              // Instead of modifying response, we'll track the replacement hash separately
              const replacementResponse = await this.defenderClient?.relaySigner.getTransaction(replacementHash);
              if (replacementResponse) {
                // Update our tracking with the replacement transaction details
                this.pendingTransactions.set(tx.id, {
                  id: tx.id,
                  transactionId: replacementHash,
                  hash: replacementHash,
                  submittedAt: Date.now(),
                  lastChecked: Date.now(),
                  retryCount: 0,
                  gasLimit: BigInt(replacementResponse.gasLimit || 0),
                  maxFeePerGas: BigInt(replacementResponse.maxFeePerGas || 0),
                  maxPriorityFeePerGas: BigInt(replacementResponse.maxPriorityFeePerGas || 0),
                  status: 'submitted',
                });

                // Wait for the replacement transaction receipt
                receipt = await pollForReceipt(replacementHash, this.relayProvider as unknown as ethers.Provider, this.logger, 3);
                
                // Update response hash for logging purposes
                this.logger.info('Using replacement transaction for further processing:', {
                  originalHash: response.hash,
                  replacementHash,
                  status: receipt?.status,
                });
              }
            } else {
              this.logger.error('Transaction was not included and replacement failed:', {
                hash: response.hash,
              });
              throw new Error('Transaction was not included and replacement failed');
            }
          } else {
            // Original transaction was included, proceed with normal tracking
            this.pendingTransactions.set(tx.id, {
              id: tx.id,
              transactionId: response.hash,
              hash: response.hash,
              submittedAt: Date.now(),
              lastChecked: Date.now(),
              retryCount: 0,
              gasLimit: finalSimulatedGasLimit,
              maxFeePerGas: maxFeePerGas || 0n,
              maxPriorityFeePerGas: maxPriorityFeePerGas || 0n,
              status: 'submitted',
            });
          }
        } catch (flashbotsError) {
          this.logger.error('Error checking Flashbots simulation status:', {
            error: flashbotsError instanceof Error ? flashbotsError.message : String(flashbotsError),
            hash: response.hash,
          });
          // Continue with normal flow - we'll rely on standard confirmation mechanisms
          this.pendingTransactions.set(tx.id, {
            id: tx.id,
            transactionId: response.hash,
            hash: response.hash,
            submittedAt: Date.now(),
            lastChecked: Date.now(),
            retryCount: 0,
            gasLimit: finalSimulatedGasLimit,
            maxFeePerGas: maxFeePerGas || 0n,
            maxPriorityFeePerGas: maxPriorityFeePerGas || 0n,
            status: 'submitted',
          });
        }

        // Update transaction details with transaction hash and status
        if (this.db && transactionDetailsId) {
          try {
            await this.db.updateTransactionDetails(transactionDetailsId, {
              transaction_hash: response.hash,
              status: TransactionDetailsStatus.SUBMITTED,
              gas_price: response.gasPrice?.toString(),
              max_fee_per_gas: response.maxFeePerGas?.toString(),
              max_priority_fee_per_gas: response.maxPriorityFeePerGas?.toString(),
            });

            this.logger.info('Updated transaction details with hash', {
              txId: tx.id,
              transactionDetailsId,
              hash: response.hash,
            });
          } catch (dbError) {
            // Log but continue with transaction execution
            this.logger.error('Failed to update transaction details with hash', {
              error: dbError instanceof Error ? dbError.message : String(dbError),
              txId: tx.id,
              hash: response.hash,
            });
          }
        }

        // Wait for transaction to be mined
        this.logger.info('Waiting for transaction...');
        try {
          let receipt;
          try {
            receipt = await pollForReceipt(response.hash, this.relayProvider as unknown as ethers.Provider, this.logger, 3);
            this.logger.info(`Transaction receipt received: ${response.hash}`, {
              txId: tx.id,
              blockNumber: receipt?.blockNumber?.toString() || 'unknown',
              status: receipt?.status?.toString() || 'unknown',
            });

            // Update transaction details with receipt information
            if (this.db && transactionDetailsId && receipt) {
              try {
                // Calculate actual profit
                let actualProfit: bigint | undefined;
                try {
                  // Actual profit = payout - gas cost
                  const gasUsed = BigInt(receipt.gasUsed.toString());
                  const effectiveGasPrice = receipt.effectiveGasPrice
                    ? BigInt(receipt.effectiveGasPrice.toString())
                    : response.gasPrice
                      ? BigInt(response.gasPrice.toString())
                      : 0n;

                  // Calculate gas cost in ETH
                  const gasCostEth = gasUsed * effectiveGasPrice;

                  // For now, actual profit is just expected profit (we don't have a way to get actual reward amount)
                  // This could be refined if we parse event logs for the actual reward amount
                  actualProfit = tx.profitability.estimates.expected_profit;

                  // Calculate transaction duration
                  const txEndTime = new Date();
                  const durationMs = txEndTime.getTime() - txStartTime.getTime();

                  await this.db.updateTransactionDetails(transactionDetailsId, {
                    status: TransactionDetailsStatus.CONFIRMED,
                    gas_used: gasUsed.toString(),
                    gas_price: effectiveGasPrice.toString(),
                    gas_cost_eth: gasCostEth.toString(),
                    actual_profit: actualProfit.toString(),
                    end_time: txEndTime.toISOString(),
                    duration_ms: durationMs,
                  });

                  this.logger.info('Updated transaction details with receipt information', {
                    txId: tx.id,
                    transactionDetailsId,
                    gasUsed: gasUsed.toString(),
                    gasPrice: effectiveGasPrice.toString(),
                    actualProfit: actualProfit.toString(),
                    durationMs,
                  });
                } catch (calcError) {
                  this.logger.error('Error calculating actual profit', {
                    error: calcError instanceof Error ? calcError.message : String(calcError),
                    txId: tx.id,
                  });

                  // Still update with available information
                  await this.db.updateTransactionDetails(transactionDetailsId, {
                    status: TransactionDetailsStatus.CONFIRMED,
                    gas_used: receipt.gasUsed.toString(),
                    end_time: new Date().toISOString(),
                  });
                }
              } catch (dbError) {
                this.logger.error('Failed to update transaction details with receipt', {
                  error: dbError instanceof Error ? dbError.message : String(dbError),
                  txId: tx.id,
                  hash: response.hash,
                });
              }
            }
          } catch (confirmError: unknown) {
            // If polling fails, just log the error
            this.logger.warn('Transaction confirmation failed', {
              error: confirmError instanceof Error ? confirmError.message : String(confirmError),
              hash: response.hash,
              errorType:
                typeof confirmError === 'object' && confirmError !== null
                  ? confirmError.constructor?.name || 'Unknown'
                  : typeof confirmError,
            });

            this.logger.info('Continuing execution despite confirmation error - transaction may still have succeeded');

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
          await processTransactionReceipt(tx, response, receipt, this.logger, this.errorLogger, async (txArg, txHashArg) => {
            await cleanupQueueItems(txArg, txHashArg, this.db, this.logger, this.errorLogger);

            // Remove from pending transactions tracking
            if (txArg && txArg.id) {
              this.pendingTransactions.delete(txArg.id);
              this.logger.info('Removed from pending transactions tracking', {
                txId: txArg.id,
                hash: txHashArg,
              });
            }

            // Check if we need to swap tokens for ETH after transaction
            await checkAndSwapTokensIfNeeded(this.lstContract, this.relaySigner as unknown as Signer, this.relayProvider as unknown as Provider, this.logger, this.errorLogger);
          });
        } catch (waitError) {
          this.logger.error('Failed waiting for transaction confirmation', {
            error: waitError instanceof Error ? waitError.message : String(waitError),
            transactionId: tx.id,
            depositIds: depositIds.map(String),
          });
          this.errorLogger.error(
            waitError instanceof Error ? waitError : new Error(`Failed waiting for transaction confirmation: ${String(waitError)}`),
            {
              stage: 'executeTransaction_waitError',
              txId: tx.id,
              hash: response.hash,
              depositIds: depositIds.map(String).join(','),
            },
          );
          throw new ExecutorError('Failed waiting for transaction confirmation', {
            error: waitError instanceof Error ? waitError.message : String(waitError),
          }, false);
        }
      } catch (error) {
        await handleExecutionError(tx, error, this.logger, this.errorLogger, this.queue, async (txArg, txHashArg) => {
          await cleanupQueueItems(txArg, txHashArg, this.db, this.logger, this.errorLogger);

          // Remove from pending transactions tracking
          if (txArg && txArg.id) {
            this.pendingTransactions.delete(txArg.id);
            this.logger.info('Removed from pending transactions tracking after error', {
              txId: txArg.id,
              errorMessage: error instanceof Error ? error.message : String(error),
            });
          }

          // Update transaction details with error information
          if (this.db && transactionDetailsId) {
            try {
              const txEndTime = new Date();
              const durationMs = txEndTime.getTime() - txStartTime.getTime();

              await this.db.updateTransactionDetails(transactionDetailsId, {
                status: TransactionDetailsStatus.FAILED,
                error: error instanceof Error ? error.message : String(error),
                end_time: txEndTime.toISOString(),
                duration_ms: durationMs,
              });

              this.logger.info('Updated transaction details with error information', {
                txId: tx.id,
                transactionDetailsId,
                error: error instanceof Error ? error.message : String(error),
              });
            } catch (dbError) {
              this.logger.error('Failed to update transaction details with error', {
                error: dbError instanceof Error ? dbError.message : String(dbError),
                txId: tx.id,
              });
            }
          }

          // Check token swap needs even after error
          await checkAndSwapTokensIfNeeded(this.lstContract, this.relaySigner as unknown as Signer, this.relayProvider as unknown as Provider, this.logger, this.errorLogger);
        });
      }
    } catch (error) {
      await handleExecutionError(tx, error, this.logger, this.errorLogger, this.queue, async (txArg, txHashArg) => {
        await cleanupQueueItems(txArg, txHashArg, this.db, this.logger, this.errorLogger);

        // Remove from pending transactions tracking
        if (txArg && txArg.id) {
          this.pendingTransactions.delete(txArg.id);
          this.logger.info('Removed from pending transactions tracking after error', {
            txId: txArg.id,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }

        // Update transaction details with error information for outer error
        if (this.db && transactionDetailsId) {
          try {
            const txEndTime = new Date();
            const durationMs = txEndTime.getTime() - txStartTime.getTime();

            await this.db.updateTransactionDetails(transactionDetailsId, {
              status: TransactionDetailsStatus.FAILED,
              error: error instanceof Error ? error.message : String(error),
              end_time: txEndTime.toISOString(),
              duration_ms: durationMs,
            });

            this.logger.info('Updated transaction details with error information (outer error)', {
              txId: tx.id,
              transactionDetailsId,
              error: error instanceof Error ? error.message : String(error),
            });
          } catch (dbError) {
            this.logger.error('Failed to update transaction details with error', {
              error: dbError instanceof Error ? dbError.message : String(dbError),
              txId: tx.id,
            });
          }
        }
      });
    }
  }
}
