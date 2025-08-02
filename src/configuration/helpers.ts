import { ethers } from 'ethers';
import {
  QueuedTransaction,
  TransactionStatus,
  QueueStats,
} from '@/executor/interfaces/types';
import { GovLstProfitabilityCheck } from '@/profitability/interfaces/types';
import { Logger } from '@/monitor/logging';
import { EXECUTOR } from './constants';
import { EthersTransactionReceipt } from '@/executor/interfaces/types';

/**
 * Calculates gas limit for a transaction with appropriate buffers
 */
export function calculateGasLimit(
  gasEstimate: bigint,
  depositCount: number = 1,
  logger: Logger,
): bigint {
  logger.info('Calculating gas limit', {
    baseGasEstimate: gasEstimate.toString(),
    depositCount,
    buffer: EXECUTOR.GAS.GAS_LIMIT_BUFFER,
    minGasLimit: EXECUTOR.GAS.MIN_GAS_LIMIT.toString(),
    maxGasLimit: EXECUTOR.GAS.MAX_GAS_LIMIT.toString(),
  });

  let gasLimit: bigint;
  try {
    // Calculate base gas using real transaction data analysis
    const baseGasPerDeposit = EXECUTOR.GAS.BASE_GAS_PER_DEPOSIT;
    const additionalGasPerDeposit = EXECUTOR.GAS.ADDITIONAL_GAS_PER_DEPOSIT;

    // Calculate total gas based on deposit count with progressive scaling
    let totalGas = BigInt(0);
    for (let i = 0; i < depositCount; i++) {
      // Base gas for each deposit
      totalGas += baseGasPerDeposit;

      // Add progressive additional gas for each deposit after the first
      if (i > 0) {
        totalGas += additionalGasPerDeposit;
      }
    }

    // Apply standard buffer
    let bufferedGas =
      (totalGas * BigInt(Math.floor(EXECUTOR.GAS.GAS_LIMIT_BUFFER * 100))) /
      100n;

    // Add reentrancy protection buffer for large batches
    if (depositCount >= EXECUTOR.GAS.REENTRANCY_THRESHOLD) {
      bufferedGas =
        (bufferedGas *
          BigInt(Math.floor(EXECUTOR.GAS.REENTRANCY_BUFFER * 100))) /
        100n;
      logger.info('Added reentrancy protection buffer', {
        originalGas: totalGas.toString(),
        withReentrancyBuffer: bufferedGas.toString(),
      });
    }

    gasLimit = bufferedGas;

    logger.info('Gas limit calculation details', {
      baseGasPerDeposit: baseGasPerDeposit.toString(),
      additionalGasPerDeposit: additionalGasPerDeposit.toString(),
      totalBaseGas: totalGas.toString(),
      bufferedGas: bufferedGas.toString(),
      finalGasLimit: gasLimit.toString(),
      depositCount,
      hasReentrancyBuffer: depositCount >= EXECUTOR.GAS.REENTRANCY_THRESHOLD,
    });
  } catch (error) {
    // If calculation fails, use a safe default based on real data
    logger.warn('Error calculating gas limit, using safe default', {
      error: error instanceof Error ? error.message : String(error),
      gasEstimate: gasEstimate.toString(),
      depositCount,
    });

    // Safe default: Use base gas per deposit * deposit count + 30% buffer
    const safeGas = EXECUTOR.GAS.BASE_GAS_PER_DEPOSIT * BigInt(depositCount);
    gasLimit = (safeGas * 130n) / 100n;
  }

  // Apply bounds
  if (gasLimit < EXECUTOR.GAS.MIN_GAS_LIMIT) {
    logger.info('Gas limit below minimum, using minimum value', {
      calculatedLimit: gasLimit.toString(),
      minLimit: EXECUTOR.GAS.MIN_GAS_LIMIT.toString(),
    });
    return EXECUTOR.GAS.MIN_GAS_LIMIT;
  } else if (gasLimit > EXECUTOR.GAS.MAX_GAS_LIMIT) {
    logger.info('Gas limit above maximum, using maximum value', {
      calculatedLimit: gasLimit.toString(),
      maxLimit: EXECUTOR.GAS.MAX_GAS_LIMIT.toString(),
    });
    return EXECUTOR.GAS.MAX_GAS_LIMIT;
  }

  logger.info('Final gas limit calculated', {
    finalGasLimit: gasLimit.toString(),
    depositCount,
  });

  return gasLimit;
}

/**
 * Polls for a transaction receipt with exponential backoff
 */
export async function pollForReceipt(
  txHash: string,
  provider: ethers.Provider,
  logger: Logger,
  confirmations: number = 1,
): Promise<EthersTransactionReceipt | null> {
  const maxAttempts = 15; // Reduced from 30
  const initialPollingInterval = 3000; // Start with 3 seconds
  const maxPollingInterval = 30000; // Cap at 30 seconds
  const backoffMultiplier = 1.5; // Exponential backoff factor

  let pollingInterval = initialPollingInterval;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Get receipt
      const receipt = (await provider.getTransactionReceipt(
        txHash,
      )) as unknown as EthersTransactionReceipt;

      if (!receipt) {
        // If no receipt yet, wait with exponential backoff
        logger.debug('Transaction receipt not found, retrying with backoff', {
          txHash,
          attempt: attempt + 1,
          nextPollingIntervalMs: pollingInterval,
        });
        await new Promise((resolve) => setTimeout(resolve, pollingInterval));

        // Increase polling interval for next attempt (exponential backoff)
        pollingInterval = Math.min(
          pollingInterval * backoffMultiplier,
          maxPollingInterval,
        );
        continue;
      }

      // Check if we have enough confirmations
      const currentBlock = await provider.getBlockNumber();
      const receiptConfirmations = currentBlock - receipt.blockNumber + 1;

      if (receiptConfirmations >= confirmations) {
        logger.info('Transaction confirmed', {
          txHash,
          blockNumber: receipt.blockNumber,
          confirmations: receiptConfirmations,
          attemptsTaken: attempt + 1,
        });
        return receipt;
      }

      // Not enough confirmations, wait with current interval (no backoff for confirmations)
      logger.debug('Waiting for confirmations', {
        txHash,
        currentConfirmations: receiptConfirmations,
        requiredConfirmations: confirmations,
      });
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(pollingInterval, 5000)),
      ); // Cap confirmation polling at 5s
    } catch (error) {
      logger.warn('Error polling for receipt', {
        error: error instanceof Error ? error.message : String(error),
        txHash,
        attempt: attempt + 1,
        nextPollingIntervalMs: pollingInterval,
      });

      // Wait with exponential backoff on error
      await new Promise((resolve) => setTimeout(resolve, pollingInterval));
      pollingInterval = Math.min(
        pollingInterval * backoffMultiplier,
        maxPollingInterval,
      );
    }
  }

  throw new Error(
    `Transaction ${txHash} not confirmed after ${maxAttempts} attempts`,
  );
}

/**
 * Validates a transaction before execution
 */
export async function validateTransaction(
  depositIds: bigint[],
  profitability: GovLstProfitabilityCheck,
  queue: Map<string, QueuedTransaction>,
): Promise<{ isValid: boolean; error: Error | null }> {
  // Check for existing transactions with the same deposit IDs
  const transactions = Array.from(queue.values());
  const depositIdsStrings = depositIds.map(String);
  const existingTransaction = transactions.find((tx) => {
    // Check both queued and pending transactions
    if (
      tx.status !== TransactionStatus.QUEUED &&
      tx.status !== TransactionStatus.PENDING
    )
      return false;
    // Check if any of the deposit IDs overlap
    return tx.depositIds.some((id) =>
      depositIdsStrings.includes(id.toString()),
    );
  });

  if (existingTransaction) {
    return {
      isValid: false,
      error: new Error(
        'One or more deposits are already in a pending transaction',
      ),
    };
  }

  if (depositIds.length > EXECUTOR.QUEUE.MAX_BATCH_SIZE) {
    return {
      isValid: false,
      error: new Error(
        `Batch size exceeds maximum of ${EXECUTOR.QUEUE.MAX_BATCH_SIZE}`,
      ),
    };
  }

  if (depositIds.length < EXECUTOR.QUEUE.MIN_BATCH_SIZE) {
    return {
      isValid: false,
      error: new Error(
        `Batch size below minimum of ${EXECUTOR.QUEUE.MIN_BATCH_SIZE}`,
      ),
    };
  }

  return {
    isValid: true,
    error: null,
  };
}

/**
 * Extracts queue item information from transaction data
 */
export function extractQueueItemInfo(tx: QueuedTransaction): {
  queueItemId?: string;
  depositIds: string[];
} {
  let queueItemId: string | undefined;
  let depositIds: string[] = [];

  if (tx.tx_data) {
    try {
      const txData = JSON.parse(tx.tx_data);
      queueItemId = txData.queueItemId;
      depositIds = txData.depositIds?.map(String) || [];
    } catch (error) {
      // If parsing fails, return empty values
      console.error('Failed to parse txData:', error);
    }
  }

  return { queueItemId, depositIds };
}

/**
 * Calculates queue statistics from a collection of transactions
 */
export function calculateQueueStats(
  transactions: QueuedTransaction[],
): QueueStats {
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
