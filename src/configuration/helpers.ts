import { ethers } from 'ethers';
import {
  QueuedTransaction,
  TransactionStatus,
  QueueStats,
} from '@/executor/interfaces/types';
import { TransactionType } from '@/database/interfaces/types';
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
    // Scale gas limit based on deposit count with progressive scaling
    // Base calculation
    const baseGas = Number(gasEstimate);

    // Calculate additional gas per deposit with progressive scaling
    // Start with 50k gas per deposit and increase by 10k for each additional deposit
    const basePerDeposit = 50000;
    const progressiveIncrease = 10000;
    let totalAdditionalGas = 0;

    for (let i = 0; i < depositCount; i++) {
      totalAdditionalGas += basePerDeposit + i * progressiveIncrease;
    }

    // Apply dynamic buffer based on deposit count
    // Increase buffer percentage as deposit count grows
    const baseBuffer = EXECUTOR.GAS.GAS_LIMIT_BUFFER; // e.g. 1.3 for 30%
    const extraBufferPerDeposit = 0.1; // Add 10% per deposit
    const dynamicBuffer =
      baseBuffer + (depositCount - 1) * extraBufferPerDeposit;

    // Calculate final gas limit with all factors
    const bufferedBaseGas = Math.ceil(baseGas * dynamicBuffer);
    gasLimit = BigInt(bufferedBaseGas + totalAdditionalGas);

    logger.info('Gas limit calculation details', {
      baseGas,
      totalAdditionalGas,
      dynamicBuffer,
      bufferedBaseGas,
      finalGasLimit: gasLimit.toString(),
    });
  } catch (error) {
    // If conversion fails, use a safe default with progressive scaling
    logger.warn('Error calculating gas limit, using safe default', {
      error: error instanceof Error ? error.message : String(error),
      gasEstimate: gasEstimate.toString(),
      depositCount,
    });

    // Safe default calculation with progressive scaling
    const safeBaseGas = Number(EXECUTOR.GAS.MIN_GAS_LIMIT) * 2;
    const safeAdditionalGas = depositCount * 75000; // 75k gas per deposit for safety
    gasLimit = BigInt(safeBaseGas + safeAdditionalGas);
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
 * Polls for a transaction receipt with retries
 */
export async function pollForReceipt(
  txHash: string,
  provider: ethers.Provider,
  logger: Logger,
  confirmations: number = 1,
): Promise<EthersTransactionReceipt | null> {
  const maxAttempts = 30; // Try for about 5 minutes with 10-second intervals
  const pollingInterval = 10000; // 10 seconds

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Get receipt
      const receipt = (await provider.getTransactionReceipt(
        txHash,
      )) as unknown as EthersTransactionReceipt;

      if (!receipt) {
        // If no receipt yet, wait and try again
        await new Promise((resolve) => setTimeout(resolve, pollingInterval));
        continue;
      }

      // Check if we have enough confirmations
      const currentBlock = await provider.getBlockNumber();
      const receiptConfirmations = currentBlock - receipt.blockNumber + 1;

      if (receiptConfirmations >= confirmations) {
        return receipt;
      }

      // Not enough confirmations, wait and try again
      await new Promise((resolve) => setTimeout(resolve, pollingInterval));
    } catch (error) {
      logger.warn('Error polling for receipt', {
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

  // Try to extract metadata from transaction object
  if (tx.metadata?.queueItemId) {
    queueItemId = tx.metadata.queueItemId;
    depositIds = tx.metadata.depositIds || [];
  } else if (tx.tx_data) {
    try {
      const txData = JSON.parse(tx.tx_data);
      queueItemId = txData.queueItemId;
      depositIds = txData.depositIds?.map(String) || [];
    } catch (error) {
      // tx_data might be raw contract call data, not JSON metadata
      console.debug('tx_data is not JSON metadata, treating as contract call data');
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
    totalItems: transactions.length,
    pendingItems: pending.length,
    failedItems: failed.length,
    byType: {
      [TransactionType.BUMP]: {
        total: 0,
        pending: 0,
        submitted: 0,
        confirmed: 0,
        failed: 0,
      },
      [TransactionType.CLAIM_AND_DISTRIBUTE]: {
        total: transactions.length,
        pending: pending.length,
        submitted: 0,
        confirmed: confirmed.length,
        failed: failed.length,
        averageGasPrice: confirmed.length
          ? totalGasPrice / BigInt(confirmed.length)
          : 0n,
        averageGasLimit: confirmed.length
          ? totalGasLimit / BigInt(confirmed.length)
          : 0n,
        totalProfits,
      },
    },
  };
}
