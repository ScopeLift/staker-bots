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
// Import Defender SDK correctly
import {
  DefenderRelaySigner,
  DefenderRelayProvider,
} from '@openzeppelin/defender-relay-client/lib/ethers';
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

export class RelayerExecutor implements IExecutor {
  protected readonly logger: Logger;
  protected readonly queue: Map<string, QueuedTransaction>;
  protected readonly relayProvider: DefenderRelayProvider;
  protected readonly relaySigner: DefenderRelaySigner;
  protected isRunning: boolean;
  protected processingInterval: NodeJS.Timeout | null;
  protected govLstContract: ethers.Contract;

  constructor(
    govLstContract: ethers.Contract,
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

    try {
      // Create Defender Relay Provider and Signer
      this.relayProvider = new DefenderRelayProvider(this.config.relayer);

      this.relaySigner = new DefenderRelaySigner(
        this.config.relayer,
        this.relayProvider,
        { speed: 'fast' },
      );
    } catch (error) {
      this.logger.error('Failed to initialize Defender SDK:', { error });
      throw new Error(
        'Failed to initialize Defender SDK. Make sure it is installed correctly.',
      );
    }

    // Create a new contract instance with the relay signer
    this.govLstContract = new ethers.Contract(
      govLstContract.target as string,
      govLstContract.interface.fragments,
      this.relaySigner as unknown as ethers.ContractRunner,
    );

    // Validate GovLst contract
    if (!this.govLstContract.interface.hasFunction('claimAndDistributeReward')) {
      throw new ContractMethodError('claimAndDistributeReward');
    }
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
    const balance = await this.relayProvider.getBalance(await this.relaySigner.getAddress());
    const pendingTxs = Array.from(this.queue.values()).filter(
      (tx) => tx.status === TransactionStatus.PENDING,
    ).length;

    return {
      isRunning: this.isRunning,
      walletBalance: BigInt(balance.toString()),
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
      throw new QueueOperationError(
        'queue',
        new Error('Queue is full'),
        { maxSize: this.config.maxQueueSize }
      );
    }

    if (depositIds.length > QUEUE_CONSTANTS.MAX_BATCH_SIZE) {
      throw new TransactionValidationError(
        `Batch size exceeds maximum of ${QUEUE_CONSTANTS.MAX_BATCH_SIZE}`,
        { depositIds: depositIds.map(String) }
      );
    }

    if (depositIds.length < QUEUE_CONSTANTS.MIN_BATCH_SIZE) {
      throw new TransactionValidationError(
        `Batch size below minimum of ${QUEUE_CONSTANTS.MIN_BATCH_SIZE}`,
        { depositIds: depositIds.map(String) }
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
    const confirmed = transactions.filter((tx) => tx.status === TransactionStatus.CONFIRMED);
    const failed = transactions.filter((tx) => tx.status === TransactionStatus.FAILED);
    const pending = transactions.filter((tx) => tx.status === TransactionStatus.PENDING);
    const queued = transactions.filter((tx) => tx.status === TransactionStatus.QUEUED);

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
      averageGasPrice: confirmed.length ? totalGasPrice / BigInt(confirmed.length) : 0n,
      averageGasLimit: confirmed.length ? totalGasLimit / BigInt(confirmed.length) : 0n,
      totalProfits,
    };
  }

  async getTransaction(id: string): Promise<QueuedTransaction | null> {
    return this.queue.get(id) || null;
  }

  async getTransactionReceipt(hash: string): Promise<TransactionReceipt | null> {
    const receipt = await this.relayProvider.getTransactionReceipt(hash) as unknown as EthersTransactionReceipt | null
    if (!receipt) return null

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
    }
  }

  async transferOutTips(): Promise<TransactionReceipt | null> {
    if (!this.config.defaultTipReceiver)
      throw new TransactionValidationError('No tip receiver configured', {
        config: this.config
      });

    const balance = await this.relayProvider.getBalance(await this.relaySigner.getAddress())
    const balanceBigInt = BigInt(balance.toString())
    if (balanceBigInt < this.config.transferOutThreshold)
      return null

    const tx = await this.relaySigner.sendTransaction({
      to: this.config.defaultTipReceiver,
      value: balanceBigInt - this.config.relayer.minBalance,
    })

    const receipt = await tx.wait(this.config.minConfirmations) as unknown as EthersTransactionReceipt | null
    if (!receipt) return null

    this.logger.info(EXECUTOR_EVENTS.TIPS_TRANSFERRED, {
      amount: ethers.formatEther(balanceBigInt - this.config.relayer.minBalance),
      receiver: this.config.defaultTipReceiver,
      hash: tx.hash,
    })

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

  protected async processQueue(isPeriodicCheck: boolean = false): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      const balance = await this.relayProvider.getBalance(await this.relaySigner.getAddress());
      const balanceBigInt = BigInt(balance.toString());
      if (balanceBigInt < this.config.relayer.minBalance) {
        this.logger.warn('Relayer balance too low', {
          balance: ethers.formatEther(balanceBigInt),
          minimum: ethers.formatEther(this.config.relayer.minBalance),
        });
        return;
      }

      const pendingTxs = Array.from(this.queue.values()).filter(
        (tx) => tx.status === TransactionStatus.PENDING,
      );
      if (pendingTxs.length >= this.config.relayer.maxPendingTransactions) {
        return;
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
      const executorError = new Error('Error processing queue') as GovLstExecutorError;
      executorError.context = { error: error instanceof Error ? error.message : String(error) };
      this.logger.error(EXECUTOR_EVENTS.ERROR, { ...executorError, ...executorError.context });
    }
  }

  protected async executeTransaction(tx: QueuedTransaction): Promise<void> {
    try {
      tx.status = TransactionStatus.PENDING
      this.queue.set(tx.id, tx)

      this.logger.info(EXECUTOR_EVENTS.TRANSACTION_STARTED, {
        id: tx.id,
        depositCount: tx.depositIds.length,
        totalShares: tx.profitability.estimates.total_shares.toString(),
      })

      // Get transaction parameters
      const minExpectedReward = tx.profitability.estimates.expected_profit
      const depositIds = tx.depositIds

      // First estimate gas for the transaction
      let gasEstimate: bigint
      try {
        if (!this.govLstContract.claimAndDistributeReward)
          throw new ContractMethodError('claimAndDistributeReward')

        const estimate = await this.govLstContract.claimAndDistributeReward.estimateGas(
          await this.relaySigner.getAddress(),
          minExpectedReward,
          depositIds,
        )
        gasEstimate = BigInt(estimate.toString())
      } catch (error) {
        throw new GasEstimationError(
          error instanceof Error ? error : new Error(String(error)),
          {
            minExpectedReward: minExpectedReward.toString(),
            depositIds: depositIds.map(String),
          }
        )
      }

      // Apply gas limit buffer and constraints
      const gasLimit = BigInt(Math.ceil(Number(gasEstimate) * GAS_CONSTANTS.GAS_LIMIT_BUFFER))
      const finalGasLimit = gasLimit < GAS_CONSTANTS.MIN_GAS_LIMIT
        ? GAS_CONSTANTS.MIN_GAS_LIMIT
        : gasLimit > GAS_CONSTANTS.MAX_GAS_LIMIT
        ? GAS_CONSTANTS.MAX_GAS_LIMIT
        : gasLimit

      // Use custom gas settings if provided
      const txOptions: ethers.Overrides = {
        gasLimit: finalGasLimit,
      }

      if (this.config.relayer.gasPolicy?.maxFeePerGas)
        txOptions.maxFeePerGas = this.config.relayer.gasPolicy.maxFeePerGas

      if (this.config.relayer.gasPolicy?.maxPriorityFeePerGas)
        txOptions.maxPriorityFeePerGas = this.config.relayer.gasPolicy.maxPriorityFeePerGas

      // Execute the transaction
      if (!this.govLstContract.claimAndDistributeReward)
        throw new ContractMethodError('claimAndDistributeReward')

      const txResponse = await this.govLstContract.claimAndDistributeReward(
        await this.relaySigner.getAddress(),
        minExpectedReward,
        depositIds,
        txOptions,
      )

      // Wait for confirmations
      const receipt = await txResponse.wait(this.config.minConfirmations) as unknown as EthersTransactionReceipt | null
      if (!receipt) throw new TransactionReceiptError(txResponse.hash, {
        transactionId: tx.id,
        depositIds: tx.depositIds.map(String),
      })

      // Update transaction status
      tx.status = receipt.status === 1 ? TransactionStatus.CONFIRMED : TransactionStatus.FAILED
      tx.hash = receipt.transactionHash
      tx.gasPrice = receipt.effectiveGasPrice
      tx.gasLimit = BigInt(receipt.gasUsed.toString())
      tx.executedAt = new Date()

      if (receipt.status !== 1) {
        this.logger.error(EXECUTOR_EVENTS.TRANSACTION_FAILED, {
          id: tx.id,
          hash: receipt.transactionHash,
        })
      } else {
        this.logger.info(EXECUTOR_EVENTS.TRANSACTION_CONFIRMED, {
          id: tx.id,
          hash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          gasPrice: receipt.effectiveGasPrice.toString(),
        })
      }

      this.queue.set(tx.id, tx)
    } catch (error) {
      tx.status = TransactionStatus.FAILED
      tx.error = error as Error
      this.queue.set(tx.id, tx)

      const executorError = new Error('Transaction execution failed') as GovLstExecutorError
      executorError.context = {
        id: tx.id,
        depositIds: tx.depositIds.map(String),
        error: error instanceof Error ? error.message : String(error),
      }
      this.logger.error(EXECUTOR_EVENTS.ERROR, { ...executorError, ...executorError.context })
    }
  }
}
