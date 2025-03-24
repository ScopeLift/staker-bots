import { ethers } from 'ethers';
import {
  ClaimBatch,
  GovLstClaimerConfig,
  ProfitabilityCalculation
} from '../interfaces/types';
import { calculateTotalRewards } from './rewardCalculator';
import { ConsoleLogger, Logger } from '@/monitor/logging';

/**
 * Calculate gas cost for a claim operation
 */
export function calculateGasCost(
  batchSize: number,
  gasPrice: bigint,
  gasPerClaim: bigint = BigInt(300000) // Default gas estimate per claim
): bigint {
  // Base gas cost for transaction
  const baseGas = BigInt(100000);

  // Gas per deposit in batch
  const batchGas = gasPerClaim * BigInt(batchSize);

  // Total gas
  const totalGas = baseGas + batchGas;

  // Cost in wei
  return totalGas * gasPrice;
}

/**
 * Calculate whether a batch of deposits is profitable to claim
 */
export function calculateProfitability(
  batch: string[],
  depositRewards: Map<string, bigint>,
  payoutAmount: bigint,
  gasPrice: bigint,
  config: {
    gasPriceBuffer: number;
    minProfitMargin: bigint;
  },
  logger: Logger = new ConsoleLogger('info')
): ProfitabilityCalculation {
  // If gas price is not available, we can't calculate profitability
  if (gasPrice === BigInt(0)) {
    return {
      isGasPriceAvailable: false,
      gasPrice: BigInt(0),
      gasCostPerClaim: BigInt(0),
      gasCostPerBatch: BigInt(0),
      tokenValueOfGas: BigInt(0),
      profitPerDeposit: BigInt(0),
      isProfitable: false,
    };
  }

  // Apply gas price buffer
  const bufferedGasPrice = gasPrice * BigInt(100 + config.gasPriceBuffer) / BigInt(100);

  // Calculate gas cost per claim and per batch
  const gasCostPerClaim = BigInt(300000); // Estimated gas per claim
  const gasCostPerBatch = calculateGasCost(batch.length, bufferedGasPrice, gasCostPerClaim);

  // Calculate total rewards
  const totalRewards = calculateTotalRewards(batch, depositRewards);

  // Calculate profit (rewards - gas cost - payout)
  const profit = totalRewards - gasCostPerBatch - payoutAmount;

  // Calculate profit per deposit
  const profitPerDeposit = batch.length > 0
    ? profit / BigInt(batch.length)
    : BigInt(0);

  // Determine if profitable
  const isProfitable = profit >= config.minProfitMargin;

  logger.debug('Profitability calculation:', {
    batchSize: batch.length,
    totalRewards: totalRewards.toString(),
    gasPrice: bufferedGasPrice.toString(),
    gasCost: gasCostPerBatch.toString(),
    payoutAmount: payoutAmount.toString(),
    profit: profit.toString(),
    isProfitable,
  });

  return {
    isGasPriceAvailable: true,
    gasPrice: bufferedGasPrice,
    gasCostPerClaim,
    gasCostPerBatch,
    tokenValueOfGas: gasCostPerBatch, // Assuming 1:1 conversion
    profitPerDeposit,
    isProfitable,
  };
}

/**
 * Group deposits into batches for maximum profit
 */
export function groupDepositsForMaximumProfit(
  depositIds: string[],
  depositRewards: Map<string, bigint>,
  payoutAmount: bigint,
  gasPrice: bigint,
  config: {
    maxBatchSize: number;
    gasPriceBuffer: number;
    minProfitMargin: bigint;
  },
  logger: Logger = new ConsoleLogger('info')
): ClaimBatch[] {
  const batches: ClaimBatch[] = [];

  // Start with most profitable deposits
  let currentBatch: string[] = [];
  let currentBatchReward = BigInt(0);

  // Keep track of deposits that have been added to batches
  const processedDeposits = new Set<string>();

  // Process deposits in chunks according to max batch size
  for (let i = 0; i < depositIds.length; i++) {
    const depositId = depositIds[i];

    // Skip if already processed or depositId is undefined
    if (!depositId || processedDeposits.has(depositId)) continue;

    const reward = depositRewards.get(depositId) || BigInt(0);

    // If batch is full or this is the first deposit in a new batch
    if (currentBatch.length >= config.maxBatchSize || currentBatch.length === 0) {
      // If we have a batch to evaluate
      if (currentBatch.length > 0) {
        // Check profitability of current batch
        const profitability = calculateProfitability(
          currentBatch,
          depositRewards,
          payoutAmount,
          gasPrice,
          config,
          logger
        );

        // If profitable, add to batches
        if (profitability.isProfitable) {
          batches.push({
            depositIds: [...currentBatch], // Create a copy to avoid reference issues
            estimatedReward: currentBatchReward,
            estimatedGasCost: profitability.gasCostPerBatch,
            estimatedProfit: currentBatchReward - payoutAmount - profitability.gasCostPerBatch,
          });

          // Mark deposits as processed
          currentBatch.forEach(id => processedDeposits.add(id));
        }
      }

      // Start new batch with current deposit
      currentBatch = [depositId];
      currentBatchReward = reward;
    } else {
      // Add to current batch
      currentBatch.push(depositId);
      currentBatchReward += reward;
    }
  }

  // Process final batch if it exists
  if (currentBatch.length > 0) {
    // Check profitability of final batch
    const profitability = calculateProfitability(
      currentBatch,
      depositRewards,
      payoutAmount,
      gasPrice,
      config,
      logger
    );

    // If profitable, add to batches
    if (profitability.isProfitable) {
      batches.push({
        depositIds: [...currentBatch], // Create a copy to avoid reference issues
        estimatedReward: currentBatchReward,
        estimatedGasCost: profitability.gasCostPerBatch,
        estimatedProfit: currentBatchReward - payoutAmount - profitability.gasCostPerBatch,
      });
    }
  }

  logger.info('Batch optimization complete:', {
    totalDeposits: depositIds.length,
    profitableBatches: batches.length,
    totalProfitableDeposits: batches.reduce((sum, batch) => sum + batch.depositIds.length, 0),
  });

  return batches;
}
