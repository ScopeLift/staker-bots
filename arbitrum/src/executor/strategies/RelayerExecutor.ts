import { ethers } from "ethers";
import axios from "axios";
import { ConsoleLogger, Logger } from "@/monitor/logging";
import { IExecutor } from "../interfaces/IExecutor";
import {
  RelayerExecutorConfig,
  QueuedTransaction,
  TransactionStatus,
  QueueStats,
  TransactionReceipt,
} from "../interfaces/types";
import { ProfitabilityCheck } from "@/profitability/interfaces/types";
import { v4 as uuidv4 } from "uuid";
import { DatabaseWrapper } from "@/database";
import { TransactionQueueStatus } from "@/database/interfaces/types";
import { TransactionSimulator } from "../utils";

/**
 * Implementation of executor using OpenZeppelin Defender Relayer.
 * Handles transaction queueing, execution, and monitoring through the Defender API.
 */
export class RelayerExecutor implements IExecutor {
  private readonly logger: Logger;
  private readonly queue: Map<string, QueuedTransaction>;
  private isRunning: boolean;
  private processingInterval: NodeJS.Timeout | null;
  private db?: DatabaseWrapper;

  // Defender relayer credentials
  private readonly relayerApiKey: string;
  private readonly relayerApiSecret: string;

  // Contract details
  private readonly contractAddress: string;
  private readonly contractInterface: ethers.Interface;
  private readonly stakerContract: ethers.Contract & {
    bumpEarningPower(
      depositId: bigint,
      overrides?: ethers.Overrides,
    ): Promise<ethers.ContractTransactionResponse>;
  };

  /**
   * Creates a new RelayerExecutor instance
   */
  constructor(
    stakerContract: ethers.Contract,
    private readonly provider: ethers.Provider,
    private readonly config: RelayerExecutorConfig,
  ) {
    this.logger = new ConsoleLogger("info");
    this.queue = new Map();
    this.isRunning = false;
    this.processingInterval = null;

    // Store contract details
    this.contractAddress = stakerContract.target as string;
    this.contractInterface = stakerContract.interface;

    // Validate required config
    if (!config.relayer.apiKey || !config.relayer.apiSecret) {
      throw new Error("Relayer API key and secret are required");
    }

    this.relayerApiKey = config.relayer.apiKey;
    this.relayerApiSecret = config.relayer.apiSecret;

    // Validate contract has required functions
    if (!this.contractInterface.hasFunction("bumpEarningPower")) {
      throw new Error(
        "Invalid staker contract: missing bumpEarningPower function",
      );
    }

    // Initialize Defender Relay Provider and Signer
    try {
      // Credentials are now directly used in API calls, not needed as a variable
      // const credentials = {
      //   apiKey: this.relayerApiKey,
      //   apiSecret: this.relayerApiSecret
      // };

      // Use axios to create a client for sending transactions directly
      // We'll use this approach for sending transactions through the Defender API

      // Create contract instance with direct ethers interface for estimating gas
      // Note: For actual transaction submission, we'll use the Defender API directly
      this.stakerContract = stakerContract as typeof this.stakerContract;
    } catch (error) {
      this.logger.error("Failed to initialize Defender SDK or contract", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Set the database instance for transaction queue management
   */
  setDatabase(db: DatabaseWrapper): void {
    this.db = db;
    this.logger.info("Database set for relayer executor");
  }

  /**
   * Start the executor service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    try {
      // Validate relayer credentials
      await this.validateCredentials();

      this.isRunning = true;
      this.logger.info("Relayer executor started");

      // Start processing queue periodically
      this.processingInterval = setInterval(
        () => this.processQueue(),
        5000, // Process queue every 5 seconds
      );

      // Also check for transactions in the DB queue
      setInterval(() => {
        this.checkDatabaseTransactionQueue().catch((error) => {
          this.logger.error("Error checking database transaction queue:", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 15000); // Check database queue every 15 seconds

      this.logger.info("Queue processing intervals started");
    } catch (error) {
      this.logger.error("Failed to start relayer executor:", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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

    this.logger.info("Relayer executor stopped");
  }

  /**
   * Validate relayer credentials
   */
  private async validateCredentials(): Promise<void> {
    try {
      // Request the relayer endpoint to verify credentials
      const url = "https://api.defender.openzeppelin.com/relayer/relayers";
      const response = await axios.get(url, {
        headers: {
          "X-Api-Key": this.relayerApiKey,
          "X-Api-Secret": this.relayerApiSecret,
        },
      });

      // Check if response is valid
      if (!response.data || response.status !== 200) {
        throw new Error("Invalid relayer response");
      }

      this.logger.info("Relayer credentials validated");
    } catch (error) {
      this.logger.error("Failed to validate relayer credentials:", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error("Invalid relayer credentials");
    }
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
    try {
      // Check relayer balance
      const relayerBalance = await this.getRelayerBalance();
      const pendingTxs = Array.from(this.queue.values()).filter(
        (tx) => tx.status === TransactionStatus.PENDING,
      ).length;

      return {
        isRunning: this.isRunning,
        walletBalance: relayerBalance,
        pendingTransactions: pendingTxs,
        queueSize: this.queue.size,
      };
    } catch (error) {
      this.logger.error("Failed to get relayer status:", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        isRunning: this.isRunning,
        walletBalance: BigInt(0),
        pendingTransactions: 0,
        queueSize: this.queue.size,
      };
    }
  }

  /**
   * Get relayer balance
   */
  private async getRelayerBalance(): Promise<bigint> {
    try {
      // Query relayer balance via Defender API
      const url = "https://api.defender.openzeppelin.com/relayer/relayers";
      const response = await axios.get(url, {
        headers: {
          "X-Api-Key": this.relayerApiKey,
          "X-Api-Secret": this.relayerApiSecret,
        },
      });

      if (!response.data || response.status !== 200) {
        throw new Error("Invalid relayer response");
      }

      // Find our relayer in the response
      const relayer = response.data.find(
        (r: { network: string; balance?: string }) =>
          r.network === "mainnet" || r.network === "arbitrum",
      );

      if (!relayer) {
        throw new Error("Relayer not found");
      }

      return BigInt(relayer.balance || "0");
    } catch (error) {
      this.logger.error("Failed to get relayer balance:", {
        error: error instanceof Error ? error.message : String(error),
      });
      return BigInt(0);
    }
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
      profitability,
      status: TransactionStatus.QUEUED,
      createdAt: new Date(),
      tx_data: txData,
    };

    // Add to queue
    this.queue.set(tx.id, tx);
    this.logger.info("Transaction queued:", {
      id: tx.id,
      depositId: tx.depositId.toString(),
      hasTxData: !!txData,
    });

    // Process queue immediately if running
    if (this.isRunning) {
      // Use setImmediate to avoid blocking the current call stack
      setImmediate(() => this.processQueue());
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
    try {
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
    } catch (error) {
      this.logger.error("Failed to get transaction receipt:", {
        hash,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Transfer accumulated tips to the configured receiver
   */
  async transferOutTips(): Promise<TransactionReceipt | null> {
    this.logger.info("Transfer out tips not implemented for relayer executor");
    return null;
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
  private async processQueue(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Only process if there are queued transactions
    const queuedTxs = Array.from(this.queue.values()).filter(
      (tx) => tx.status === TransactionStatus.QUEUED,
    );

    if (queuedTxs.length === 0) {
      return;
    }

    // Check how many pending transactions we have
    const pendingTxCount = Array.from(this.queue.values()).filter(
      (tx) => tx.status === TransactionStatus.PENDING,
    ).length;

    // If we have too many pending transactions, don't execute more
    if (pendingTxCount >= this.config.relayer.maxPendingTransactions) {
      this.logger.info("Too many pending transactions, skipping execution");
      return;
    }

    // Process up to concurrentTransactions at a time
    const toProcess = queuedTxs.slice(0, this.config.concurrentTransactions);
    for (const tx of toProcess) {
      this.executeTransaction(tx).catch((error) => {
        this.logger.error("Error executing transaction:", {
          txId: tx.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  /**
   * Execute a transaction through the relayer using ethers v6
   */
  private async executeTransaction(tx: QueuedTransaction): Promise<void> {
    if (!this.isRunning) {
      this.logger.info("Executor not running, skipping transaction");
      return;
    }

    try {
      // Update status to pending
      tx.status = TransactionStatus.PENDING;
      tx.executedAt = new Date();
      this.logger.info("Executing transaction through relayer", { id: tx.id });

      // Parse transaction data and extract queue item ID
      const { depositId, queueItemId } = this.parseTransactionData(tx);

      // Update database with pending status if queueItemId exists
      if (this.db && queueItemId) {
        try {
          await this.db.updateTransactionQueueItem(queueItemId, {
            status: TransactionQueueStatus.PENDING,
          });
          this.logger.info("Updated transaction queue item status to PENDING", {
            queueItemId,
          });
        } catch (error) {
          this.logger.error("Failed to update transaction queue item status", {
            error: error instanceof Error ? error.message : String(error),
            queueItemId,
          });
        }
      }

      // Get current network conditions
      const feeData = await this.provider.getFeeData();
      this.logger.info("Network fee data", {
        maxFeePerGas: feeData.maxFeePerGas?.toString() || "undefined",
        maxPriorityFeePerGas:
          feeData.maxPriorityFeePerGas?.toString() || "undefined",
        gasPrice: feeData.gasPrice?.toString() || "undefined",
      });

      // Simulate the transaction to check if it would succeed
      const simulationResult = await this.simulateTransaction(depositId);

      if (!simulationResult.success) {
        this.logger.error("Transaction simulation failed, not executing", {
          id: tx.id,
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
        id: tx.id,
        depositId: depositId.toString(),
        newEarningPower: simulationResult.result?.toString() || "unknown",
      });

      // Estimate gas for the transaction
      const gasParams = await this.estimateGasParams(depositId);
      const gasLimit = gasParams.gasLimit;

      // Encode the function call
      const encodedData = this.contractInterface.encodeFunctionData(
        "bumpEarningPower",
        [depositId],
      );

      // Prepare the transaction request for Defender API
      const payload = this.prepareRelayerPayload(
        this.contractAddress,
        encodedData,
        gasLimit,
        feeData,
      );

      // Send transaction through Defender API
      const txResponse = await this.sendRelayerTransaction(payload);

      // Store transaction info
      tx.hash = txResponse.hash;
      this.logger.info("Transaction sent through relayer", {
        id: tx.id,
        hash: tx.hash,
        depositId: depositId.toString(),
      });

      // Wait for transaction to be mined
      this.logger.info("Waiting for transaction to be mined...");
      const receipt = await txResponse.wait();

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
        try {
          await this.db.updateTransactionQueueItem(queueItemId, {
            status: TransactionQueueStatus.CONFIRMED,
            hash: receipt.hash,
          });
          this.logger.info("Updated transaction queue item to CONFIRMED", {
            queueItemId,
            hash: receipt.hash,
          });
        } catch (error) {
          this.logger.error("Failed to update transaction queue status", {
            error: error instanceof Error ? error.message : String(error),
            queueItemId,
          });
        }
      }
    } catch (error) {
      // Handle execution error
      tx.status = TransactionStatus.FAILED;
      tx.error = error as Error;
      tx.retryCount = (tx.retryCount ?? 0) + 1;

      this.logger.error("Transaction execution failed", {
        id: tx.id,
        error: error instanceof Error ? error.message : String(error),
      });

      // Handle retries
      this.handleTransactionRetry(tx, error);
    }
  }

  /**
   * Parse transaction data from tx_data
   */
  private parseTransactionData(tx: QueuedTransaction): {
    depositId: bigint;
    queueItemId?: string;
  } {
    const depositId = tx.depositId;
    let queueItemId: string | undefined;

    // Parse tx_data if available
    if (tx.tx_data) {
      try {
        // Check if tx_data is a JSON string
        if (tx.tx_data.startsWith("{")) {
          const txData = JSON.parse(tx.tx_data);
          queueItemId = txData.id;
        }
      } catch (error) {
        this.logger.debug("Failed to parse tx_data", {
          error: error instanceof Error ? error.message : String(error),
          txData: tx.tx_data?.substring(0, 20) + "...",
        });
      }
    }

    return { depositId, queueItemId };
  }

  /**
   * Prepare payload for Defender Relayer API
   */
  private prepareRelayerPayload(
    contractAddress: string,
    encodedData: string,
    gasLimit: bigint,
    feeData: ethers.FeeData,
  ): Record<string, string | number | boolean> {
    const payload: Record<string, string | number | boolean> = {
      to: contractAddress,
      data: encodedData,
      gasLimit: gasLimit.toString(),
      speed: "fast",
    };

    // Add gas policy if specified in config
    if (this.config.relayer.gasPolicy) {
      if (this.config.relayer.gasPolicy.maxFeePerGas) {
        payload.maxFeePerGas =
          this.config.relayer.gasPolicy.maxFeePerGas.toString();
      } else if (feeData.maxFeePerGas) {
        payload.maxFeePerGas = feeData.maxFeePerGas.toString();
      }

      if (this.config.relayer.gasPolicy.maxPriorityFeePerGas) {
        payload.maxPriorityFeePerGas =
          this.config.relayer.gasPolicy.maxPriorityFeePerGas.toString();
      } else if (feeData.maxPriorityFeePerGas) {
        payload.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas.toString();
      }
    }

    this.logger.info("Prepared transaction payload for Defender API", {
      to: payload.to,
      gasLimit: payload.gasLimit,
      speed: payload.speed,
      hasData: !!payload.data,
    });

    return payload;
  }

  /**
   * Send transaction via Defender Relayer API
   */
  private async sendRelayerTransaction(
    payload: Record<string, string | number | boolean>,
  ): Promise<{
    hash: string;
    wait: (confirmations?: number) => Promise<TransactionReceipt | null>;
  }> {
    const url = "https://api.defender.openzeppelin.com/relayer/transactions";
    const response = await axios.post(url, payload, {
      headers: {
        "X-Api-Key": this.relayerApiKey,
        "X-Api-Secret": this.relayerApiSecret,
        "Content-Type": "application/json",
      },
    });

    // Validate response
    if (!response.data || !response.data.hash) {
      throw new Error(
        "Invalid Defender API response: missing transaction hash",
      );
    }

    return {
      hash: response.data.hash,
      wait: async (confirmations?: number) => {
        return this.waitForTransaction(
          response.data.hash,
          confirmations || this.config.minConfirmations,
        );
      },
    };
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
        this.processQueue();
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

      if (tx.tx_data) {
        try {
          const txData = JSON.parse(tx.tx_data);
          if (txData.id) {
            queueItemId = txData.id;
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
   * Wait for a transaction to be mined
   */
  private async waitForTransaction(
    hash: string,
    confirmations: number,
  ): Promise<TransactionReceipt | null> {
    this.logger.info("Waiting for transaction:", { hash, confirmations });

    // Maximum wait time in milliseconds
    const maxWaitTimeMs = confirmations * 15000; // ~15 sec/block
    const startTime = Date.now();

    // Wait for the transaction to be mined
    while (Date.now() - startTime < maxWaitTimeMs) {
      try {
        const receipt = await this.provider.getTransactionReceipt(hash);
        if (receipt) {
          // Check confirmations
          const latestBlock = await this.provider.getBlockNumber();
          const currentConfirmations = latestBlock - receipt.blockNumber + 1;

          if (currentConfirmations >= confirmations) {
            // Convert ethers receipt to our TransactionReceipt type
            return {
              hash: receipt.hash,
              status: receipt.status === 1,
              blockNumber: receipt.blockNumber,
              gasUsed: receipt.gasUsed,
              effectiveGasPrice: receipt.gasPrice || BigInt(0),
            };
          }

          this.logger.info("Transaction mined but waiting for confirmations:", {
            hash,
            currentConfirmations,
            required: confirmations,
          });
        }
      } catch (error) {
        this.logger.warn("Error checking transaction receipt:", {
          hash,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Sleep before checking again
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    this.logger.warn("Timeout waiting for transaction confirmation:", { hash });
    return null;
  }

  /**
   * Check for transactions in the database queue that need to be executed
   */
  private async checkDatabaseTransactionQueue(): Promise<void> {
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

      this.logger.info("Found database queue items:", {
        count: queueItems.length,
      });

      // Process each transaction
      for (const item of queueItems) {
        if (!item || !item.deposit_id) {
          continue;
        }

        // Skip if we already have this transaction in our queue
        const existingTx = Array.from(this.queue.values()).find(
          (tx) =>
            tx.depositId.toString() === item.deposit_id &&
            tx.status !== TransactionStatus.FAILED,
        );

        if (existingTx) {
          this.logger.info("Transaction already in local queue:", {
            depositId: item.deposit_id,
          });
          continue;
        }

        try {
          // Parse any metadata from tx_data
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

          // Add full item data to txData for reference
          const enrichedTxData = JSON.stringify({
            ...metadata,
            id: item.id,
            depositId: item.deposit_id,
          });

          // Queue the transaction
          const tx = await this.queueTransaction(
            BigInt(item.deposit_id),
            profitability,
            enrichedTxData,
          );

          this.logger.info("Queued transaction from database:", {
            id: tx.id,
            depositId: item.deposit_id,
            queueItemId: item.id,
          });

          // Update database status to acknowledge processing
          await this.db.updateTransactionQueueItem(item.id, {
            status: TransactionQueueStatus.SUBMITTED,
          });
        } catch (error) {
          this.logger.error("Failed to process database queue item:", {
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
      this.logger.error("Failed to check database transaction queue:", {
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
   * Simulate a transaction to verify it will succeed
   * @param depositId The deposit ID
   * @returns Result of the simulation with success flag and earning power or error
   */
  protected async simulateTransaction(
    depositId: bigint,
  ): Promise<{ success: boolean; result?: bigint; error?: string }> {
    try {
      this.logger.info("Simulating transaction", {
        depositId: depositId.toString(),
      });

      // Create transaction simulator instance
      const simulator = new TransactionSimulator(this.provider, this.logger);

      // Simulate the transaction
      const simulation = await simulator.simulateContractFunction<bigint>(
        this.stakerContract,
        "bumpEarningPower",
        [depositId],
        {
          context: `depositId:${depositId.toString()}`,
        },
      );

      return simulation;
    } catch (error) {
      // Log the error and return failure
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger.error("Transaction simulation failed outside of simulator", {
        depositId: depositId.toString(),
        error: errorMessage,
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Estimate gas parameters for a transaction
   * @param depositId The deposit ID
   * @returns Gas parameters with gasLimit and gasPrice
   */
  protected async estimateGasParams(
    depositId: bigint,
  ): Promise<{ gasLimit: bigint; gasPrice: bigint }> {
    try {
      // Create transaction simulator instance
      const simulator = new TransactionSimulator(this.provider, this.logger, {
        gasBoostPercentage: this.config.gasBoostPercentage,
        gasLimitBufferPercentage: 20, // 20% buffer by default
      });

      // Estimate gas parameters
      const gasEstimate = await simulator.estimateGasParameters(
        this.stakerContract,
        "bumpEarningPower",
        [depositId],
        {
          fallbackGasLimit: BigInt(300000),
          context: `depositId:${depositId.toString()}`,
        },
      );

      this.logger.info("Gas parameters estimated", {
        depositId: depositId.toString(),
        gasLimit: gasEstimate.gasLimit.toString(),
        gasPrice: gasEstimate.gasPrice.toString(),
      });

      return gasEstimate;
    } catch (error) {
      // Log the error and use fallback values
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger.error("Gas estimation failed completely", {
        depositId: depositId.toString(),
        error: errorMessage,
      });

      // Use fallback values
      return {
        gasLimit: BigInt(300000),
        gasPrice: BigInt(0), // This will be set by the relayer
      };
    }
  }
}
