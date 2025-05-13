import { ethers } from "ethers";
import { ConsoleLogger, Logger } from "@/monitor/logging";
import { IExecutor } from "../interfaces/IExecutor";
import {
  ExecutorConfig,
  QueuedTransaction,
  TransactionStatus,
  QueueStats,
  TransactionReceipt,
} from "../interfaces/types";
import { ProfitabilityCheck } from "@/profitability/interfaces/types";
import { v4 as uuidv4 } from "uuid";
import { DatabaseWrapper } from "@/database";
import { Interface } from "ethers";
import { TransactionQueueStatus } from "@/database/interfaces/types";
import { SimulationService } from "@/simulation";

/**
 * Base implementation of the executor using a direct wallet.
 * Handles transaction queueing, execution, and monitoring.
 */
export class BaseExecutor implements IExecutor {
  protected readonly logger: Logger;
  protected readonly wallet: ethers.Wallet;
  protected readonly queue: Map<string, QueuedTransaction>;
  protected isRunning: boolean;
  protected processingInterval: NodeJS.Timeout | null;
  protected db?: DatabaseWrapper;
  protected stakerContract: ethers.Contract;
  protected readonly contractAddress: string;
  protected readonly contractInterface: Interface;
  protected readonly provider: ethers.Provider;
  protected readonly config: ExecutorConfig;

  /**
   * Creates a new BaseExecutor instance
   * @param params Constructor parameters
   */
  constructor({
    contractAddress,
    contractInterface,
    provider,
    config,
  }: {
    contractAddress: string;
    contractInterface: Interface;
    provider: ethers.Provider;
    config: ExecutorConfig;
  }) {
    if (!provider) {
      throw new Error("Provider is required");
    }

    this.logger = new ConsoleLogger("info");
    this.wallet = new ethers.Wallet(config.wallet.privateKey, provider);
    this.queue = new Map();
    this.isRunning = false;
    this.processingInterval = null;
    this.contractAddress = contractAddress;
    this.contractInterface = contractInterface;
    this.provider = provider;
    this.config = config;

    // Create contract with wallet directly
    this.stakerContract = new ethers.Contract(
      contractAddress,
      contractInterface,
      this.wallet,
    );

    // Validate staker contract
    if (!this.stakerContract.interface.hasFunction("bumpEarningPower")) {
      throw new Error(
        "Invalid staker contract: missing bumpEarningPower function",
      );
    }
  }

  /**
   * Set the database instance for transaction queue management
   */
  setDatabase(db: DatabaseWrapper): void {
    this.db = db;
    this.logger.info("Database set for executor");
  }

  /**
   * Get the wallet balance
   */
  protected async getWalletBalance(): Promise<bigint> {
    return (await this.provider.getBalance(this.wallet.address)) || BigInt(0);
  }

  /**
   * Start the executor service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.logger.info("Executor started");

    // Start processing queue periodically as a backup
    this.processingInterval = setInterval(
      () => this.processQueue(true),
      5000, // Process queue every 5 seconds as a backup
    );

    // Also check for transactions in the DB transaction queue that need to be executed
    setInterval(() => {
      this.checkDatabaseTransactionQueue().catch((error) => {
        this.logger.error("Error checking database transaction queue:", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 15000); // Check database queue every 15 seconds

    this.logger.info("Queue processing intervals started");
  }

  /**
   * Stop the executor service
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    this.logger.info("Executor stopped");
  }

  /**
   * Get the current status of the executor
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

  /**
   * Queue a transaction for execution
   */
  async queueTransaction(
    depositId: bigint,
    profitability: ProfitabilityCheck,
    txData?: string,
  ): Promise<QueuedTransaction> {
    // Check queue size
    if (this.queue.size >= this.config.maxQueueSize) {
      throw new Error("Queue is full");
    }

    // Create transaction object
    const tx: QueuedTransaction = {
      id: uuidv4(),
      depositId,
      depositIds: [depositId],
      profitability,
      status: TransactionStatus.QUEUED,
      createdAt: new Date(),
      tx_data: txData,
      metadata: {
        queueItemId: undefined
      }
    };

    // Add to queue
    this.queue.set(tx.id, tx);
    this.logger.info("Transaction queued:", {
      id: tx.id,
      depositId: depositId.toString(),
      hasTxData: !!txData,
    });

    // Process queue immediately if running
    if (this.isRunning) {
      // Use setImmediate to avoid blocking the current call stack
      setImmediate(() => this.processQueue(false));
    }

    return tx;
  }

  /**
   * Get statistics about the transaction queue
   */
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
      totalTransactions: txs.length,
      pendingTransactions: txs.filter(tx => tx.status === TransactionStatus.PENDING).length,
      confirmedTransactions: confirmedTxs.length,
      failedTransactions: txs.filter(tx => tx.status === TransactionStatus.FAILED).length,
      totalQueued: txs.filter((tx) => tx.status === TransactionStatus.QUEUED).length,
      totalPending: txs.filter((tx) => tx.status === TransactionStatus.PENDING).length,
      totalConfirmed: confirmedTxs.length,
      totalFailed: txs.filter((tx) => tx.status === TransactionStatus.FAILED).length,
      averageExecutionTime: avgExecTime,
      averageGasPrice: avgGasPrice,
      totalProfits,
    };
  }

  /**
   * Get a specific transaction by ID
   */
  async getTransaction(id: string): Promise<QueuedTransaction | null> {
    return this.queue.get(id) || null;
  }

  /**
   * Get transaction receipt
   */
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
      gasPrice: receipt.gasPrice || BigInt(0),
      logs: receipt.logs.map(log => ({
        address: log.address,
        topics: [...log.topics],
        data: log.data
      }))
    };
  }

  /**
   * Transfer accumulated tips to the configured receiver
   */
  async transferOutTips(): Promise<TransactionReceipt | null> {
    const balance = await this.getWalletBalance();
    if (balance < this.config.transferOutThreshold) {
      return null;
    }

    try {
      // Calculate transfer amount (leave some ETH for gas)
      const feeData = await this.provider.getFeeData();
      const baseGasPrice = feeData.gasPrice || BigInt(0);
      const boostMultiplier =
        BigInt(100 + this.config.gasBoostPercentage) / BigInt(100);
      const gasPrice = baseGasPrice * boostMultiplier;

      // Make sure our gas price is at least equal to the base fee
      const baseFeePerGas = feeData.maxFeePerGas || baseGasPrice;
      const finalGasPrice =
        gasPrice > baseFeePerGas ? gasPrice : baseFeePerGas + BigInt(1_000_000);

      const gasLimit = BigInt(21000); // Standard ETH transfer
      const gasCost = gasLimit * finalGasPrice;
      const transferAmount = balance - gasCost;

      if (transferAmount <= 0) {
        return null;
      }

      // Get tip receiver from config or use default
      const tipReceiver = this.config.defaultTipReceiver || this.wallet.address;

      // Send transaction
      const tx = await this.wallet.sendTransaction({
        to: tipReceiver,
        value: transferAmount,
        gasLimit,
        gasPrice: finalGasPrice,
      });

      this.logger.info("Transferred tips:", {
        hash: tx.hash,
        amount: transferAmount.toString(),
        receiver: tipReceiver,
      });

      const receipt = await tx.wait();
      if (!receipt) {
        return null;
      }

      return {
        hash: receipt.hash,
        status: receipt.status === 1,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.gasPrice || BigInt(0),
        gasPrice: receipt.gasPrice || BigInt(0),
        logs: receipt.logs.map(log => ({
          address: log.address,
          topics: [...log.topics],
          data: log.data
        }))
      };
    } catch (error) {
      this.logger.error("Failed to transfer tips:", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Clear the transaction queue
   */
  async clearQueue(): Promise<void> {
    this.queue.clear();
    this.logger.info("Transaction queue cleared");
  }

  /**
   * Process the transaction queue
   */
  protected async processQueue(
    isPeriodicCheck: boolean = false,
  ): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Only process if there are queued transactions
    const queuedTxs = Array.from(this.queue.values()).filter(
      (tx) => tx.status === TransactionStatus.QUEUED,
    );

    if (queuedTxs.length === 0 && isPeriodicCheck) {
      // If this is just a periodic check and there are no queued txs, return early
      return;
    }

    // Check how many pending transactions we have
    const pendingTxCount = Array.from(this.queue.values()).filter(
      (tx) => tx.status === TransactionStatus.PENDING,
    ).length;

    // If we have too many pending transactions, don't execute more
    if (pendingTxCount >= this.config.wallet.maxPendingTransactions) {
      this.logger.info("Too many pending transactions, skipping execution");
      return;
    }

    // Process up to concurrentTransactions at a time
    const toProcess = queuedTxs.slice(0, this.config.concurrentTransactions);
    for (const tx of toProcess) {
      this.executeTransaction(tx).catch((error) => {
        this.logger.error("Error executing transaction", {
          txId: tx.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  /**
   * Execute a transaction
   */
  protected async executeTransaction(tx: QueuedTransaction): Promise<void> {
    if (!this.isRunning) {
      this.logger.info("Executor not running, skipping transaction");
      return;
    }

    try {
      // Update status to pending
      tx.status = TransactionStatus.PENDING;
      tx.executedAt = new Date();
      this.logger.info("Executing transaction", { id: tx.id });

      // Parse transaction data
      const safeDepositId = tx.depositId || tx.depositIds[0];
      if (!safeDepositId) {
        throw new Error("No deposit ID found in transaction");
      }

      let depositId = safeDepositId;
      let tipReceiver = this.wallet.address;
      let requestedTip = tx.profitability.estimates.optimalTip || BigInt(0);
      let queueItemId: string | undefined;

      // Parse tx_data if available
      if (tx.tx_data) {
        try {
          if (tx.tx_data.startsWith("{")) {
            const txMetadata = JSON.parse(tx.tx_data);
            queueItemId = txMetadata.id;

            // Extract parameters
            depositId = BigInt(txMetadata._depositId || depositId.toString());
            tipReceiver =
              typeof txMetadata._tipReceiver === "string"
                ? txMetadata._tipReceiver
                : this.wallet.address;

            // Get requested tip amount
            const metadataTip = BigInt(txMetadata._requestedTip || "0");
            requestedTip = metadataTip > BigInt(0) ? metadataTip : requestedTip;
          }
        } catch (error) {
          this.logger.error("Failed to parse tx_data", {
            error: error instanceof Error ? error.message : String(error),
            txData: tx.tx_data.substring(0, 50) + "...",
          });
        }
      }

      // Ensure tip doesn't exceed wallet balance
      const adjustRequestedTip = async (): Promise<bigint> => {
        const walletBalance = await this.getWalletBalance();
        // Reserve some ETH for gas (estimated 0.01 ETH)
        const reserveForGas = BigInt(10000000000000000); // 0.01 ETH

        if (requestedTip > walletBalance) {
          // Use at most 90% of wallet balance, minus gas reserve
          const availableForTip =
            walletBalance > reserveForGas
              ? ((walletBalance - reserveForGas) * BigInt(90)) / BigInt(100)
              : BigInt(0);

          this.logger.info("Adjusting tip amount to fit wallet balance", {
            originalTip: requestedTip.toString(),
            adjustedTip: availableForTip.toString(),
            walletBalance: walletBalance.toString(),
          });

          return availableForTip;
        }

        return requestedTip;
      };

      // Adjust the tip (synchronously for simplicity)
      requestedTip = BigInt(0); // Default to 0 if wallet balance check fails
      adjustRequestedTip()
        .then((adjustedTip) => {
          requestedTip = adjustedTip;
        })
        .catch((error) => {
          this.logger.error("Failed to adjust tip amount", {
            error: error instanceof Error ? error.message : String(error),
          });
        });

      // Verify transaction will succeed with static call before executing
      const simulationResult = await this.simulateTransaction(
        depositId,
        tipReceiver,
        requestedTip,
      );
      if (!simulationResult.success) {
        this.logger.error("Transaction simulation failed, not executing", {
          depositId: depositId.toString(),
          error: simulationResult.error,
        });

        tx.status = TransactionStatus.FAILED;
        tx.error = new Error(`Simulation failed: ${simulationResult.error}`);

        // Update database if needed
        if (this.db && queueItemId) {
          await this.db.updateTransactionQueueItem(queueItemId, {
            status: TransactionQueueStatus.FAILED,
            error: `Simulation failed: ${simulationResult.error}`,
          });
        }

        return;
      }

      this.logger.info("Transaction simulation successful", {
        depositId: depositId.toString(),
        newEarningPower: simulationResult.result?.toString() || "unknown",
      });

      // Calculate gas parameters
      const gasParams = await this.estimateGasParams(
        depositId,
        tipReceiver,
        requestedTip,
      );

      // Log wallet balance
      const walletBalance = await this.getWalletBalance();
      this.logger.info("Current wallet balance before transaction", {
        balance: walletBalance.toString(),
        requestedTip: requestedTip.toString(),
        estimatedGasCost: (gasParams.gasLimit * gasParams.gasPrice).toString(),
      });

      // Execute transaction
      this.logger.info("Executing bumpEarningPower transaction", {
        depositId: depositId.toString(),
        tipReceiver,
        requestedTip: requestedTip.toString(),
        gasLimit: gasParams.gasLimit.toString(),
        gasPrice: gasParams.gasPrice.toString(),
      });

      let txResponse;
      try {
        txResponse = await this.stakerContract
          .getFunction("bumpEarningPower")
          .send(depositId, tipReceiver, requestedTip, {
            gasLimit: gasParams.gasLimit,
            gasPrice: gasParams.gasPrice,
            value: requestedTip,
          });

        this.logger.info("Transaction submitted successfully", {
          txHash: txResponse.hash,
          depositId: depositId.toString(),
        });
      } catch (sendError) {
        this.logger.error("Failed to send transaction", {
          error:
            sendError instanceof Error ? sendError.message : String(sendError),
          depositId: depositId.toString(),
        });
        throw sendError;
      }

      // Store transaction info
      tx.hash = txResponse.hash;
      tx.gasPrice = gasParams.gasPrice;

      // Wait for transaction to be mined
      const receipt = await txResponse.wait(this.config.minConfirmations);
      if (!receipt) {
        throw new Error("Transaction receipt not received");
      }

      // Update transaction status
      tx.status = TransactionStatus.CONFIRMED;
      this.logger.info("Transaction confirmed", {
        id: tx.id,
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
      });

      // Update database if needed
      if (this.db && queueItemId) {
        await this.db.updateTransactionQueueItem(queueItemId, {
          status: TransactionQueueStatus.CONFIRMED,
          hash: receipt.hash,
        });
        this.logger.info("Updated transaction queue item to CONFIRMED", {
          queueItemId,
          hash: receipt.hash,
        });
      }

      // Update transaction with queue item ID
      if (queueItemId) {
        tx.metadata = {
          ...tx.metadata,
          queueItemId
        };
      }
    } catch (error) {
      // Handle execution error
      tx.status = TransactionStatus.FAILED;
      tx.error = error as Error;
      tx.retryCount = (tx.retryCount ?? 0) + 1;

      this.logger.error("Transaction execution failed", {
        id: tx.id,
        depositId: (tx.depositId || tx.depositIds[0]!).toString(),
        error: error instanceof Error ? error.message : String(error),
      });

      // Handle retries
      this.handleTransactionRetry(tx, error);
    }
  }

  /**
   * Simulate a transaction to verify it will succeed
   * @param depositId The deposit ID
   * @param tipReceiver The tip receiver address
   * @param requestedTip The tip amount
   * @returns Result of the simulation with success flag and earning power or error
   */
  protected async simulateTransaction(
    depositId: bigint,
    tipReceiver: string,
    requestedTip: bigint,
  ): Promise<{ success: boolean; result?: bigint; error?: string }> {
    try {
      const simulationService = new SimulationService();
      const encodedData = this.contractInterface.encodeFunctionData("bumpEarningPower", [
        depositId,
        tipReceiver,
        requestedTip
      ]);

      const simulation = await simulationService.simulateTransaction(
        {
          from: this.wallet.address,
          to: this.contractAddress,
          data: encodedData,
          value: requestedTip.toString(),
        },
        {
          networkId: this.config.chainId.toString(),
        },
      );

      if (!simulation.success || simulation.error) {
        return {
          success: false,
          error: simulation.error?.message || "Simulation failed",
        };
      }

      // Extract the result from the simulation if available
      const result = simulation.returnValue
        ? BigInt(simulation.returnValue)
        : undefined;

      return {
        success: true,
        result,
      };
    } catch (error) {
      this.logger.error("Transaction simulation failed", {
        error: error instanceof Error ? error.message : String(error),
        depositId: depositId.toString(),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Estimate gas parameters for a transaction
   */
  protected async estimateGasParams(
    depositId: bigint,
    tipReceiver: string,
    requestedTip: bigint,
  ): Promise<{ gasLimit: bigint; gasPrice: bigint }> {
    try {
      const simulationService = new SimulationService();
      const encodedData = this.contractInterface.encodeFunctionData("bumpEarningPower", [
        depositId,
        tipReceiver,
        requestedTip
      ]);

      const gasEstimate = await simulationService.estimateGasCosts(
        {
          from: this.wallet.address,
          to: this.contractAddress,
          data: encodedData,
          value: requestedTip.toString(),
        },
        {
          networkId: this.config.chainId.toString(),
        },
      );

      // Add a 20% buffer to the gas limit for safety
      const gasLimit = BigInt(Math.floor(gasEstimate.gasUnits * 1.2));

      // Use the medium priority fee for a balance of speed and cost
      const gasPrice = ethers.parseUnits(
        gasEstimate.gasPriceDetails?.medium.maxFeePerGas || gasEstimate.gasPrice,
        "gwei",
      );

      return {
        gasLimit,
        gasPrice,
      };
    } catch (error) {
      this.logger.error("Gas estimation failed", {
        error: error instanceof Error ? error.message : String(error),
        depositId: depositId.toString(),
      });
      throw error;
    }
  }

  /**
   * Handle transaction retry logic
   */
  private handleTransactionRetry(tx: QueuedTransaction, error: unknown): void {
    // If we have retries left, requeue the transaction
    if ((tx.retryCount ?? 0) < this.config.maxRetries) {
      this.logger.info("Requeuing failed transaction", {
        id: tx.id,
        retryCount: tx.retryCount ?? 0,
        error: error instanceof Error ? error.message : String(error),
      });

      // Delay retries using an exponential backoff
      const delayMs =
        this.config.retryDelayMs * Math.pow(2, (tx.retryCount ?? 0) - 1);
      setTimeout(() => {
        // Reset status to QUEUED for retry
        tx.status = TransactionStatus.QUEUED;
        // Process queue to pick up the retry
        this.processQueue(false);
      }, delayMs);
    } else {
      this.logger.error("Transaction failed permanently", {
        id: tx.id,
        error: error instanceof Error ? error.message : String(error),
      });

      // Update database if needed
      this.updateFailedTransactionInDb(tx, error);
    }
  }

  /**
   * Update failed transaction in database
   */
  private async updateFailedTransactionInDb(
    tx: QueuedTransaction,
    error: unknown,
  ): Promise<void> {
    if (!this.db) return;

    try {
      let queueItemId: string | undefined;

      if (tx.metadata?.queueItemId) {
        queueItemId = tx.metadata.queueItemId;
      } else if (tx.tx_data && tx.tx_data.startsWith("{")) {
        try {
          const parseResult = JSON.parse(tx.tx_data);
          if (parseResult && parseResult.id) {
            queueItemId = parseResult.id;
          }
        } catch (e) {
          this.logger.debug("Failed to parse tx_data for queue ID", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      if (queueItemId) {
        await this.db.updateTransactionQueueItem(queueItemId, {
          status: TransactionQueueStatus.FAILED,
          error: error instanceof Error ? error.message : String(error),
        });
        this.logger.info("Updated transaction queue item to FAILED", {
          queueItemId,
        });
      }
    } catch (dbError) {
      this.logger.error(
        "Failed to update transaction queue with failure status",
        {
          error: dbError instanceof Error ? dbError.message : String(dbError),
          txId: tx.id,
        },
      );
    }
  }

  /**
   * Calculate function selector for a given function name and parameter types
   */
  protected calculateFunctionSelector(
    functionName: string,
    paramTypes: string[],
  ): string {
    // Create the function signature
    const signature = `${functionName}(${paramTypes.join(",")})`;
    // Calculate the selector
    const selector = ethers
      .keccak256(ethers.toUtf8Bytes(signature))
      .slice(0, 10);
    return selector;
  }

  /**
   * Check for transactions in the database queue that need to be executed
   */
  protected async checkDatabaseTransactionQueue(): Promise<void> {
    if (!this.db || !this.isRunning) {
      return;
    }

    try {
      // Get queued transactions from database
      const queueItems = await this.db.getTransactionQueueItemsByStatus(
        TransactionQueueStatus.PENDING,
      );

      if (queueItems.length === 0) {
        return;
      }

      this.logger.info("Found database queue items", {
        count: queueItems.length,
      });

      // Process each transaction
      for (const item of queueItems) {
        if (!item || !item.deposit_id) {
          continue;
        }

        // Skip if we already have this transaction in our queue
        const existingTx = Array.from(this.queue.values()).find(
          (tx) => {
            const txDepositId = tx.depositId || tx.depositIds[0];
            return txDepositId?.toString() === item.deposit_id &&
              tx.status !== TransactionStatus.FAILED;
          }
        );

        if (existingTx) {
          this.logger.info("Transaction already in local queue", {
            depositId: item.deposit_id,
          });
          continue;
        }

        try {
          // Mark as processing in database
          await this.db.updateTransactionQueueItem(item.id, {
            status: TransactionQueueStatus.SUBMITTED,
          });

          // Parse transaction data for metadata
          const txData = item.tx_data;
          const metadata = this.parseTxDataMetadata(txData);

          // Create a profitability check object for the executor
          const profitability: ProfitabilityCheck = {
            canBump: true,
            constraints: {
              calculatorEligible: true,
              hasEnoughRewards: true,
              isProfitable: true,
            },
            estimates: {
              optimalTip: BigInt(metadata.tipAmount || "0"),
              gasEstimate: BigInt(metadata.gasEstimate || "100000"),
              expectedProfit: BigInt(metadata.profit || "0"),
              tipReceiver: metadata.tipReceiver || ethers.ZeroAddress,
            },
          };

          // Queue the transaction
          const tx = await this.queueTransaction(
            BigInt(item.deposit_id),
            profitability,
            txData,
          );

          // Store the database queue item ID in the transaction for future reference
          tx.metadata = {
            ...tx.metadata,
            queueItemId: item.id
          };

          this.logger.info("Queued transaction from database", {
            id: tx.id,
            depositId: item.deposit_id,
            queueItemId: item.id,
          });
        } catch (error) {
          this.logger.error("Failed to process database queue item", {
            id: item.id,
            error: error instanceof Error ? error.message : String(error),
          });

          // Mark as failed in database
          await this.db.updateTransactionQueueItem(item.id, {
            status: TransactionQueueStatus.FAILED,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.logger.error("Failed to check database transaction queue", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Parse metadata from transaction data
   */
  private parseTxDataMetadata(txData?: string): {
    tipAmount?: string;
    gasEstimate?: string;
    profit?: string;
    tipReceiver?: string;
  } {
    if (!txData) return {};

    try {
      // Try to parse as JSON
      return JSON.parse(txData);
    } catch (e) {
      // If not JSON, return empty object
      return {};
    }
  }

  /**
   * Validate transaction data
   */
  protected validateTransactionData(
    data: string | null | undefined,
    context: string,
  ): boolean {
    if (!data) {
      this.logger.error("Transaction data is null or undefined", { context });
      return false;
    }

    // Check if it's a valid hex string starting with 0x
    if (!data.startsWith("0x")) {
      this.logger.error("Transaction data does not start with 0x", {
        context,
        data: data.substring(0, 10),
      });
      return false;
    }

    // Check for minimum length (0x + at least 4 bytes function selector)
    if (data.length < 10) {
      this.logger.error("Transaction data too short", {
        context,
        length: data.length,
      });
      return false;
    }

    return true;
  }
}
