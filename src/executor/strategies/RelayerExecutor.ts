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
import { EXECUTOR_EVENTS, GAS_CONSTANTS, QUEUE_CONSTANTS } from '../constants';
import { TransactionQueueStatus } from '@/database/interfaces/types';
import {
  ContractMethodError,
  ExecutorError,
  InsufficientBalanceError,
  QueueOperationError,
  TransactionExecutionError,
  TransactionReceiptError,
  TransactionValidationError,
  createExecutorError,
} from '@/configuration/errors';

export class RelayerExecutor implements IExecutor {
  protected readonly logger: Logger;
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

  constructor(
    lstContract: ethers.Contract,
    provider: ethers.Provider,
    protected readonly config: RelayerExecutorConfig,
  ) {
    this.logger = new ConsoleLogger('info');
    this.queue = new Map();
    this.isRunning = false;
    this.processingInterval = null;

    if (!provider) {
      throw new ExecutorError('Provider is required', {}, false);
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
      this.logger.error('Failed to initialize Defender SDK:', { error });
      throw new ExecutorError(
        'Failed to initialize Defender SDK',
        { error: error instanceof Error ? error.message : String(error) },
        false,
      );
    }

    // Validate LST contract
    if (!this.lstContract.interface.hasFunction('claimAndDistributeReward')) {
      throw new ContractMethodError('claimAndDistributeReward');
    }
  }

  // Add setDatabase method
  setDatabase(db: DatabaseWrapper): void {
    this.db = db;
    this.logger.info('Database set for executor');
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.startQueueProcessor();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.stopQueueProcessor();
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
      throw new ExecutorError('Executor is not running', {}, false);
    }

    if (this.queue.size >= this.config.maxQueueSize) {
      throw new QueueOperationError('queue', new Error('Queue is full'), {
        maxSize: this.config.maxQueueSize,
      });
    }

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
    this.logger.info(EXECUTOR_EVENTS.TRANSACTION_QUEUED, {
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
    if (depositIds.length > QUEUE_CONSTANTS.MAX_BATCH_SIZE) {
      return {
        isValid: false,
        error: new TransactionValidationError(
          `Batch size exceeds maximum of ${QUEUE_CONSTANTS.MAX_BATCH_SIZE}`,
          { depositIds: depositIds.map(String) },
        ),
      };
    }

    if (depositIds.length < QUEUE_CONSTANTS.MIN_BATCH_SIZE) {
      return {
        isValid: false,
        error: new TransactionValidationError(
          `Batch size below minimum of ${QUEUE_CONSTANTS.MIN_BATCH_SIZE}`,
          { depositIds: depositIds.map(String) },
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

    // Validate that expected reward is sufficient
    // TODO: WE NEED TO COMPARE GAS PRICE TO TOKEN PRICE TO GET A REAL ESTIMATE OF PROFITABILITY
    if (
      profitability.estimates.expected_profit <
      payoutAmount + estimatedGasCost
    ) {
      return {
        isValid: false,
        error: new TransactionValidationError(
          'Expected reward is less than payout amount plus gas cost',
          {
            expectedReward: profitability.estimates.expected_profit.toString(),
            payoutAmount: payoutAmount.toString(),
            estimatedGasCost: estimatedGasCost.toString(),
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
    const transactions = Array.from(this.queue.values());
    const confirmed = transactions.filter(
      (tx) => tx.status === TransactionStatus.CONFIRMED,
    );
    const failed = transactions.filter(
      (tx) => tx.status === TransactionStatus.FAILED,
    );
    const pending = transactions.filter(
      (tx) => tx.status === TransactionStatus.PENDING,
    );
    const queued = transactions.filter(
      (tx) => tx.status === TransactionStatus.QUEUED,
    );

    const totalGasPrice = confirmed.reduce(
      (sum, tx) => sum + (tx.gasPrice || 0n),
      0n,
    );
    const totalGasLimit = confirmed.reduce(
      (sum, tx) => sum + (tx.gasLimit || 0n),
      0n,
    );
    const totalProfits = confirmed.reduce(
      (sum, tx) => sum + tx.profitability.estimates.expected_profit,
      0n,
    );

    return {
      totalConfirmed: confirmed.length,
      totalFailed: failed.length,
      totalPending: pending.length,
      totalQueued: queued.length,
      averageGasPrice: confirmed.length
        ? totalGasPrice / BigInt(confirmed.length)
        : 0n,
      averageGasLimit: confirmed.length
        ? totalGasLimit / BigInt(confirmed.length)
        : 0n,
      totalProfits,
    };
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

    if (balanceBigInt < this.config.transferOutThreshold) {
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

      this.logger.info(EXECUTOR_EVENTS.TIPS_TRANSFERRED, {
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
      QUEUE_CONSTANTS.QUEUE_PROCESSOR_INTERVAL,
    );
  }

  protected stopQueueProcessor(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
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
        throw new ExecutorError('Relay provider not initialized', {}, false);
      }

      const balance = await this.relayProvider.getBalance(this.config.address);
      const balanceBigInt = BigInt(balance.toString());

      if (balanceBigInt < this.config.minBalance) {
        throw new InsufficientBalanceError(
          balanceBigInt,
          this.config.minBalance,
        );
      }

      const pendingTxs = Array.from(this.queue.values()).filter(
        (tx) => tx.status === TransactionStatus.PENDING,
      );
      if (pendingTxs.length >= this.config.maxPendingTransactions) {
        throw new QueueOperationError(
          'queue',
          new Error('Max pending transactions reached'),
          { maxPending: this.config.maxPendingTransactions },
        );
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
      this.logger.error(EXECUTOR_EVENTS.ERROR, {
        ...executorError,
        ...executorError.context,
      });
    }
  }

  protected async executeTransaction(tx: QueuedTransaction): Promise<void> {
    try {
      if (!this.lstContract) {
        throw new ExecutorError('LST contract not initialized', {}, false);
      }

      if (!this.lstContract.REWARD_TOKEN) {
        throw new ExecutorError(
          'LST contract missing REWARD_TOKEN method',
          {},
          false,
        );
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
        }
      }

      // Update database with pending status first
      if (this.db && queueItemId) {
        try {
          await this.db.updateTransactionQueueItem(queueItemId, {
            status: TransactionQueueStatus.PENDING,
          });
        } catch (error) {
          this.logger.error('Failed to update transaction queue item status', {
            error: error instanceof Error ? error.message : String(error),
            queueItemId,
          });
        }
      }

      // Get reward token and approve if needed
      const rewardTokenAddress = await this.lstContract.REWARD_TOKEN();
      if (!rewardTokenAddress) {
        throw new ExecutorError(
          'Failed to get reward token address',
          {},
          false,
        );
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
        // Check current allowance
        const signerAddress = await this.relaySigner.getAddress();
        const lstContractAddress = this.lstContract.target.toString();

        this.logger.info('Checking token allowance', {
          signerAddress,
          lstContractAddress,
          rewardToken: rewardTokenAddress,
        });

        const allowance = await rewardTokenContract.allowance(
          signerAddress,
          lstContractAddress,
        );

        this.logger.info('Current allowance', {
          allowance: allowance.toString(),
        });

        // Determine approval amount - with fallback for contracts without payoutAmount/maxOverrideTip
        let approvalAmount: bigint;

        try {
          // Try to verify LST contract methods and get values from contract
          if (
            typeof this.lstContract.payoutAmount === 'function' &&
            typeof this.lstContract.maxOverrideTip === 'function'
          ) {
            // Get payout amount and max tip from contract
            const payoutAmount = await this.lstContract.payoutAmount();
            const maxTip = await this.lstContract.maxOverrideTip();
            approvalAmount = payoutAmount;

            this.logger.info('Token approval requirements from contract', {
              payoutAmount: payoutAmount.toString(),
              maxTip: maxTip.toString(),
              totalApprovalNeeded: approvalAmount.toString(),
            });
          } else {
            throw new Error('Contract does not have required methods');
          }
        } catch (methodError) {
          // Fallback: use a large approval amount to ensure coverage
          this.logger.warn('Using fallback approval amount', {
            error:
              methodError instanceof Error
                ? methodError.message
                : String(methodError),
          });

          // Default to a large approval - 100 tokens (assuming 18 decimals)
          approvalAmount = ethers.parseUnits('100', 18);

          this.logger.info('Using fallback approval amount', {
            approvalAmount: approvalAmount.toString(),
            approvalAmountInEth: ethers.formatEther(approvalAmount),
          });
        }

        // If allowance is too low, approve exact amount needed
        if (allowance < approvalAmount) {
          this.logger.info('Approving reward token spend', {
            token: rewardTokenAddress,
            spender: lstContractAddress,
            currentAllowance: allowance.toString(),
            requiredAmount: approvalAmount.toString(),
          });

          const approveTx = await rewardTokenContract.approve(
            lstContractAddress,
            approvalAmount,
          );

          this.logger.info('Approval transaction submitted', {
            hash: approveTx.hash,
            gasLimit: approveTx.gasLimit.toString(),
          });

          // Wait for the transaction to be mined
          try {
            this.logger.info('Waiting for approval transaction...');
            let receipt;
            try {
              receipt = await approveTx.wait(3);
            } catch (confirmError: unknown) {
              // If the standard wait fails, just log the error without attempting to poll
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
              blockNumber: receipt!.blockNumber,
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
        if (typeof this.lstContract.payoutAmount !== 'function')
          throw new ContractMethodError('getPayoutAmount');

        payoutAmount = await this.lstContract.payoutAmount();
      } catch (error) {
        this.logger.error('Failed to get payout amount', {
          error: error instanceof Error ? error.message : String(error),
          depositIds: tx.depositIds.map((id) => id.toString()),
        });
        throw new ContractMethodError('getPayoutAmount');
      }
      // Get the minimum expected reward from the profitability check
      const minExpectedReward = tx.profitability.estimates.expected_profit;
      if (minExpectedReward <= payoutAmount) {
        throw new TransactionValidationError(
          'Expected reward is less than payout amount',
          {
            expectedReward: minExpectedReward.toString(),
            payoutAmount: payoutAmount.toString(),
            depositIds: tx.depositIds.map(String),
          },
        );
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
      } catch (error) {
        this.logger.error('Failed to get fee data', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Get the relayer's address for reward recipient
      const signerAddress = await this.relaySigner.getAddress();

      // Verify the contract has the claimAndDistributeReward method
      if (typeof this.lstContract.claimAndDistributeReward !== 'function') {
        throw new ContractMethodError('claimAndDistributeReward');
      }

      // Log transaction parameters before execution
      this.logger.info('Executing claimAndDistributeReward', {
        recipient: signerAddress,
        minExpectedReward: minExpectedReward.toString(),
        depositIds: depositIds.map((id) => id.toString()),
        gasEstimate: tx.profitability.estimates.gas_estimate.toString(),
      });

      // Calculate gas limit with extra buffer for complex operations
      const gasEstimate = tx.profitability.estimates.gas_estimate;
      const baseGasLimit = gasEstimate < 120000n ? 600000n : gasEstimate; // Use minimum 500k gas if estimate is too low
      const calculatedGasLimit = this.calculateGasLimit(baseGasLimit);

      this.logger.info('Gas limit for transaction', {
        originalEstimate: gasEstimate.toString(),
        baseGasLimit: baseGasLimit.toString(),
        finalGasLimit: calculatedGasLimit.toString(),
      });

      // Execute via contract with signer
      const response = await this.lstContract.claimAndDistributeReward(
        signerAddress,
        minExpectedReward,
        depositIds,
        {
          gasLimit: calculatedGasLimit,
          maxFeePerGas: this.config.gasPolicy?.maxFeePerGas || maxFeePerGas,
          maxPriorityFeePerGas:
            this.config.gasPolicy?.maxPriorityFeePerGas || maxPriorityFeePerGas,
        },
      );

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
          receipt = await this.pollForReceipt(response.hash, 3);
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

        // Only proceed with receipt if we have one
        if (receipt) {
          this.logger.info('Transaction confirmed', {
            hash: response.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
          });

          // Update transaction status
          tx.status = TransactionStatus.CONFIRMED;
          tx.hash = response.hash;
          tx.gasPrice = 0n; // Set default since it may not be available
          tx.gasLimit = BigInt(receipt.gasUsed.toString());
          tx.executedAt = new Date();

          // Clean up queue items
          if (this.db && queueItemId) {
            try {
              const txQueueItem =
                await this.db.getTransactionQueueItem(queueItemId);
              if (txQueueItem) {
                const depositIds = txQueueItem.deposit_id.split(',');

                // Clean up all related queue items in parallel
                await Promise.all([
                  this.db.deleteTransactionQueueItem(queueItemId),
                  ...depositIds.map(async (depositId) => {
                    const processingItem =
                      await this.db!.getProcessingQueueItemByDepositId(
                        depositId,
                      );
                    if (processingItem) {
                      await this.db!.deleteProcessingQueueItem(
                        processingItem.id,
                      );
                    }
                  }),
                ]);

                this.logger.info('Cleaned up queue items:', {
                  txQueueId: queueItemId,
                  depositIds,
                  hash: response.hash,
                });
              }
            } catch (error) {
              this.logger.error('Failed to clean up queue items:', {
                error: error instanceof Error ? error.message : String(error),
                queueItemId,
                hash: response.hash,
              });
            }
          }

          this.queue.set(tx.id, tx);
          this.logger.info(EXECUTOR_EVENTS.TRANSACTION_CONFIRMED, {
            id: tx.id,
            hash: response.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
          });
        } else {
          // No receipt available, but we'll continue with optimistic status
          this.logger.info(
            'No receipt available, setting tentative confirmed status',
            {
              hash: response.hash,
            },
          );

          // Update transaction status with limited information
          tx.status = TransactionStatus.CONFIRMED;
          tx.hash = response.hash;
          tx.executedAt = new Date();
        }
      } catch (waitError) {
        this.logger.error('Failed waiting for transaction confirmation', {
          error:
            waitError instanceof Error ? waitError.message : String(waitError),
          transactionId: tx.id,
          depositIds: depositIds.map(String),
        });
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
  }

  // Add helper for gas limit calculation
  private calculateGasLimit(gasEstimate: bigint): bigint {
    this.logger.info('Calculating gas limit', {
      baseGasEstimate: gasEstimate.toString(),
      buffer: GAS_CONSTANTS.GAS_LIMIT_BUFFER,
      minGasLimit: GAS_CONSTANTS.MIN_GAS_LIMIT.toString(),
      maxGasLimit: GAS_CONSTANTS.MAX_GAS_LIMIT.toString(),
    });

    let gasLimit: bigint;
    try {
      gasLimit = BigInt(
        Math.ceil(Number(gasEstimate) * GAS_CONSTANTS.GAS_LIMIT_BUFFER),
      );
    } catch (error) {
      // If conversion fails, use a safe default
      this.logger.warn('Error calculating gas limit, using safe default', {
        error: error instanceof Error ? error.message : String(error),
        gasEstimate: gasEstimate.toString(),
      });
      gasLimit = GAS_CONSTANTS.MIN_GAS_LIMIT * 2n;
    }

    // Apply bounds
    if (gasLimit < GAS_CONSTANTS.MIN_GAS_LIMIT) {
      this.logger.info('Gas limit below minimum, using minimum value', {
        calculatedLimit: gasLimit.toString(),
        minLimit: GAS_CONSTANTS.MIN_GAS_LIMIT.toString(),
      });
      return GAS_CONSTANTS.MIN_GAS_LIMIT;
    } else if (gasLimit > GAS_CONSTANTS.MAX_GAS_LIMIT) {
      this.logger.info('Gas limit above maximum, using maximum value', {
        calculatedLimit: gasLimit.toString(),
        maxLimit: GAS_CONSTANTS.MAX_GAS_LIMIT.toString(),
      });
      return GAS_CONSTANTS.MAX_GAS_LIMIT;
    }

    this.logger.info('Final gas limit calculated', {
      finalGasLimit: gasLimit.toString(),
    });

    return gasLimit;
  }

  // Add custom receipt polling method to handle ethers v5/v6 compatibility
  private async pollForReceipt(
    txHash: string,
    confirmations: number = 1,
  ): Promise<EthersTransactionReceipt | null> {
    if (!this.relayProvider) {
      throw new ExecutorError('Relay provider not initialized', {}, false);
    }

    const maxAttempts = 30; // Try for about 5 minutes with 10-second intervals
    const pollingInterval = 10000; // 10 seconds

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Get receipt
        const receipt = (await this.relayProvider.getTransactionReceipt(
          txHash,
        )) as unknown as EthersTransactionReceipt;

        if (!receipt) {
          // If no receipt yet, wait and try again
          await new Promise((resolve) => setTimeout(resolve, pollingInterval));
          continue;
        }

        // Check if we have enough confirmations
        const currentBlock = await this.relayProvider.getBlockNumber();
        const receiptConfirmations = currentBlock - receipt.blockNumber + 1;

        if (receiptConfirmations >= confirmations) {
          return receipt;
        }

        // Not enough confirmations, wait and try again
        await new Promise((resolve) => setTimeout(resolve, pollingInterval));
      } catch (error) {
        this.logger.warn('Error polling for receipt', {
          error: error instanceof Error ? error.message : String(error),
          txHash,
          attempt,
        });

        // Wait and try again
        await new Promise((resolve) => setTimeout(resolve, pollingInterval));
      }
    }

    throw new Error(
      `Transaction ${txHash} not confirmed after ${maxAttempts} attempts`,
    );
  }

  // Add helper for error handling
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
    this.logger.error(EXECUTOR_EVENTS.ERROR, {
      ...executorError,
      ...executorError.context,
    });

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
      }
    }

    // Update database if available
    if (this.db && queueItemId) {
      try {
        await this.db.updateTransactionQueueItem(queueItemId, {
          status: TransactionQueueStatus.FAILED,
          error: error instanceof Error ? error.message : String(error),
        });

        // Delete from transaction queue
        await this.db.deleteTransactionQueueItem(queueItemId);

        // Also clean up any related processing queue items
        if (tx.tx_data) {
          try {
            const txData = JSON.parse(tx.tx_data);
            if (txData.depositIds) {
              // Process each deposit ID
              for (const depositId of txData.depositIds) {
                const processingItem =
                  await this.db.getProcessingQueueItemByDepositId(
                    depositId.toString(),
                  );
                if (processingItem) {
                  await this.db.deleteProcessingQueueItem(processingItem.id);
                }
              }
            }
          } catch (parseError) {
            this.logger.error('Failed to parse deposit IDs from tx data', {
              error:
                parseError instanceof Error
                  ? parseError.message
                  : String(parseError),
            });
          }
        }

        this.logger.info('Removed failed transaction from queue', {
          queueItemId,
        });
      } catch (dbError) {
        this.logger.error('Failed to update database after transaction error', {
          error: dbError instanceof Error ? dbError.message : String(dbError),
          originalError: error instanceof Error ? error.message : String(error),
          queueItemId,
        });
      }
    }

    // Remove from in-memory queue
    this.queue.delete(tx.id);
  }
}
