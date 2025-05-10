import { ethers } from 'ethers';
import { Logger } from '@/monitor/logging';
import { GovLstProfitabilityCheck } from '@/profitability/interfaces/types';
import {
  QueuedTransaction,
  TransactionStatus,
  TransactionReceipt,
  EthersTransactionReceipt,
  GovLstExecutorError,
  RelayerExecutorConfig,
} from '../interfaces/types';
import {
  calculateGasLimit,
  extractQueueItemInfo,
  validateTransaction,
} from '@/configuration/helpers';
import { DatabaseWrapper } from '@/database';
import {
  ProcessingQueueStatus,
  TransactionQueueStatus,
} from '@/database/interfaces/types';
import { ErrorLogger } from '@/configuration/errorLogger';
import {
  ExecutorError,
  InsufficientBalanceError,
  TransactionValidationError,
  BaseError,
} from '@/configuration/errors';
import { RELAYER_EVENTS, RELAYER_PROFITABILITY } from './constants';
import { v4 as uuidv4 } from 'uuid';

/**
 * Serialize a profitability check object, ensuring BigInt values are handled correctly
 * @param check - Profitability check to serialize
 * @returns Serialized profitability check
 */
export function serializeProfitabilityCheck(
  check: GovLstProfitabilityCheck,
): GovLstProfitabilityCheck {
  // Convert string values back to BigInt if they were serialized
  const parseBigInt = (value: string | bigint): bigint => {
    return typeof value === 'string' ? BigInt(value) : value;
  };

  return {
    ...check,
    estimates: {
      expected_profit: parseBigInt(check.estimates.expected_profit),
      gas_estimate: parseBigInt(check.estimates.gas_estimate),
      gas_cost: parseBigInt(check.estimates.gas_cost),
      total_shares: parseBigInt(check.estimates.total_shares),
      payout_amount: parseBigInt(check.estimates.payout_amount),
    },
    deposit_details: check.deposit_details.map((detail) => ({
      ...detail,
      depositId: parseBigInt(detail.depositId),
      rewards: parseBigInt(detail.rewards),
    })),
  };
}

/**
 * Get the current block number with retry logic
 * @param provider - Ethereum provider
 * @param retries - Number of retries
 * @param delayMs - Delay between retries in ms
 * @returns Current block number
 */
export async function getCurrentBlockNumberWithRetry(
  provider: ethers.Provider,
  logger: Logger,
  retries = 3,
  delayMs = 1000,
): Promise<number> {
  for (let i = 0; i < retries; i++) {
    try {
      return await provider.getBlockNumber();
    } catch (error) {
      logger.warn(`Failed to get block number (attempt ${i + 1}/${retries})`, {
        error,
      });

      if (i === retries - 1) throw error;
      await sleep(delayMs * (i + 1));
    }
  }

  throw new Error('Failed to get block number after retries');
}

/**
 * Calculate gas parameters for a transaction
 * @param provider - Ethereum provider
 * @param gasEstimate - Base gas estimate
 * @param gasBoostPercentage - Gas boost percentage
 * @param logger - Logger instance
 * @returns Gas limit and price parameters
 */
export async function calculateGasParameters(
  provider: ethers.Provider,
  gasEstimate: bigint,
  gasBoostPercentage: number,
  logger: Logger,
): Promise<{
  finalGasLimit: bigint;
  boostedGasPrice: bigint;
}> {
  const finalGasLimit = calculateGasLimit(gasEstimate, 1, logger);
  const feeData = await provider.getFeeData();
  const baseGasPrice = feeData.gasPrice || 0n;
  const gasBoostMultiplier = BigInt(100 + gasBoostPercentage);
  const boostedGasPrice = (baseGasPrice * gasBoostMultiplier) / 100n;

  return { finalGasLimit, boostedGasPrice };
}

/**
 * Sleep utility function
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the specified time
 */
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cleans up queue items after transaction completion (success or failure)
 * @param tx - Transaction that completed
 * @param txHash - Transaction hash
 * @param db - Database wrapper instance
 * @param logger - Logger instance
 * @param errorLogger - Error logger instance
 */
export async function cleanupQueueItems(
  tx: QueuedTransaction,
  txHash: string,
  db: DatabaseWrapper | undefined,
  logger: Logger,
  errorLogger?: ErrorLogger,
): Promise<void> {
  if (!db) return;

  try {
    // Use the centralized helper to extract queue item info
    const { queueItemId, depositIds: extractedDepositIds } =
      extractQueueItemInfo(tx);
    let depositIdStrings = [...extractedDepositIds]; // Make a mutable copy

    // If we don't have deposit IDs yet, try to get them from tx.depositIds
    if (
      depositIdStrings.length === 0 &&
      tx.depositIds &&
      tx.depositIds.length > 0
    ) {
      depositIdStrings = tx.depositIds.map(String);
      logger.info('Using deposit IDs from transaction object:', {
        depositIds: depositIdStrings,
      });
    }

    let queueItemProcessed = false;

    // If we have a specific queue item ID
    if (queueItemId) {
      // First try to get additional deposit IDs from the database if needed
      if (depositIdStrings.length === 0) {
        const queueItem = await db.getTransactionQueueItem(queueItemId);
        if (queueItem) {
          // Try to extract deposit IDs from the tx_data JSON
          if (queueItem.tx_data) {
            try {
              const txData = JSON.parse(queueItem.tx_data);
              if (Array.isArray(txData.depositIds)) {
                depositIdStrings = txData.depositIds.map(String);
                logger.info('Found deposit IDs in tx_data:', {
                  depositIds: depositIdStrings,
                });
              }
            } catch (parseError) {
              logger.error('Failed to parse tx_data JSON:', {
                error:
                  parseError instanceof Error
                    ? parseError.message
                    : String(parseError),
              });

              if (errorLogger) {
                await errorLogger.warn(parseError as Error, {
                  context: 'executor-parse-tx-data-failed',
                  queueItemId,
                });
              }
            }
          }

          // If we still have no deposit IDs, check if deposit_id field has a single ID
          if (depositIdStrings.length === 0 && queueItem.deposit_id) {
            // Use the deposit_id directly (will be a single ID in Supabase case)
            depositIdStrings = [queueItem.deposit_id];
            logger.info('Using single deposit ID from queue item:', {
              depositId: queueItem.deposit_id,
            });
          }
        }
      }

      try {
        // Update transaction queue item status first
        await db.updateTransactionQueueItem(queueItemId, {
          status:
            tx.status === TransactionStatus.CONFIRMED
              ? TransactionQueueStatus.CONFIRMED
              : TransactionQueueStatus.FAILED,
          hash: txHash,
          error:
            tx.status === TransactionStatus.FAILED
              ? tx.error?.message || 'Transaction failed'
              : undefined,
        });

        // Delete transaction queue item
        await db.deleteTransactionQueueItem(queueItemId);
        queueItemProcessed = true;

        logger.info('Deleted transaction queue item by ID', {
          queueItemId,
          txHash,
        });
      } catch (updateError) {
        logger.error('Failed to update/delete transaction queue item by ID', {
          error:
            updateError instanceof Error
              ? updateError.message
              : String(updateError),
          queueItemId,
          txHash,
        });

        if (errorLogger) {
          await errorLogger.error(updateError as Error, {
            context: 'executor-cleanup-tx-queue-item-failed',
            queueItemId,
            txHash,
          });
        }
      }
    }

    // If we have deposit IDs but haven't processed a queue item yet, try to find and clean up
    // transaction queue items by deposit ID
    if (!queueItemProcessed && depositIdStrings.length > 0) {
      for (const depositId of depositIdStrings) {
        try {
          const txQueueItem =
            await db.getTransactionQueueItemByDepositId(depositId);
          if (txQueueItem) {
            // Update the item status first
            await db.updateTransactionQueueItem(txQueueItem.id, {
              status:
                tx.status === TransactionStatus.CONFIRMED
                  ? TransactionQueueStatus.CONFIRMED
                  : TransactionQueueStatus.FAILED,
              hash: txHash,
              error:
                tx.status === TransactionStatus.FAILED
                  ? tx.error?.message || 'Transaction failed'
                  : undefined,
            });

            // Then delete it
            await db.deleteTransactionQueueItem(txQueueItem.id);
            queueItemProcessed = true;

            logger.info('Deleted transaction queue item by deposit ID', {
              txQueueItemId: txQueueItem.id,
              depositId,
              txHash,
            });
          }
        } catch (txQueueError) {
          logger.error(
            'Failed to clean up transaction queue item by deposit ID',
            {
              error:
                txQueueError instanceof Error
                  ? txQueueError.message
                  : String(txQueueError),
              depositId,
              txHash,
            },
          );

          if (errorLogger) {
            await errorLogger.error(txQueueError as Error, {
              context: 'executor-cleanup-tx-queue-item-by-deposit-failed',
              depositId,
              txHash,
            });
          }
        }
      }
    }

    // Clean up processing queue items for all deposit IDs
    if (depositIdStrings.length > 0) {
      for (const depositId of depositIdStrings) {
        try {
          const processingItem =
            await db.getProcessingQueueItemByDepositId(depositId);
          if (processingItem) {
            // Update status before deletion for record keeping
            await db.updateProcessingQueueItem(processingItem.id, {
              status:
                tx.status === TransactionStatus.CONFIRMED
                  ? ProcessingQueueStatus.COMPLETED
                  : ProcessingQueueStatus.FAILED,
              error:
                tx.status === TransactionStatus.FAILED
                  ? tx.error?.message || 'Transaction failed'
                  : undefined,
            });

            // Then delete
            await db.deleteProcessingQueueItem(processingItem.id);

            logger.info('Deleted processing queue item', {
              processingItemId: processingItem.id,
              depositId,
              txHash,
            });
          }
        } catch (error) {
          logger.error('Failed to clean up processing queue item', {
            error: error instanceof Error ? error.message : String(error),
            depositId,
            txHash,
          });

          if (errorLogger) {
            await errorLogger.error(error as Error, {
              context: 'executor-cleanup-processing-item-failed',
              depositId,
              txHash,
            });
          }
        }
      }
    }

    // If we couldn't find specific items, log a warning
    if (!queueItemProcessed && depositIdStrings.length === 0) {
      logger.warn('Unable to identify queue items to clean up', {
        txId: tx.id,
        txHash,
      });

      if (errorLogger) {
        await errorLogger.warn(
          new Error('Unable to identify queue items to clean up'),
          {
            context: 'executor-cleanup-no-items-found',
            txId: tx.id,
            txHash,
          },
        );
      }
    }
  } catch (error) {
    logger.error('Failed to clean up queue items', {
      error: error instanceof Error ? error.message : String(error),
      txId: tx.id,
      txHash,
    });

    if (errorLogger) {
      await errorLogger.error(error as Error, {
        context: 'executor-cleanup-queue-items-failed',
        txId: tx.id,
        txHash,
      });
    }
  }
}

/**
 * Validates a transaction before execution
 * @param depositIds - Array of deposit IDs
 * @param profitability - Profitability check results
 * @param queue - Transaction queue
 * @param provider - Provider to get fee data
 * @param lstContract - Contract instance
 * @returns Validation result with isValid flag and error if any
 */
export async function validateRelayerTransaction(
  depositIds: bigint[],
  profitability: GovLstProfitabilityCheck,
  queue: Map<string, QueuedTransaction>,
  provider: ethers.Provider,
  lstContract: ethers.Contract & { payoutAmount(): Promise<bigint> },
): Promise<{ isValid: boolean; error: TransactionValidationError | null }> {
  // Use the centralized validation function first
  const baseValidation = await validateTransaction(
    depositIds,
    profitability,
    queue,
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
  const feeData = await provider.getFeeData();
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
  if (!lstContract || typeof lstContract.payoutAmount !== 'function') {
    return {
      isValid: false,
      error: new TransactionValidationError(
        'Contract not properly initialized or missing payoutAmount method',
        {
          contract: lstContract,
        },
      ),
    };
  }
  const payoutAmount = await lstContract.payoutAmount();

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

/**
 * Check and wait for sufficient balance
 * @param provider - Ethereum provider
 * @param address - Address to check balance
 * @param minBalance - Minimum required balance
 * @param logger - Logger instance
 * @returns Promise that resolves when balance is sufficient or rejects with error
 */
export async function checkAndWaitForBalance(
  provider: ethers.Provider,
  address: string,
  minBalance: bigint,
  logger: Logger,
): Promise<void> {
  const balance = await provider.getBalance(address);
  const balanceBigInt = BigInt(balance.toString());

  if (balanceBigInt < minBalance) {
    logger.warn('Insufficient balance detected', {
      currentBalance: balanceBigInt.toString(),
      requiredBalance: minBalance.toString(),
      difference: (minBalance - balanceBigInt).toString(),
    });

    // Start monitoring balance
    let attempts = 0;
    const maxAttempts = 30; // Wait up to 5 minutes (30 * 10 seconds)

    while (attempts < maxAttempts) {
      attempts++;

      // Wait 10 seconds between checks
      await sleep(10000);

      const newBalance = await provider.getBalance(address);
      const newBalanceBigInt = BigInt(newBalance.toString());

      logger.info('Checking balance recovery', {
        attempt: attempts,
        currentBalance: newBalanceBigInt.toString(),
        requiredBalance: minBalance.toString(),
      });

      if (newBalanceBigInt >= minBalance) {
        logger.info('Balance recovered', {
          finalBalance: newBalanceBigInt.toString(),
        });
        return;
      }
    }

    // If we get here, balance didn't recover
    throw new InsufficientBalanceError(balanceBigInt, minBalance);
  }
}

/**
 * Process transaction receipt
 * @param tx - Queued transaction
 * @param response - Transaction response
 * @param receipt - Transaction receipt
 * @param logger - Logger instance
 * @param errorLogger - Error logger instance
 * @param db - Database instance for cleanup
 * @param cleanupFunction - Function to clean up queue items
 */
export async function processTransactionReceipt(
  tx: QueuedTransaction,
  response: ethers.ContractTransactionResponse,
  receipt: EthersTransactionReceipt | null,
  logger: Logger,
  errorLogger: ErrorLogger,
  cleanupFunction: (tx: QueuedTransaction, txHash: string) => Promise<void>,
): Promise<void> {
  const txHash = response.hash;

  try {
    if (receipt === null) {
      logger.warn('Transaction receipt is null, transaction may have failed', {
        txId: tx.id,
        txHash,
      });
      tx.status = TransactionStatus.FAILED;
      tx.error = new Error('Transaction receipt is null');
    } else if (receipt.status === 0) {
      logger.error('Transaction failed on-chain', {
        txId: tx.id,
        txHash,
        blockNumber: receipt.blockNumber,
      });
      errorLogger.error(new Error('Transaction failed on-chain'), {
        txId: tx.id,
        txHash,
        blockNumber: receipt.blockNumber,
      });
      tx.status = TransactionStatus.FAILED;
      tx.error = new Error('Transaction reverted on-chain');
    } else {
      logger.info('Transaction confirmed successfully', {
        txId: tx.id,
        txHash,
        blockNumber: receipt?.blockNumber,
        gasUsed: receipt?.gasUsed.toString(),
      });
      tx.status = TransactionStatus.CONFIRMED;
      tx.hash = txHash;
      // Store block number and gas used in transaction metadata
      if (!tx.metadata) {
        tx.metadata = {};
      }
      tx.metadata.blockNumber = receipt.blockNumber.toString();
      tx.metadata.gasUsed = receipt.gasUsed.toString();
    }

    // Process transaction in database if available
    await cleanupFunction(tx, txHash);
  } catch (error) {
    logger.error('Error processing transaction receipt', {
      error: error instanceof Error ? error.message : String(error),
      txId: tx.id,
      txHash,
    });
    errorLogger.error(
      error instanceof Error
        ? error
        : new Error(`Error processing transaction receipt: ${String(error)}`),
      { txId: tx.id, txHash },
    );
    tx.status = TransactionStatus.FAILED;
    tx.error = error as Error;
    // Still try to clean up queue
    try {
      await cleanupFunction(tx, txHash);
    } catch (cleanupError) {
      logger.error('Failed to clean up after receipt processing error', {
        error:
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
        txId: tx.id,
        txHash,
      });
      errorLogger.error(
        cleanupError instanceof Error
          ? cleanupError
          : new Error(
              `Failed to clean up after receipt processing: ${String(
                cleanupError,
              )}`,
            ),
        { txId: tx.id, txHash },
      );
    }
  }
}

/**
 * Handle execution errors
 * @param tx - Queued transaction
 * @param error - Error that occurred
 * @param logger - Logger instance
 * @param errorLogger - Error logger instance
 * @param cleanupFunction - Function to clean up queue items
 */
export async function handleExecutionError(
  tx: QueuedTransaction,
  error: unknown,
  logger: Logger,
  errorLogger: ErrorLogger,
  queue: Map<string, QueuedTransaction>,
  cleanupFunction: (tx: QueuedTransaction, txHash: string) => Promise<void>,
): Promise<void> {
  tx.status = TransactionStatus.FAILED;
  tx.error = error as Error;
  queue.set(tx.id, tx);

  const executorError = new Error(
    'Transaction execution failed',
  ) as GovLstExecutorError;
  executorError.context = {
    id: tx.id,
    depositIds: tx.depositIds.map(String),
    error: error instanceof Error ? error.message : String(error),
  };
  logger.error(RELAYER_EVENTS.ERROR, {
    ...executorError,
    ...executorError.context,
  });

  // Log with errorLogger
  errorLogger.error(error instanceof BaseError ? error : executorError, {
    stage: 'executeTransaction',
    txId: tx.id,
    depositIds: tx.depositIds.map(String),
    originalError: error instanceof Error ? error.message : String(error),
  });

  // Clean up queue items using the same method
  await cleanupFunction(tx, tx.hash || '');

  // Remove from in-memory queue
  queue.delete(tx.id);
}

/**
 * Queue a transaction with proper validation and setup
 * @param depositIds - Array of deposit IDs
 * @param profitability - Profitability check results
 * @param txData - Optional transaction data
 * @param config - Executor configuration
 * @param queue - Transaction queue
 * @param validateTx - Function to validate transaction
 * @param logger - Logger instance
 * @param errorLogger - Error logger instance
 * @param cleanupInProgress - Set of deposit IDs currently in cleanup
 * @returns Promise with queued transaction
 */
export async function queueTransactionWithValidation(
  depositIds: bigint[],
  profitability: GovLstProfitabilityCheck,
  txData: string | undefined,
  config: RelayerExecutorConfig,
  queue: Map<string, QueuedTransaction>,
  isRunning: boolean,
  validateTx: (
    depositIds: bigint[],
    profitability: GovLstProfitabilityCheck,
  ) => Promise<{ isValid: boolean; error: TransactionValidationError | null }>,
  logger: Logger,
  errorLogger: ErrorLogger,
  cleanupInProgress: Set<string>,
): Promise<QueuedTransaction> {
  if (!isRunning) {
    const error = new ExecutorError('Executor is not running', {}, false);
    errorLogger.error(error, { stage: 'queueTransaction' });
    throw error;
  }

  if (queue.size >= config.maxQueueSize) {
    const error = new ExecutorError(
      'Queue is full',
      {
        maxSize: config.maxQueueSize,
      },
      false,
    );
    errorLogger.error(error, {
      stage: 'queueTransaction',
      queueSize: queue.size,
      maxQueueSize: config.maxQueueSize,
    });
    throw error;
  }

  // Check if any of the deposit IDs are being cleaned up
  const depositIdStrings = depositIds.map(String);
  const isCleaningUp = depositIdStrings.some((id) => cleanupInProgress.has(id));
  if (isCleaningUp) {
    logger.info('Skipping queue transaction - cleanup in progress:', {
      depositIds: depositIdStrings,
    });
    logger.info('Skipping queue transaction - cleanup in progress', {
      depositIds: depositIdStrings,
    });
    return {
      id: '',
      depositIds,
      profitability,
      status: TransactionStatus.FAILED,
      createdAt: new Date(),
      error: new Error('Cleanup in progress'),
      tx_data: txData,
    };
  }

  // Validate the transaction
  const { isValid, error } = await validateTx(depositIds, profitability);
  if (!isValid) {
    logger.error(error ? error.message : 'Unknown validation error', {
      stage: 'validateTransaction',
      depositIds: depositIds.map(String),
    });
    throw error || new Error('Transaction validation failed');
  }

  const tx: QueuedTransaction = {
    id: uuidv4(),
    depositIds,
    profitability,
    status: TransactionStatus.QUEUED,
    createdAt: new Date(),
    tx_data: txData,
  };

  queue.set(tx.id, tx);
  logger.info(RELAYER_EVENTS.TRANSACTION_QUEUED, {
    id: tx.id,
    depositCount: depositIds.length,
    totalShares: profitability.estimates.total_shares.toString(),
    expectedProfit: profitability.estimates.expected_profit.toString(),
  });

  logger.info(`Transaction queued: ${tx.id}`, {
    id: tx.id,
    depositCount: depositIds.length,
    totalShares: profitability.estimates.total_shares.toString(),
    expectedProfit: profitability.estimates.expected_profit.toString(),
  });

  return tx;
}

/**
 * Calculate optimal threshold for profitability
 * @param payoutAmount - Base payout amount
 * @param gasCost - Estimated gas cost
 * @param profitMargin - Profit margin in percentage
 * @param logger - Logger instance
 * @returns Optimal threshold value
 */
export function calculateOptimalThreshold(
  payoutAmount: bigint,
  gasCost: bigint,
  profitMargin: number,
  logger: Logger,
): bigint {
  if (typeof profitMargin !== 'number' || isNaN(profitMargin)) {
    throw new Error(`Invalid profit margin value: ${profitMargin}`);
  }

  // Convert profit margin to basis points
  const profitMarginBasisPoints = BigInt(Math.floor(profitMargin * 100));

  // Calculate base amount and profit margin amount
  const baseAmount = payoutAmount + gasCost;
  const profitMarginAmount = (baseAmount * profitMarginBasisPoints) / 10000n;

  // Calculate final threshold
  const optimalThreshold = payoutAmount + gasCost + profitMarginAmount;

  logger.info('Calculated optimal threshold:', {
    payoutAmount: payoutAmount.toString(),
    gasCost: gasCost.toString(),
    profitMargin: `${profitMargin}%`,
    profitMarginAmount: profitMarginAmount.toString(),
    optimalThreshold: optimalThreshold.toString(),
  });

  return optimalThreshold;
}

/**
 * Process the transaction queue
 * @param isPeriodicCheck - Whether this is a periodic check
 * @param isRunning - Whether the executor is running
 * @param config - Executor configuration
 * @param provider - Ethereum provider
 * @param queue - Transaction queue
 * @param executeTransaction - Function to execute a transaction
 * @param logger - Logger instance
 * @param errorLogger - Error logger instance
 */
export async function processQueue(
  isPeriodicCheck: boolean,
  isRunning: boolean,
  config: RelayerExecutorConfig,
  provider: ethers.Provider,
  queue: Map<string, QueuedTransaction>,
  executeTransaction: (tx: QueuedTransaction) => Promise<void>,
  logger: Logger,
  errorLogger: ErrorLogger,
  db?: DatabaseWrapper,
): Promise<void> {
  if (!isRunning) {
    return;
  }

  try {
    logger.info('Starting queue processing cycle', {
      isPeriodicCheck,
      queueSize: queue.size,
      timestamp: new Date().toISOString(),
    });

    // Run stale transaction cleanup (default 5 minutes)
    const staleThresholdMinutes = config.staleTransactionThresholdMinutes || 5;
    const cleanupResult = await cleanupStaleTransactions(
      queue,
      staleThresholdMinutes,
      db,
      logger,
      errorLogger,
    );

    if (cleanupResult.staleCount > 0) {
      logger.info('Cleaned up stale transactions', {
        staleCount: cleanupResult.staleCount,
        cleanedIds: cleanupResult.cleanedIds,
      });
    }

    if (!provider) {
      const error = new ExecutorError('Provider not initialized', {}, false);
      errorLogger.error(error, { stage: 'processQueue' });
      throw error;
    }

    // Check and wait for balance recovery
    try {
      await checkAndWaitForBalance(
        provider,
        config.address,
        config.minBalance,
        logger,
      );
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        // Handle stuck transactions
        const queuedTxs = Array.from(queue.values()).filter(
          (tx) => tx.status === TransactionStatus.QUEUED,
        );

        if (queuedTxs.length > 0) {
          logger.warn(
            'Clearing stuck transactions due to insufficient balance',
            {
              queuedTransactions: queuedTxs.length,
              error: error instanceof Error ? error.message : String(error),
            },
          );
          errorLogger.warn(
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
                // Clean up logic would go here
                queue.delete(tx.id);
              } catch (cleanupError) {
                logger.error('Failed to clean up stuck transaction', {
                  error:
                    cleanupError instanceof Error
                      ? cleanupError.message
                      : String(cleanupError),
                  txId: tx.id,
                });
                errorLogger.error(
                  cleanupError instanceof Error
                    ? cleanupError
                    : new Error(String(cleanupError)),
                  {
                    stage: 'cleanupStuckTransaction',
                    txId: tx.id,
                  },
                );
              }
            }),
          );
        }
        errorLogger.error(error, {
          stage: 'processQueue',
          balance:
            error instanceof InsufficientBalanceError
              ? error.context.currentBalance
              : 'unknown',
          required:
            error instanceof InsufficientBalanceError
              ? error.context.requiredBalance
              : 'unknown',
        });
        throw error;
      }
      errorLogger.error(
        error instanceof Error ? error : new Error(String(error)),
        { stage: 'processQueue' },
      );
      throw error;
    }

    const pendingTxs = Array.from(queue.values()).filter(
      (tx) => tx.status === TransactionStatus.PENDING,
    );
    if (pendingTxs.length >= config.maxPendingTransactions) {
      const error = new ExecutorError(
        'Max pending transactions reached',
        {
          maxPending: config.maxPendingTransactions,
        },
        false,
      );
      errorLogger.error(error, {
        stage: 'processQueue',
        pendingCount: pendingTxs.length,
        maxPending: config.maxPendingTransactions,
      });
      throw error;
    }

    const queuedTxs = Array.from(queue.values())
      .filter((tx) => tx.status === TransactionStatus.QUEUED)
      .slice(0, config.concurrentTransactions - pendingTxs.length);

    if (queuedTxs.length === 0) {
      if (!isPeriodicCheck) {
        logger.debug('No queued transactions to process');
      }
      return;
    }

    await Promise.all(queuedTxs.map((tx) => executeTransaction(tx)));
  } catch (error) {
    logger.error('Failed to process queue', {
      error: error instanceof Error ? error.message : String(error),
      isPeriodicCheck,
      queueSize: queue.size,
    });
    errorLogger.error(
      error instanceof Error ? error : new Error(String(error)),
      {
        stage: 'processQueue',
        isPeriodicCheck,
        queueSize: queue.size,
      },
    );
  }
}

/**
 * Transfer out tips to a receiver
 * @param config - Executor configuration
 * @param provider - Ethereum provider
 * @param signer - Ethereum signer
 * @param logger - Logger instance
 * @param errorLogger - Error logger instance
 * @returns Transaction receipt if successful
 */
export async function transferOutTips(
  config: RelayerExecutorConfig,
  provider: ethers.Provider,
  signer: ethers.Signer,
  logger: Logger,
  errorLogger: ErrorLogger,
): Promise<TransactionReceipt | null> {
  if (!config.defaultTipReceiver) {
    const error = new TransactionValidationError('No tip receiver configured', {
      config: config,
    });
    errorLogger.error(error, { stage: 'transferOutTips' });
    throw error;
  }

  // Get relayer balance
  const balance = await provider.getBalance(config.address);
  const balanceBigInt = BigInt(balance.toString());

  if (balanceBigInt < config.minBalance) {
    return null;
  }

  try {
    // Use signer to send transaction
    const tx = await signer.sendTransaction({
      to: config.defaultTipReceiver,
      value: balanceBigInt - config.minBalance,
    });

    logger.info('Tip transfer transaction submitted', {
      hash: tx.hash,
      amount: ethers.formatEther(balanceBigInt - config.minBalance),
      receiver: config.defaultTipReceiver,
    });

    logger.info('Waiting for tip transfer transaction...');
    const receipt = await tx.wait();

    logger.info(RELAYER_EVENTS.TIPS_TRANSFERRED, {
      amount: ethers.formatEther(balanceBigInt - config.minBalance),
      receiver: config.defaultTipReceiver,
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
    logger.error('Failed to transfer tips', {
      error: error instanceof Error ? error.message : String(error),
    });
    errorLogger.error(
      error instanceof Error
        ? error
        : new Error(`Failed to transfer tips: ${String(error)}`),
      { stage: 'transferOutTips' },
    );
    throw error;
  }
}

/**
 * Cleans up stale transactions from the queues
 * This handles transactions that may have gotten stuck due to errors
 * @param queue Map of queued transactions
 * @param staleThresholdMinutes Time in minutes after which a transaction is considered stale
 * @param db Database wrapper for queue updates
 * @param logger Logger instance
 * @param errorLogger Error logger instance for detailed error reporting
 * @returns Object containing counts of removed items
 */
export async function cleanupStaleTransactions(
  queue: Map<string, QueuedTransaction>,
  staleThresholdMinutes: number,
  db?: DatabaseWrapper,
  logger?: Logger,
  errorLogger?: ErrorLogger,
): Promise<{ staleCount: number; cleanedIds: string[] }> {
  const staleIds: string[] = [];
  const now = new Date();

  // Increase the minimum stale threshold to 10 minutes
  const effectiveStaleThreshold = Math.max(10, staleThresholdMinutes);
  const staleThresholdMs = effectiveStaleThreshold * 60 * 1000;
  let databaseStaleCount = 0;

  if (logger) {
    logger.info('Starting stale transaction cleanup', {
      queueSize: queue.size,
      staleThresholdMinutes: effectiveStaleThreshold,
      timestamp: now.toISOString(),
    });
  }

  // First, clean up in-memory queue - but only clear failed or truly stale transactions
  for (const [txId, tx] of queue.entries()) {
    const txTime = tx.createdAt || new Date(0);
    const elapsedMs = now.getTime() - txTime.getTime();

    // Only remove queued transactions if they're very stale (> staleThresholdMs)
    // For pending transactions, be more conservative and double the threshold
    const isStale =
      tx.status === TransactionStatus.QUEUED
        ? elapsedMs > staleThresholdMs
        : tx.status === TransactionStatus.PENDING
          ? elapsedMs > staleThresholdMs * 2 // Double threshold for pending transactions
          : elapsedMs > staleThresholdMs;

    if (isStale) {
      staleIds.push(txId);

      if (logger) {
        logger.warn('Found stale transaction in memory', {
          id: txId,
          status: tx.status,
          createdAt: txTime.toISOString(),
          ageMinutes: Math.floor(elapsedMs / 60000),
          depositIds: tx.depositIds.map(String),
          threshold:
            tx.status === TransactionStatus.PENDING
              ? `${effectiveStaleThreshold * 2} minutes (doubled for pending tx)`
              : `${effectiveStaleThreshold} minutes`,
        });
      }

      // Remove from in-memory queue
      queue.delete(txId);
    }
  }

  // Now directly clean up database, regardless of in-memory state
  if (db) {
    try {
      // EMERGENCY CLEANUP: Clean up any transaction queue items for depositId 1 (which completed successfully)
      try {
        const completedItem = await db.getTransactionQueueItemByDepositId('1');
        if (completedItem) {
          if (logger) {
            logger.info(
              'Found completed but stuck transaction queue item for depositId 1',
              {
                id: completedItem.id,
                status: completedItem.status,
                hash: completedItem.hash || 'unknown',
              },
            );
          }

          // Delete the item
          await db.deleteTransactionQueueItem(completedItem.id);
          databaseStaleCount++;

          if (logger) {
            logger.info(
              'Deleted stuck transaction queue item for depositId 1',
              {
                id: completedItem.id,
              },
            );
          }
        }
      } catch (emergencyError) {
        if (logger) {
          logger.error('Failed emergency cleanup for depositId 1', {
            error:
              emergencyError instanceof Error
                ? emergencyError.message
                : String(emergencyError),
          });
        }
      }

      // 1. Clean up transaction queue - only if stale
      const allTxItems = await db.getTransactionQueueItemsByStatus(
        TransactionQueueStatus.PENDING,
      );

      if (logger) {
        logger.info('Found transaction queue items to check for staleness', {
          count: allTxItems.length,
        });
      }

      for (const item of allTxItems) {
        try {
          const createdAt = new Date(item.created_at);
          const elapsedMs = now.getTime() - createdAt.getTime();

          // Make sure it's actually stale (2x threshold for pending items)
          if (elapsedMs > staleThresholdMs * 2) {
            // This is a stale item, mark it as failed and then delete it
            await db.updateTransactionQueueItem(item.id, {
              status: TransactionQueueStatus.FAILED,
              error: `Transaction timed out after ${effectiveStaleThreshold * 2} minutes`,
            });

            await db.deleteTransactionQueueItem(item.id);
            databaseStaleCount++;

            if (logger) {
              logger.info('Cleaned up stale transaction queue item', {
                id: item.id,
                depositId: item.deposit_id,
                createdAt: item.created_at,
                ageMinutes: Math.floor(elapsedMs / 60000),
                threshold: `${effectiveStaleThreshold * 2} minutes (doubled for pending tx)`,
              });
            }
          }
        } catch (itemError) {
          if (logger) {
            logger.error('Failed to clean up transaction queue item', {
              error:
                itemError instanceof Error
                  ? itemError.message
                  : String(itemError),
              itemId: item.id,
            });
          }

          if (errorLogger) {
            await errorLogger
              .error(
                itemError instanceof Error
                  ? itemError
                  : new Error(
                      `Failed to clean up transaction queue item: ${String(itemError)}`,
                    ),
                {
                  context: 'cleanup-stale-transaction-queue-item',
                  itemId: item.id,
                },
              )
              .catch(console.error);
          }
        }
      }

      // 2. Clean up processing queue - only if truly stale
      const allProcessingItems = await db.getProcessingQueueItemsByStatus(
        ProcessingQueueStatus.PENDING,
      );

      if (logger) {
        logger.info('Found processing queue items to check for staleness', {
          count: allProcessingItems.length,
        });
      }

      for (const item of allProcessingItems) {
        try {
          const createdAt = new Date(item.created_at);
          const elapsedMs = now.getTime() - createdAt.getTime();

          // Use 2x threshold for processing items too
          if (elapsedMs > staleThresholdMs * 2) {
            // This is a stale item, mark it as failed and then delete it
            await db.updateProcessingQueueItem(item.id, {
              status: ProcessingQueueStatus.FAILED,
              error: `Processing timed out after ${effectiveStaleThreshold * 2} minutes`,
            });

            await db.deleteProcessingQueueItem(item.id);
            databaseStaleCount++;

            if (logger) {
              logger.info('Cleaned up stale processing queue item', {
                id: item.id,
                depositId: item.deposit_id,
                createdAt: item.created_at,
                ageMinutes: Math.floor(elapsedMs / 60000),
                threshold: `${effectiveStaleThreshold * 2} minutes (doubled for processing items)`,
              });
            }
          }
        } catch (itemError) {
          if (logger) {
            logger.error('Failed to clean up processing queue item', {
              error:
                itemError instanceof Error
                  ? itemError.message
                  : String(itemError),
              itemId: item.id,
            });
          }

          if (errorLogger) {
            await errorLogger
              .error(
                itemError instanceof Error
                  ? itemError
                  : new Error(
                      `Failed to clean up processing queue item: ${String(itemError)}`,
                    ),
                {
                  context: 'cleanup-stale-processing-queue-item',
                  itemId: item.id,
                },
              )
              .catch(console.error);
          }
        }
      }
    } catch (dbError) {
      if (logger) {
        logger.error(
          'Failed to access database for stale transaction cleanup',
          {
            error: dbError instanceof Error ? dbError.message : String(dbError),
          },
        );
      }

      if (errorLogger) {
        await errorLogger
          .error(
            dbError instanceof Error
              ? dbError
              : new Error(`Database access error: ${String(dbError)}`),
            {
              context: 'cleanup-stale-transactions-db-access',
            },
          )
          .catch(console.error);
      }
    }
  }

  const totalStaleCount = staleIds.length + databaseStaleCount;

  if (logger) {
    logger.info('Stale transaction cleanup completed', {
      inMemoryStaleCount: staleIds.length,
      databaseStaleCount,
      totalStaleCount,
      cleanedIds: staleIds,
      remainingQueueSize: queue.size,
    });
  }

  return { staleCount: totalStaleCount, cleanedIds: staleIds };
}
