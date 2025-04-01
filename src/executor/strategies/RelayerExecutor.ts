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
// Update Defender SDK imports for v2
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
} from '../errors';
import { ProcessingQueueStatus } from '@/database/interfaces/types';

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
      this.lstContract = lstContract.connect(
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

    if (depositIds.length > QUEUE_CONSTANTS.MAX_BATCH_SIZE) {
      throw new TransactionValidationError(
        `Batch size exceeds maximum of ${QUEUE_CONSTANTS.MAX_BATCH_SIZE}`,
        { depositIds: depositIds.map(String) },
      );
    }

    if (depositIds.length < QUEUE_CONSTANTS.MIN_BATCH_SIZE) {
      throw new TransactionValidationError(
        `Batch size below minimum of ${QUEUE_CONSTANTS.MIN_BATCH_SIZE}`,
        { depositIds: depositIds.map(String) },
      );
    }

    // Get current gas price and calculate gas cost
    const feeData = await this.relayProvider.getFeeData();
    if (!feeData.maxFeePerGas) {
      throw new Error('Failed to get gas price from provider');
    }
    const estimatedGasCost = BigInt(feeData.maxFeePerGas.toString()) * profitability.estimates.gas_estimate;

    // Get payout amount from contract
    if (!this.lstContract || typeof this.lstContract.payoutAmount !== 'function') {
      throw new Error('Contract not properly initialized or missing payoutAmount method');
    }
    const payoutAmount = await this.lstContract.payoutAmount();

    // Validate that expected reward is sufficient
    if (profitability.estimates.expected_profit < (payoutAmount + estimatedGasCost)) {
      throw new TransactionValidationError(
        'Expected reward is less than payout amount plus gas cost',
        {
          expectedReward: profitability.estimates.expected_profit.toString(),
          payoutAmount: payoutAmount.toString(),
          estimatedGasCost: estimatedGasCost.toString(),
          depositIds: depositIds.map(String),
        },
      );
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
      gasPrice: receipt.effectiveGasPrice,
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

    const receipt = (await tx.wait(
      this.config.minConfirmations,
    )) as unknown as EthersTransactionReceipt;
    if (!receipt) {
      throw new TransactionReceiptError(tx.hash, {
        error: 'Failed to get transaction receipt',
      });
    }

    this.logger.info(EXECUTOR_EVENTS.TIPS_TRANSFERRED, {
      amount: ethers.formatEther(balanceBigInt - this.config.minBalance),
      receiver: this.config.defaultTipReceiver,
      hash: tx.hash,
    });

    return {
      hash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      gasUsed: BigInt(receipt.gasUsed.toString()),
      gasPrice: receipt.effectiveGasPrice,
      status: receipt.status,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: Array.from(log.topics),
        data: log.data,
      })),
    };
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
        const allowance = await rewardTokenContract.allowance(
          signerAddress,
          lstContractAddress,
        );

        // Verify LST contract has required methods
        if (
          !this.lstContract.payoutAmount ||
          !this.lstContract.maxOverrideTip
        ) {
          throw new ExecutorError(
            'LST contract missing required methods',
            {},
            false,
          );
        }

        // Get payout amount and max tip from contract
        const payoutAmount = await this.lstContract.payoutAmount();
        const maxTip = await this.lstContract.maxOverrideTip();
        const approvalAmount = payoutAmount + maxTip;

        // If allowance is too low, approve exact amount needed
        if (allowance < approvalAmount) {
          this.logger.info('Approving reward token spend', {
            token: rewardTokenAddress,
            spender: lstContractAddress,
            amount: approvalAmount.toString(),
          });

          const approveTx = await rewardTokenContract.approve(
            lstContractAddress,
            approvalAmount,
          );

          // Wait for the transaction to be mined with the required confirmations
          const receipt = await approveTx.wait(this.config.minConfirmations);
          if (!receipt || receipt.status === 0) {
            throw new ExecutorError(
              'Approval transaction failed',
              { receipt },
              false,
            );
          }
        }
      } catch (error) {
        throw new ExecutorError(
          'Failed to approve reward token spend',
          { error: error instanceof Error ? error.message : String(error) },
          false,
        );
      }

      const minExpectedReward = tx.profitability.estimates.expected_profit;
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

      // Execute via contract with signer
      const response = await this.lstContract.claimAndDistributeReward(
        signerAddress,
        minExpectedReward,
        depositIds,
        {
          gasLimit: this.calculateGasLimit(
            tx.profitability.estimates.gas_estimate,
          ),
          maxFeePerGas: this.config.gasPolicy?.maxFeePerGas || maxFeePerGas,
          maxPriorityFeePerGas:
            this.config.gasPolicy?.maxPriorityFeePerGas || maxPriorityFeePerGas,
        },
      );

      // Wait for transaction receipt
      let receipt: EthersTransactionReceipt | null = null;
      let attempts = 0;
      const maxAttempts = 30; // 30 attempts * 1 second = 30 seconds max wait

      while (!receipt && attempts < maxAttempts) {
        receipt = (await this.relayProvider.getTransactionReceipt(
          response.hash,
        )) as unknown as EthersTransactionReceipt;
        if (!receipt) {
          await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
          attempts++;
          continue;
        }

        // Check if we have enough confirmations
        const currentBlock = await this.relayProvider.getBlockNumber();
        const confirmations = currentBlock - receipt.blockNumber;
        if (confirmations < this.config.minConfirmations) {
          receipt = null;
          await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
          attempts++;
          continue;
        }
      }

      if (!receipt) {
        throw new TransactionReceiptError(response.hash, {
          transactionId: tx.id,
          depositIds: depositIds.map(String),
        });
      }

      // Update transaction status
      tx.status =
        receipt.status === 1
          ? TransactionStatus.CONFIRMED
          : TransactionStatus.FAILED;
      tx.hash = receipt.transactionHash;
      tx.gasPrice = receipt.effectiveGasPrice;
      tx.gasLimit = receipt.gasUsed;
      tx.executedAt = new Date();

      // Update database if available
      if (this.db && queueItemId) {
        try {
          // Get transaction queue item to find deposit IDs
          const txQueueItem = await this.db.getTransactionQueueItem(queueItemId);
          if (txQueueItem) {
            // Parse deposit IDs from the transaction queue item
            const depositIds = txQueueItem.deposit_id.split(',');

            // Update transaction queue status and clear processing queue items
            await Promise.all([
              // Update transaction queue status
              this.db.updateTransactionQueueItem(queueItemId, {
                status: receipt.status === 1
                  ? TransactionQueueStatus.CONFIRMED
                  : TransactionQueueStatus.FAILED,
                hash: receipt.transactionHash,
                error: receipt.status !== 1 ? 'Transaction failed' : undefined,
                gas_price: receipt.effectiveGasPrice.toString(),
              }),
              // If transaction succeeded, delete transaction queue item and update processing queue items
              ...(receipt.status === 1 ? [
                // Delete transaction queue item
                this.db.deleteTransactionQueueItem(queueItemId),
                // Update and delete processing queue items for each deposit
                ...depositIds.map(async (depositId) => {
                  const processingItem = await this.db!.getProcessingQueueItemByDepositId(depositId);
                  if (processingItem) {
                    // First update status to completed
                    await this.db!.updateProcessingQueueItem(processingItem.id, {
                      status: ProcessingQueueStatus.COMPLETED,
                    });
                    // Then delete the item
                    await this.db!.deleteProcessingQueueItem(processingItem.id);
                  }
                }),
              ] : []),
            ]);
          }
        } catch (error) {
          this.logger.error('Failed to update queue items', {
            error: error instanceof Error ? error.message : String(error),
            queueItemId,
            status: receipt.status === 1 ? 'confirmed' : 'failed',
          });
        }
      }

      this.queue.set(tx.id, tx);

      if (receipt.status !== 1) {
        this.logger.error(EXECUTOR_EVENTS.TRANSACTION_FAILED, {
          id: tx.id,
          hash: receipt.transactionHash,
        });
      } else {
        this.logger.info(EXECUTOR_EVENTS.TRANSACTION_CONFIRMED, {
          id: tx.id,
          hash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          gasPrice: receipt.effectiveGasPrice.toString(),
        });
      }
    } catch (error) {
      await this.handleExecutionError(tx, error);
    }
  }

  // Add helper for gas limit calculation
  private calculateGasLimit(gasEstimate: bigint): bigint {
    const gasLimit = BigInt(
      Math.ceil(Number(gasEstimate) * GAS_CONSTANTS.GAS_LIMIT_BUFFER),
    );
    return gasLimit < GAS_CONSTANTS.MIN_GAS_LIMIT
      ? GAS_CONSTANTS.MIN_GAS_LIMIT
      : gasLimit > GAS_CONSTANTS.MAX_GAS_LIMIT
        ? GAS_CONSTANTS.MAX_GAS_LIMIT
        : gasLimit;
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
      } catch (dbError) {
        this.logger.error('Failed to update database after transaction error', {
          error: dbError instanceof Error ? dbError.message : String(dbError),
          originalError: error instanceof Error ? error.message : String(error),
          queueItemId,
        });
      }
    }
  }

  // ... rest of existing methods with provider access through lstContract.runner?.provider ...
}
