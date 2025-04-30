import { ethers } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { IExecutor } from '../interfaces/IExecutor';
import {
  RelayerExecutorConfig,
  QueuedTransaction,
  TransactionStatus,
  QueueStats,
  TransactionReceipt,
} from '../interfaces/types';
import { ProfitabilityCheck } from '@/profitability/interfaces/types';
import { v4 as uuidv4 } from 'uuid';
// Import Defender SDK correctly
import {
  DefenderRelaySigner,
  DefenderRelayProvider,
} from '@openzeppelin/defender-relay-client/lib/ethers';

export class RelayerExecutor implements IExecutor {
  protected readonly logger: Logger;
  protected readonly queue: Map<string, QueuedTransaction>;
  protected readonly relayProvider: DefenderRelayProvider;
  protected readonly relaySigner: DefenderRelaySigner;
  protected isRunning: boolean;
  protected processingInterval: NodeJS.Timeout | null;
  protected relayerContract: ethers.Contract;

  constructor(
    protected readonly stakerContract: ethers.Contract,
    protected readonly provider: ethers.Provider,
    protected readonly config: RelayerExecutorConfig,
  ) {
    this.logger = new ConsoleLogger('info');
    this.queue = new Map();
    this.isRunning = false;
    this.processingInterval = null;

    if (!provider) {
      throw new Error('Provider is required');
    }

    try {
      // Create Defender Relay Provider and Signer
      this.relayProvider = new DefenderRelayProvider({
        apiKey: this.config.relayer.apiKey,
        apiSecret: this.config.relayer.apiSecret,
      });

      this.relaySigner = new DefenderRelaySigner(
        {
          apiKey: this.config.relayer.apiKey,
          apiSecret: this.config.relayer.apiSecret,
        },
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
    this.relayerContract = new ethers.Contract(
      typeof stakerContract.address === 'string' ? stakerContract.address : '',
      stakerContract.interface,
      this.relaySigner as unknown as ethers.Signer,
    );

    // Validate staker contract
    if (!this.relayerContract.interface.hasFunction('bumpEarningPower')) {
      throw new Error(
        'Invalid staker contract: missing bumpEarningPower function',
      );
    }
  }

  protected async getRelayerBalance(): Promise<bigint> {
    try {
      const address = await this.relaySigner.getAddress();
      const balance = await this.relayProvider.getBalance(address);
      // Convert the result which might be BigNumber to bigint
      return balance ? BigInt(balance.toString()) : BigInt(0);
    } catch (error) {
      this.logger.error('Error getting relayer balance:', { error });
      return BigInt(0);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.logger.info('RelayerExecutor started');

    // Start processing queue periodically as a backup
    this.processingInterval = setInterval(
      () => this.processQueue(true),
      5000, // Process queue every 5 seconds as a backup
    );
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    this.logger.info('RelayerExecutor stopped');
  }

  async getStatus(): Promise<{
    isRunning: boolean;
    walletBalance: bigint;
    pendingTransactions: number;
    queueSize: number;
  }> {
    const balance = await this.getRelayerBalance();
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
    depositId: bigint,
    profitability: ProfitabilityCheck,
  ): Promise<QueuedTransaction> {
    // Check queue size
    if (this.queue.size >= this.config.maxQueueSize) {
      throw new Error('Queue is full');
    }

    // Create transaction object
    const tx: QueuedTransaction = {
      id: uuidv4(),
      depositId,
      profitability,
      status: TransactionStatus.QUEUED,
      createdAt: new Date(),
    };

    // Add to queue
    this.queue.set(tx.id, tx);
    this.logger.info('Transaction queued for relay:', {
      id: tx.id,
      depositId: tx.depositId.toString(),
    });

    // Process queue immediately if running
    if (this.isRunning) {
      // Use setImmediate to avoid blocking the current call stack
      setImmediate(() => this.processQueue(false));
    }

    return tx;
  }

  async getQueueStats(): Promise<QueueStats> {
    const txs = Array.from(this.queue.values());
    const confirmedTxs = txs.filter(
      (tx) => tx.status === TransactionStatus.CONFIRMED,
    );

    const totalProfits = confirmedTxs.reduce(
      (sum, tx) => sum + tx.profitability.estimates.expectedProfit,
      BigInt(0),
    );

    const avgGasPrice =
      confirmedTxs.length > 0
        ? confirmedTxs.reduce(
            (sum, tx) => sum + (tx.gasPrice || BigInt(0)),
            BigInt(0),
          ) / BigInt(confirmedTxs.length)
        : BigInt(0);

    const avgExecTime =
      confirmedTxs.length > 0
        ? confirmedTxs.reduce((sum, tx) => {
            const execTime = tx.executedAt
              ? tx.executedAt.getTime() - tx.createdAt.getTime()
              : 0;
            return sum + execTime;
          }, 0) / confirmedTxs.length
        : 0;

    return {
      totalQueued: txs.filter((tx) => tx.status === TransactionStatus.QUEUED)
        .length,
      totalPending: txs.filter((tx) => tx.status === TransactionStatus.PENDING)
        .length,
      totalConfirmed: confirmedTxs.length,
      totalFailed: txs.filter((tx) => tx.status === TransactionStatus.FAILED)
        .length,
      averageExecutionTime: avgExecTime,
      averageGasPrice: avgGasPrice,
      totalProfits,
    };
  }

  async getTransaction(id: string): Promise<QueuedTransaction | null> {
    return this.queue.get(id) || null;
  }

  async getTransactionReceipt(
    hash: string,
  ): Promise<TransactionReceipt | null> {
    const receipt = await this.provider.getTransactionReceipt(hash);
    if (!receipt) {
      return null;
    }

    return {
      hash: receipt.hash,
      status: receipt.status === 1,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice || BigInt(0),
    };
  }

  async transferOutTips(): Promise<TransactionReceipt | null> {
    // OpenZeppelin Relayers manage their own funds, so this implementation
    // is just a stub. In a real implementation, you might want to transfer funds
    // from a contract or use a different approach.
    this.logger.info('Transfer out not needed for OpenZeppelin Relayer');
    return null;
  }

  async clearQueue(): Promise<void> {
    this.queue.clear();
    this.logger.info('Queue cleared');
  }

  protected async processQueue(
    isPeriodicCheck: boolean = false,
  ): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      // Check relayer balance
      const balance = await this.getRelayerBalance();
      if (balance < this.config.relayer.minBalance) {
        this.logger.warn('Relayer balance too low:', {
          balance: ethers.formatEther(balance),
          minimum: ethers.formatEther(this.config.relayer.minBalance),
        });
        return;
      }

      // Get pending transactions count
      const pendingTxs = Array.from(this.queue.values()).filter(
        (tx) => tx.status === TransactionStatus.PENDING,
      );
      if (pendingTxs.length >= this.config.relayer.maxPendingTransactions) {
        return;
      }

      // Get queued transactions
      const queuedTxs = Array.from(this.queue.values())
        .filter((tx) => tx.status === TransactionStatus.QUEUED)
        .slice(0, this.config.concurrentTransactions - pendingTxs.length);

      if (queuedTxs.length === 0) {
        if (!isPeriodicCheck) {
          this.logger.debug('No queued transactions to process');
        }
        return;
      }

      // Process each transaction
      await Promise.all(queuedTxs.map((tx) => this.executeTransaction(tx)));
    } catch (error) {
      this.logger.error('Error processing queue:', { error });
    }
  }

  protected async executeTransaction(tx: QueuedTransaction): Promise<void> {
    try {
      // Update status to pending
      tx.status = TransactionStatus.PENDING;
      this.queue.set(tx.id, tx);

      // Use custom gas settings if provided
      const txOptions: ethers.Overrides = {
        value: tx.profitability.estimates.optimalTip,
      };

      if (this.config.relayer.gasPolicy?.maxFeePerGas) {
        txOptions.maxFeePerGas = this.config.relayer.gasPolicy.maxFeePerGas;
      }

      if (this.config.relayer.gasPolicy?.maxPriorityFeePerGas) {
        txOptions.maxPriorityFeePerGas =
          this.config.relayer.gasPolicy.maxPriorityFeePerGas;
      }

      // Send transaction via OpenZeppelin Relayer
      const bumpFunction = this.relayerContract.bumpEarningPower;
      if (!bumpFunction) {
        throw new Error('bumpEarningPower function not found on contract');
      }

      const response = await bumpFunction(
        tx.depositId,
        tx.profitability.estimates.tipReceiver,
        tx.profitability.estimates.optimalTip,
        txOptions,
      );

      // Update transaction
      tx.hash = response.hash;
      tx.executedAt = new Date();
      this.queue.set(tx.id, tx);

      this.logger.info('Transaction sent via Relayer:', {
        id: tx.id,
        hash: tx.hash,
      });

      // Wait for confirmation
      const receipt = await response.wait(this.config.minConfirmations);
      if (!receipt) {
        throw new Error('Failed to get transaction receipt');
      }

      // Update final status
      tx.status =
        receipt.status === 1
          ? TransactionStatus.CONFIRMED
          : TransactionStatus.FAILED;

      tx.gasPrice = receipt.gasPrice;
      tx.gasLimit = receipt.gasLimit;
      this.queue.set(tx.id, tx);

      this.logger.info('Transaction executed via Relayer:', {
        id: tx.id,
        hash: tx.hash,
        status: tx.status,
      });
    } catch (error) {
      tx.status = TransactionStatus.FAILED;
      tx.error = error as Error;
      this.queue.set(tx.id, tx);
      this.logger.error('Error executing transaction via Relayer:', {
        error,
        id: tx.id,
      });
    }
  }
}
