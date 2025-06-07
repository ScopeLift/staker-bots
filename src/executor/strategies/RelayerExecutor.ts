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
  TransactionValidationError,
} from '@/configuration/errors';
import { CONFIG } from '@/configuration';
import { ErrorLogger, createErrorLogger } from '@/configuration/errorLogger';
import { RELAYER_QUEUE } from './constants';
import {
  cleanupQueueItems,
  handleExecutionError,
  queueTransactionWithValidation,
  validateRelayerTransaction,
  transferOutTips,
  processTransactionReceipt,
  processQueue,
} from './helpers/helpers';
import {
  pollForReceipt,
  calculateGasLimit,
  calculateQueueStats,
} from '@/configuration/helpers';
import {
  simulateTransaction,
  estimateGasUsingSimulation,
} from './helpers/simulation-helpers';
import {
  handlePendingRelayerTransactions,
  cleanupStaleTransactions as cleanupStaleDefenderTransactions,
} from './helpers/defender-helpers';
import { checkAndSwapTokensIfNeeded } from './helpers/token-swap-helpers';
import { Defender } from '@openzeppelin/defender-sdk';
import { GasCostEstimator } from '@/prices/GasCostEstimator';
import { SimulationService } from '@/simulation';
import { handleStartupCleanup } from './helpers/defender-helpers';

const AUTH_ERROR_MESSAGES = [
  'Request failed with status code 403',
  'User is not authorized to access this resource',
  'Forbidden',
];

const isAuthError = (error: unknown): boolean => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return AUTH_ERROR_MESSAGES.some((msg) => errorMessage.includes(msg));
};

// Add these constants at the top with other constants
const MAX_AUTH_RETRIES = 3;
const AUTH_RETRY_DELAY = 5000; // 5 seconds

// Replace the withAuthErrorHandling function
async function withAuthErrorHandling<T>(
  operation: () => Promise<T>,
  logger: Logger,
  context: string,
  retryCount = 0,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isAuthError(error)) {
      logger.info('Defender authentication error', {
        context,
        retryCount,
        error: error instanceof Error ? error.message : String(error),
      });

      // If we haven't exceeded max retries, wait and try again
      if (retryCount < MAX_AUTH_RETRIES) {
        const delayMs = AUTH_RETRY_DELAY * Math.pow(2, retryCount);
        logger.info(`Retrying operation in ${delayMs}ms...`, {
          context,
          retryAttempt: retryCount + 1,
        });

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return withAuthErrorHandling(
          operation,
          logger,
          context,
          retryCount + 1,
        );
      } else {
        // Log and throw to trigger PM2 restart
        logger.error(
          'Max auth retries exceeded - crashing service for PM2 restart',
          {
            context,
            maxRetries: MAX_AUTH_RETRIES,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        throw error;
      }
    } else {
      logger.error(`Error in ${context}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export class RelayerExecutor implements IExecutor {
  protected readonly logger: Logger;
  private errorLogger: ErrorLogger;
  protected readonly queue: Map<string, QueuedTransaction>;
  protected readonly relayProvider: DefenderRelayProvider;
  protected readonly relaySigner: DefenderRelaySigner;
  protected isRunning: boolean;
  protected processingInterval: NodeJS.Timeout | null;
  protected readonly config: RelayerExecutorConfig;
  protected lstContract: ethers.Contract & {
    claimAndDistributeReward(
      _recipient: string,
      _minExpectedReward: bigint,
      _depositIds: bigint[],
      options?: ethers.Overrides,
    ): Promise<ethers.ContractTransactionResponse>;
    payoutAmount(): Promise<bigint>;
  };
  protected readonly stakerContract: ethers.Contract & {
    balanceOf(account: string): Promise<bigint>;
    deposits(
      depositId: bigint,
    ): Promise<[string, bigint, bigint, string, string]>;
    unclaimedReward(depositId: bigint): Promise<bigint>;
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

  constructor(
    lstContract: ethers.Contract,
    stakerContract: ethers.Contract,
    provider: ethers.Provider,
    config: RelayerExecutorConfig,
  ) {
    // Validate config first
    if (!config) {
      const error = new ExecutorError('Config is required', {}, false);
      throw error;
    }

    // Initialize config with defaults
    this.config = {
      ...config,
      maxQueueSize: config.maxQueueSize ?? 100,
    };

    // Initialize class properties
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

    try {
      // Initialize Defender Relay Provider and Signer
      this.relayProvider = new DefenderRelayProvider({
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
      });
      this.relaySigner = new DefenderRelaySigner(
        {
          apiKey: config.apiKey,
          apiSecret: config.apiSecret,
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

      // Initialize staker contract with signer
      this.stakerContract = new ethers.Contract(
        stakerContract.target as string,
        stakerContract.interface,
        this.relaySigner as unknown as ethers.Signer,
      ) as typeof this.stakerContract;

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
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
      });
    } catch (error) {
      const executorError = new ExecutorError(
        'Failed to initialize Defender SDK',
        {
          error: error instanceof Error ? error.message : String(error),
        },
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

    this.defenderClient = new Defender({
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
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
          const payoutAmount =
            profitability.estimates.payout_amount || BigInt(0);

          // Use a minimal expected reward for estimation
          const simulatedGas = await estimateGasUsingSimulation(
            depositIds,
            signerAddress,
            payoutAmount,
            this.lstContract,
            this.simulationService,
            this.logger,
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
              errorType: error instanceof Error ? error.constructor.name : typeof error,
            },
          );
          
          // For certain types of simulation errors during low gas periods, add extra buffer
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (errorMessage.includes('gas') || errorMessage.includes('simulation')) {
            this.logger.info('Adding extra gas buffer due to simulation issues', {
              originalEstimate: profitability.estimates.gas_estimate.toString(),
              bufferMultiplier: 1.5,
            });
            
            // Add 50% buffer to original estimate when simulation fails during potential low-gas periods
            profitability.estimates.gas_estimate = 
              (profitability.estimates.gas_estimate * 150n) / 100n;
          }
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
      const pendingHandled = await withAuthErrorHandling(
        () =>
          handlePendingRelayerTransactions(
            this.defenderClient,
            this.logger,
            CONFIG.govlst.address,
          ),
        this.logger,
        'handlePendingRelayerTransactions',
      );

      if (pendingHandled) {
        this.logger.info(
          'Exiting executeTransaction early – pending transactions were replaced',
        );
        return;
      }
    } catch (checkErr) {
      this.logger.error(
        'Failed to inspect/replace pending transactions (continuing execution)',
        {
          error:
            checkErr instanceof Error ? checkErr.message : String(checkErr),
        },
      );
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

      try {
        const hasRewardToken =
          typeof this.lstContract.REWARD_TOKEN !== 'undefined';
        if (!hasRewardToken) {
          const error = new ExecutorError(
            'LST contract missing REWARD_TOKEN property or method',
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
      } catch (error) {
        const execError = new ExecutorError(
          'Failed to access REWARD_TOKEN on LST contract',
          {
            error: error instanceof Error ? error.message : String(error),
          },
          false,
        );
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
      if (tx.tx_data) {
        try {
          const txData = JSON.parse(tx.tx_data);
          queueItemId = txData.queueItemId;
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

      // Get reward token address - first try contract, then fallback to config
      let rewardTokenAddress: string;
      try {
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
      } catch (error) {
        rewardTokenAddress = CONFIG.profitability.rewardTokenAddress;
        if (!rewardTokenAddress) {
          throw new Error(
            'No reward token address available in contract or config',
          );
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
          {
            error: error instanceof Error ? error.message : String(error),
          },
          false,
        );
      }

      // Get the payout amount from contract before executing claim
      let payoutAmount: bigint = BigInt(0);
      try {
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

        payoutAmount = rawPayoutAmount;
        this.logger.info('Converted payout amount:', {
          value: payoutAmount.toString(),
          type: typeof payoutAmount,
        });

        // Calculate gas limit with extra buffer for complex operations based on depositIds count
        const depositIds = tx.depositIds;
        const gasEstimate = tx.profitability.estimates.gas_estimate;

        // Use sensible gas limit based on deposit count
        const baseGasLimit =
          gasEstimate < 300000n ? 1200000n : gasEstimate * 2n;
        const calculatedGasLimit = calculateGasLimit(
          baseGasLimit,
          depositIds.length,
          this.logger,
        );

        // Get the pre-calculated minExpectedReward threshold from profitability module
        let finalThreshold: bigint;

        if (tx.profitability.estimates.minExpectedReward) {
          finalThreshold = tx.profitability.estimates.minExpectedReward;
          this.logger.info('Using pre-calculated minimum expected reward', {
            minExpectedReward: finalThreshold.toString(),
            depositCount: depositIds.length,
          });
        } else {
          // Fallback to a safe value if minExpectedReward is missing (should never happen)
          this.logger.error(
            'Missing minExpectedReward from profitability - using safe fallback',
            {
              depositCount: depositIds.length,
            },
          );
          // Use payout + 20% as a safe fallback
          finalThreshold = payoutAmount + (payoutAmount * 20n) / 100n;
        }

        // Get network gas parameters
        const { maxFeePerGas, maxPriorityFeePerGas } =
          await this.getGasParameters();

        // Get signer address for reward recipient
        const signerAddress = await this.relaySigner.getAddress();

        // Run simulation to validate transaction will succeed
        try {
          let receipt: EthersTransactionReceipt | null = null;

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

          // Handle simulation failure - don't proceed with transaction
          if (!simulationResult.success) {
            this.logger.error(
              'Transaction simulation failed, removing from queue',
              {
                txId: tx.id,
                error: simulationResult.error,
              },
            );

            // Update transaction status and clean up
            tx.status = TransactionStatus.FAILED;
            tx.error = new Error(
              `Simulation failed: ${simulationResult.error}`,
            );
            this.queue.set(tx.id, tx);
            await cleanupQueueItems(
              tx,
              '',
              this.db,
              this.logger,
              this.errorLogger,
            );
            this.queue.delete(tx.id);
            return;
          }

          // Use simulation gas estimate if available
          const finalGasLimit =
            simulationResult.optimizedGasLimit ||
            simulationResult.gasEstimate ||
            calculatedGasLimit;

          // Create database record for the transaction
          const transactionDetailsId = await this.saveTransactionDetails(
            tx,
            signerAddress,
            finalThreshold,
            payoutAmount,
            finalGasLimit,
            maxFeePerGas,
            maxPriorityFeePerGas,
            txStartTime,
          );

          // Execute the transaction
          this.logger.info(
            'Submitting transaction after successful simulation',
            {
              recipient: signerAddress,
              minExpectedReward: finalThreshold.toString(),
              depositCount: depositIds.length,
              gasLimit: finalGasLimit.toString(),
            },
          );

          // Submit transaction to chain
          const response = await this.submitTransaction(
            signerAddress,
            finalThreshold,
            depositIds,
            finalGasLimit,
            maxFeePerGas,
            maxPriorityFeePerGas,
          );

          // Track the pending transaction
          this.pendingTransactions.set(tx.id, {
            id: tx.id,
            transactionId: response.hash,
            hash: response.hash,
            submittedAt: Date.now(),
            lastChecked: Date.now(),
            retryCount: 0,
            gasLimit: finalGasLimit,
            maxFeePerGas: maxFeePerGas || 0n,
            maxPriorityFeePerGas: maxPriorityFeePerGas || 0n,
            status: 'submitted',
          });

          // Wait for transaction to be mined
          try {
            receipt = await pollForReceipt(
              response.hash,
              this.relayProvider as unknown as ethers.Provider,
              this.logger,
              3,
            );
            this.logger.info(`Transaction confirmed: ${response.hash}`, {
              txId: tx.id,
              blockNumber: receipt?.blockNumber?.toString() || 'unknown',
              status: receipt?.status?.toString() || 'unknown',
            });

            // Update transaction details with receipt
            if (this.db && transactionDetailsId && receipt) {
              await this.updateTransactionDetailsWithReceipt(
                transactionDetailsId,
                receipt,
                tx,
                txStartTime,
              );
            }
          } catch (waitError) {
            this.logger.warn(
              'Failed to get receipt, transaction may still succeed',
              {
                error:
                  waitError instanceof Error
                    ? waitError.message
                    : String(waitError),
                hash: response.hash,
              },
            );
          }

          // Process receipt and clean up
          await processTransactionReceipt(
            tx,
            response,
            receipt,
            this.logger,
            this.errorLogger,
            async (txArg, txHashArg) => {
              await cleanupQueueItems(
                txArg,
                txHashArg,
                this.db,
                this.logger,
                this.errorLogger,
              );
              this.pendingTransactions.delete(txArg.id);

              // Check if we need to swap tokens after transaction
              await checkAndSwapTokensIfNeeded(
                this.lstContract,
                this.relaySigner as unknown as Signer,
                this.relayProvider as unknown as Provider,
                this.logger,
                this.errorLogger,
              );
            },
          );
        } catch (error) {
          await handleExecutionError(
            tx,
            error,
            this.logger,
            this.errorLogger,
            this.queue,
            async (txArg, txHashArg) => {
              await cleanupQueueItems(
                txArg,
                txHashArg,
                this.db,
                this.logger,
                this.errorLogger,
              );
              if (txArg && txArg.id) {
                this.pendingTransactions.delete(txArg.id);
              }
            },
          );
        }
      } catch (error) {
        await handleExecutionError(
          tx,
          error,
          this.logger,
          this.errorLogger,
          this.queue,
          async (txArg, txHashArg) => {
            await cleanupQueueItems(
              txArg,
              txHashArg,
              this.db,
              this.logger,
              this.errorLogger,
            );
            if (txArg && txArg.id) {
              this.pendingTransactions.delete(txArg.id);
            }
          },
        );
      }
    } catch (error) {
      await handleExecutionError(
        tx,
        error,
        this.logger,
        this.errorLogger,
        this.queue,
        async (txArg, txHashArg) => {
          await cleanupQueueItems(
            txArg,
            txHashArg,
            this.db,
            this.logger,
            this.errorLogger,
          );
          if (txArg && txArg.id) {
            this.pendingTransactions.delete(txArg.id);
          }
        },
      );
    }
  }

  /**
   * Gets gas parameters from the network or configuration
   */
  private async getGasParameters(): Promise<{
    maxFeePerGas: bigint | undefined;
    maxPriorityFeePerGas: bigint | undefined;
  }> {
    try {
      // Get fee data from provider
      const feeData = await this.relayProvider.getFeeData();
      let maxFeePerGas = feeData.maxFeePerGas
        ? BigInt(feeData.maxFeePerGas.toString())
        : undefined;
      let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
        ? BigInt(feeData.maxPriorityFeePerGas.toString())
        : undefined;

      // Apply slight boost to gas values for reliable inclusion
      if (maxFeePerGas) {
        maxFeePerGas = (maxFeePerGas * 125n) / 100n;
        
        // Ensure minimum gas price for Flashbots stability
        const MIN_GAS_PRICE_WEI = 1000000000n; // 1 gwei
        if (maxFeePerGas < MIN_GAS_PRICE_WEI) {
          this.logger.warn('Max fee per gas is very low, using minimum threshold', {
            actualGasPriceGwei: Number(maxFeePerGas) / 1e9,
            minGasPriceGwei: 1,
            usingMinimum: true,
          });
          maxFeePerGas = MIN_GAS_PRICE_WEI;
        }
      }

      if (maxPriorityFeePerGas) {
        maxPriorityFeePerGas = (maxPriorityFeePerGas * 125n) / 100n;
        
        // Ensure minimum priority fee
        const MIN_PRIORITY_FEE_WEI = 100000000n; // 0.1 gwei minimum priority fee
        if (maxPriorityFeePerGas < MIN_PRIORITY_FEE_WEI) {
          this.logger.warn('Max priority fee per gas is very low, using minimum threshold', {
            actualPriorityFeeGwei: Number(maxPriorityFeePerGas) / 1e9,
            minPriorityFeeGwei: 0.1,
            usingMinimum: true,
          });
          maxPriorityFeePerGas = MIN_PRIORITY_FEE_WEI;
        }
      }

      // Use the higher of network fee data or configured values
      const configuredMaxFeePerGas = this.config.gasPolicy?.maxFeePerGas;
      const configuredMaxPriorityFeePerGas =
        this.config.gasPolicy?.maxPriorityFeePerGas;

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

      this.logger.info('Gas parameters calculated', {
        maxFeePerGas: finalMaxFeePerGas?.toString() || 'undefined',
        maxPriorityFeePerGas:
          finalMaxPriorityFeePerGas?.toString() || 'undefined',
      });

      return {
        maxFeePerGas: finalMaxFeePerGas,
        maxPriorityFeePerGas: finalMaxPriorityFeePerGas,
      };
    } catch (error) {
      this.logger.error('Failed to get gas parameters', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Return undefined values, transaction will use network defaults
      return { maxFeePerGas: undefined, maxPriorityFeePerGas: undefined };
    }
  }

  /**
   * Saves transaction details to database
   */
  private async saveTransactionDetails(
    tx: QueuedTransaction,
    recipient: string,
    minExpectedReward: bigint,
    payoutAmount: bigint,
    gasLimit: bigint,
    maxFeePerGas: bigint | undefined,
    maxPriorityFeePerGas: bigint | undefined,
    startTime: Date,
  ): Promise<string | undefined> {
    if (!this.db) return undefined;

    try {
      // Get chain ID
      const chainId = await this.lstContract.runner?.provider
        ?.getNetwork()
        .then((network) => network.chainId.toString())
        .catch(() => 'unknown');

      // Get queue item ID
      const queueItemId = tx.metadata?.queueItemId;

      // Create transaction details
      const txDetails: Omit<
        TransactionDetails,
        'id' | 'created_at' | 'updated_at'
      > = {
        transaction_id: tx.id,
        status: TransactionDetailsStatus.PENDING,
        deposit_ids: tx.depositIds.map(String),
        recipient_address: recipient,
        min_expected_reward: minExpectedReward.toString(),
        payout_amount: payoutAmount.toString(),
        profit_margin_amount: (minExpectedReward - payoutAmount).toString(),
        gas_cost_estimate: tx.profitability.estimates.gas_cost.toString(),
        gas_limit: gasLimit.toString(),
        expected_profit: tx.profitability.estimates.expected_profit.toString(),
        contract_address: this.lstContract.target.toString(),
        network_id: chainId || '1',
        tx_queue_item_id: queueItemId,
        start_time: startTime.toISOString(),
        max_fee_per_gas: maxFeePerGas?.toString(),
        max_priority_fee_per_gas: maxPriorityFeePerGas?.toString(),
        reward_token_price_usd: undefined,
        eth_price_usd: undefined,
      };

      const savedDetails = await this.db.createTransactionDetails(txDetails);
      this.logger.info('Transaction details saved', { id: savedDetails.id });
      return savedDetails.id;
    } catch (error) {
      this.logger.error('Failed to save transaction details', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Updates transaction details with receipt information
   */
  private async updateTransactionDetailsWithReceipt(
    transactionDetailsId: string,
    receipt: EthersTransactionReceipt,
    tx: QueuedTransaction,
    startTime: Date,
  ): Promise<void> {
    if (!this.db) return;

    try {
      // Calculate gas costs and duration
      const gasUsed = BigInt(receipt.gasUsed.toString());
      const effectiveGasPrice = receipt.effectiveGasPrice
        ? BigInt(receipt.effectiveGasPrice.toString())
        : 0n;
      const gasCostEth = gasUsed * effectiveGasPrice;
      const txEndTime = new Date();
      const durationMs = txEndTime.getTime() - startTime.getTime();

      // Update transaction details
      await this.db.updateTransactionDetails(transactionDetailsId, {
        status: TransactionDetailsStatus.CONFIRMED,
        gas_used: gasUsed.toString(),
        gas_price: effectiveGasPrice.toString(),
        gas_cost_eth: gasCostEth.toString(),
        actual_profit: tx.profitability.estimates.expected_profit.toString(),
        end_time: txEndTime.toISOString(),
        duration_ms: durationMs,
      });

      this.logger.info('Transaction details updated with receipt', {
        id: transactionDetailsId,
        gasUsed: gasUsed.toString(),
        durationMs: durationMs.toString(),
      });
    } catch (error) {
      this.logger.error('Failed to update transaction details with receipt', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Submits transaction to the blockchain
   */
  private async submitTransaction(
    recipient: string,
    minExpectedReward: bigint,
    depositIds: bigint[],
    gasLimit: bigint,
    maxFeePerGas: bigint | undefined,
    maxPriorityFeePerGas: bigint | undefined,
  ): Promise<ethers.ContractTransactionResponse> {
    return withAuthErrorHandling(
      async () => {
        this.logger.info('Submitting transaction', {
          recipient,
          minExpectedReward: minExpectedReward.toString(),
          depositIds: depositIds.length,
          gasLimit: gasLimit.toString(),
        });

        const txOptions = {
          gasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas,
          isPrivate: this.config.isPrivate,
          privateMode: this.config.isPrivate ? 'flashbots-fast' : undefined,
          flashbots: this.config.isPrivate ? 'fast' : undefined,
          validForSeconds: 900,
          validUntil: new Date(Date.now() + 1000 * 60 * 15).toISOString(),
        } as DefenderTransactionRequest;

        return await this.lstContract.claimAndDistributeReward(
          recipient,
          minExpectedReward,
          depositIds,
          txOptions,
        );
      },
      this.logger,
      'submitTransaction',
    );
  }
}
