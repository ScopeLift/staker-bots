import { IProfitabilityEngine } from '../interfaces/IProfitabilityEngine';
import { IExecutor } from '../../executor/interfaces/IExecutor';
import { IDatabase } from '../../database/interfaces/IDatabase';
import { BaseProfitabilityEngine } from './BaseProfitabilityEngine';
import { CalculatorWrapper } from '../../calculator/CalculatorWrapper';
import { Deposit, ProcessingQueueItem } from '../../database/interfaces/types';
import {
  ProfitabilityQueueBatchResult,
  ProfitabilityQueueResult,
} from '../interfaces/types';
import { ConsoleLogger } from '../../monitor/logging';
import { CONFIG } from '../../configuration';
import { GasCostEstimator } from '../../prices/GasCostEstimator';
import { ethers } from 'ethers';
import { BinaryEligibilityOracleEarningPowerCalculator } from '../../calculator';
import { IPriceFeed } from '../../shared/price-feeds/interfaces';
import { ProfitabilityConfig } from '../interfaces/types';

// Enhanced logger with more detailed output
const logger = new ConsoleLogger('debug', {
  prefix: '[BUMP ENGINE]',
});

export class RariBumpEarningPowerEngine
  extends BaseProfitabilityEngine
  implements IProfitabilityEngine
{
  private calculatorWrapper: CalculatorWrapper;
  private gasCostEstimator: GasCostEstimator;
  protected database: IDatabase;
  protected executor: IExecutor;
  private periodicCheckInterval: NodeJS.Timeout | null = null;
  protected isRunning = false;
  private readonly PERIODIC_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
  protected lastUpdateTimestamp: number;

  constructor(params: {
    database: IDatabase;
    executor: IExecutor;
    calculatorWrapper: CalculatorWrapper;
    calculator: BinaryEligibilityOracleEarningPowerCalculator;
    stakerContract: ethers.Contract & {
      deposits(depositId: bigint): Promise<{
        owner: string;
        balance: bigint;
        earningPower: bigint;
        delegatee: string;
        claimer: string;
      }>;
      unclaimedReward(depositId: bigint): Promise<bigint>;
      maxBumpTip(): Promise<bigint>;
      bumpEarningPower(
        depositId: bigint,
        tipReceiver: string,
        tip: bigint,
      ): Promise<bigint>;
      REWARD_TOKEN(): Promise<string>;
    };
    provider: ethers.Provider;
    config: ProfitabilityConfig;
    priceFeed: IPriceFeed;
    gasPriceMultiplier?: number;
    maxGasPrice?: string;
  }) {
    super(
      params.calculator,
      params.stakerContract,
      params.provider,
      params.config,
      params.priceFeed,
    );
    this.calculatorWrapper = params.calculatorWrapper;
    this.gasCostEstimator = new GasCostEstimator();
    this.database = params.database;
    this.executor = params.executor;
    this.lastUpdateTimestamp = Date.now();

    logger.info('🔧 RariBumpEarningPowerEngine initialized with:', {
      stakerContractAddress: params.stakerContract.target,
      executorType: params.executor.constructor.name,
      calculatorType: params.calculatorWrapper.constructor.name,
      config: JSON.stringify(params.config),
    });
  }

  async processItem({
    item,
  }: {
    item: ProcessingQueueItem;
  }): Promise<ProfitabilityQueueResult> {
    logger.info(`🔍 Processing item ${item.id} for deposit ${item.deposit_id}`);

    try {
      const deposit = await this.database.getDeposit(item.deposit_id);

      if (!deposit) {
        logger.error(`❌ Deposit ${item.deposit_id} not found in database`);
        throw new Error(`Deposit ${item.deposit_id} not found`);
      }

      logger.info('📋 Processing bump earning power for deposit', {
        depositId: deposit.deposit_id,
        ownerAddress: deposit.owner_address,
        amount: ethers.formatEther(deposit.amount),
        earningPower: deposit.earning_power
          ? ethers.formatEther(deposit.earning_power)
          : '0',
        delegatee: deposit.delegatee_address,
      });

      const isBumpProfitable = await this.isBumpProfitable({ deposit });

      if (!isBumpProfitable.profitable) {
        logger.info(
          `❌ Bump not profitable for deposit ${deposit.deposit_id}:`,
          {
            reason: isBumpProfitable.reason,
          },
        );
        return {
          success: true,
          result: 'not_profitable',
          details: { reason: isBumpProfitable.reason },
        };
      }

      logger.info(`✅ Bump IS profitable for deposit ${deposit.deposit_id}:`, {
        tipAmount: isBumpProfitable.tipAmount?.toString(),
      });

      // Queue the transaction
      // Create transaction data using ethers instead of web3
      const bumpEarningPowerInterface = new ethers.Interface([
        'function bumpEarningPower(uint256 depositId, address tipReceiver, uint256 tip)',
      ]);

      const tipReceiver = CONFIG.executor.tipReceiver || ethers.ZeroAddress;
      logger.info(`💰 Using tip receiver: ${tipReceiver}`);

      const data = bumpEarningPowerInterface.encodeFunctionData(
        'bumpEarningPower',
        [deposit.deposit_id, tipReceiver, isBumpProfitable.tipAmount!],
      );

      const tx = {
        to: CONFIG.STAKER_CONTRACT_ADDRESS,
        data,
        gasLimit: CONFIG.BUMP_GAS_LIMIT || '300000',
      };

      logger.info('🔄 Queueing bump earning power transaction', {
        depositId: deposit.deposit_id,
        to: tx.to,
        tipAmount: ethers.formatEther(isBumpProfitable.tipAmount!),
        tipReceiver,
        gasLimit: tx.gasLimit,
        dataLength: tx.data.length,
        dataStart: tx.data.substring(0, 50) + '...',
      });

      await this.executor.queueTransaction(
        [BigInt(deposit.deposit_id)],
        {
          is_profitable: true,
          constraints: {
            has_enough_shares: true,
            meets_min_reward: true,
            meets_min_profit: true,
          },
          estimates: {
            total_shares: BigInt(deposit.amount),
            payout_amount: isBumpProfitable.tipAmount!,
            gas_estimate: BigInt(CONFIG.BUMP_GAS_LIMIT || '300000'),
            gas_cost: BigInt(CONFIG.BUMP_GAS_LIMIT || '300000'),
            expected_profit: isBumpProfitable.tipAmount!,
          },
          deposit_details: [
            {
              depositId: BigInt(deposit.deposit_id),
              rewards: isBumpProfitable.tipAmount!,
            },
          ],
        },
        tx.data,
      );

      logger.info(
        `✅ Transaction successfully queued for deposit ${deposit.deposit_id}`,
      );

      return {
        success: true,
        result: 'queued',
        details: {
          depositId: deposit.deposit_id,
          tipAmount: isBumpProfitable.tipAmount!.toString(),
        },
      };
    } catch (error) {
      logger.error(
        `❌ Error processing bump earning power for item ${item.id}:`,
        {
          itemId: item.id,
          depositId: item.deposit_id,
          error: (error as Error).message,
          stack: (error as Error).stack,
        },
      );
      return {
        success: false,
        result: 'error',
        details: { error: (error as Error).message },
      };
    }
  }

  async processDepositsBatch({
    deposits,
  }: {
    deposits: Deposit[];
  }): Promise<ProfitabilityQueueBatchResult> {
    logger.info(
      `🔄 Processing deposits batch with ${deposits.length} deposits`,
      {
        timestamp: Date.now(),
        depositIds:
          deposits.slice(0, 5).map((d) => d.deposit_id.toString()) +
          (deposits.length > 5 ? `...and ${deposits.length - 5} more` : ''),
      },
    );

    const results: ProfitabilityQueueBatchResult = {
      success: true,
      total: deposits.length,
      queued: 0,
      notProfitable: 0,
      errors: 0,
      details: [],
    };

    let processedCount = 0;
    const startTime = Date.now();

    for (const deposit of deposits) {
      processedCount++;

      if (processedCount % 10 === 0) {
        logger.info(
          `⏳ Batch progress: ${processedCount}/${deposits.length} deposits processed`,
        );
      }

      try {
        logger.info(
          `🔍 Checking profitability for deposit ${deposit.deposit_id}`,
          {
            owner: deposit.owner_address,
            amount: ethers.formatEther(deposit.amount),
            earningPower: deposit.earning_power
              ? ethers.formatEther(deposit.earning_power)
              : '0',
          },
        );

        const isBumpProfitable = await this.isBumpProfitable({ deposit });

        if (!isBumpProfitable.profitable) {
          logger.info(
            `❌ Deposit ${deposit.deposit_id} not profitable: ${isBumpProfitable.reason}`,
          );
          results.notProfitable++;
          results.details.push({
            depositId: deposit.deposit_id,
            result: 'not_profitable',
            details: { reason: isBumpProfitable.reason },
          });
          continue;
        }

        logger.info(
          `✅ Deposit ${deposit.deposit_id} IS profitable, preparing transaction`,
        );

        // Queue the transaction using ethers instead of web3
        const bumpEarningPowerInterface = new ethers.Interface([
          'function bumpEarningPower(uint256 depositId, address tipReceiver, uint256 tip)',
        ]);

        const tipReceiver = CONFIG.executor.tipReceiver || ethers.ZeroAddress;

        const data = bumpEarningPowerInterface.encodeFunctionData(
          'bumpEarningPower',
          [deposit.deposit_id, tipReceiver, isBumpProfitable.tipAmount!],
        );

        const tx = {
          to: CONFIG.STAKER_CONTRACT_ADDRESS,
          data,
          gasLimit: CONFIG.BUMP_GAS_LIMIT || '300000',
        };

        logger.info(
          `🔄 Queueing transaction for deposit ${deposit.deposit_id}`,
          {
            tipAmount: ethers.formatEther(isBumpProfitable.tipAmount!),
            tipReceiver,
          },
        );

        await this.executor.queueTransaction(
          [BigInt(deposit.deposit_id)],
          {
            is_profitable: true,
            constraints: {
              has_enough_shares: true,
              meets_min_reward: true,
              meets_min_profit: true,
            },
            estimates: {
              total_shares: BigInt(deposit.amount),
              payout_amount: isBumpProfitable.tipAmount!,
              gas_estimate: BigInt(CONFIG.BUMP_GAS_LIMIT || '300000'),
              gas_cost: BigInt(CONFIG.BUMP_GAS_LIMIT || '300000'),
              expected_profit: isBumpProfitable.tipAmount!,
            },
            deposit_details: [
              {
                depositId: BigInt(deposit.deposit_id),
                rewards: isBumpProfitable.tipAmount!,
              },
            ],
          },
          tx.data,
        );

        logger.info(`✅ Transaction queued for deposit ${deposit.deposit_id}`);
        results.queued++;
        results.details.push({
          depositId: deposit.deposit_id,
          result: 'queued',
          details: {
            tipAmount: isBumpProfitable.tipAmount!.toString(),
          },
        });
      } catch (error) {
        logger.error(`❌ Failed to process deposit ${deposit.deposit_id}:`, {
          error: (error as Error).message,
          timestamp: Date.now(),
        });
        results.errors++;
        results.details.push({
          depositId: deposit.deposit_id,
          result: 'error',
          details: { error: (error as Error).message },
        });
      }
    }

    const processingTime = Date.now() - startTime;
    logger.info(`✅ Batch processing completed in ${processingTime}ms`, {
      total: results.total,
      queued: results.queued,
      notProfitable: results.notProfitable,
      errors: results.errors,
      processingTimeMs: processingTime,
    });

    return results;
  }

  /**
   * Handle score event updates for a delegatee
   * @param delegatee The delegatee address
   * @param score The new score value
   */
  async onScoreEvent(delegatee: string, score: bigint): Promise<void> {
    logger.info(`🔔 SCORE EVENT RECEIVED for delegatee ${delegatee}`, {
      newScore: score.toString(),
      timestamp: Date.now(),
    });

    try {
      // Get all deposits for this delegatee
      logger.info(`🔍 Fetching deposits for delegatee ${delegatee}`);
      const deposits = await this.database.getDepositsByDelegatee(delegatee);

      if (deposits.length === 0) {
        logger.info(`⚠️ No deposits found for delegatee ${delegatee}`);
        return;
      }

      logger.info(
        `✅ Found ${deposits.length} deposits for delegatee ${delegatee}`,
        {
          depositIds:
            deposits.slice(0, 5).map((d) => d.deposit_id.toString()) +
            (deposits.length > 5 ? `...and ${deposits.length - 5} more` : ''),
        },
      );

      // Process the deposits batch
      logger.info(
        `🔄 Processing deposits after score event for delegatee ${delegatee}`,
      );
      await this.processDepositsBatch({ deposits });
    } catch (error) {
      logger.error(
        `❌ Error processing score event for delegatee ${delegatee}:`,
        {
          delegatee,
          score: score.toString(),
          error: (error as Error).message,
          stack: (error as Error).stack,
        },
      );
      throw error;
    }
  }

  private async isBumpProfitable({ deposit }: { deposit: Deposit }): Promise<{
    profitable: boolean;
    reason?: string;
    tipAmount?: bigint;
  }> {
    logger.info(
      `📊 Analyzing profitability for deposit ${deposit.deposit_id}`,
      {
        depositId: deposit.deposit_id,
        ownerAddress: deposit.owner_address,
        delegateeAddress: deposit.delegatee_address,
        amount: deposit.amount,
      },
    );

    try {
      // Get the current deposit state from the contract to ensure we have latest data
      const depositState = await this.stakerContract.deposits(
        BigInt(deposit.deposit_id),
      );

      // Validate deposit state
      if (
        !depositState ||
        !depositState.owner ||
        !depositState.delegatee ||
        !depositState.balance
      ) {
        logger.error(
          `Invalid deposit state for deposit ${deposit.deposit_id}`,
          {
            depositState,
          },
        );
        return {
          profitable: false,
          reason: 'Invalid deposit state from contract',
        };
      }

      // Validate addresses are proper Ethereum addresses
      if (
        !ethers.isAddress(depositState.owner) ||
        !ethers.isAddress(depositState.delegatee)
      ) {
        logger.error(
          `Invalid addresses in deposit state for deposit ${deposit.deposit_id}`,
          {
            owner: depositState.owner,
            delegatee: depositState.delegatee,
          },
        );
        return {
          profitable: false,
          reason: 'Invalid addresses in deposit state',
        };
      }

      // Calculate current earning power using the correct addresses
      logger.info(
        `🔍 Getting current earning power for deposit ${deposit.deposit_id}`,
        {
          amount: depositState.balance.toString(),
          staker: depositState.owner,
          delegatee: depositState.delegatee,
        },
      );

      const currentScore = await this.calculatorWrapper.getEarningPower(
        depositState.balance,
        depositState.owner,
        depositState.delegatee,
      );

      if (!currentScore) {
        logger.warn(
          `❌ Could not calculate current earning power for deposit ${deposit.deposit_id}`,
        );
        return {
          profitable: false,
          reason: 'Could not calculate current earning power',
        };
      }

      logger.info(
        `📈 Current earning power for deposit ${deposit.deposit_id}: ${ethers.formatEther(currentScore)}`,
      );

      // Calculate new earning power to check if it would actually change
      const [newScore, isBumpable] =
        await this.calculatorWrapper.getNewEarningPower(
          depositState.balance,
          depositState.owner,
          depositState.delegatee,
          currentScore,
        );

      if (!isBumpable) {
        logger.info(
          `❌ Deposit ${deposit.deposit_id} is not bumpable according to contract`,
        );
        return {
          profitable: false,
          reason: 'Deposit is not bumpable',
        };
      }

      // Check if earning power would actually change
      if (newScore === currentScore) {
        logger.info(
          `No earning power change for deposit ${deposit.deposit_id}`,
        );
        return {
          profitable: false,
          reason: 'No earning power change',
        };
      }

      // Check if this crosses the eligibility threshold (15)
      const ELIGIBILITY_THRESHOLD = BigInt('15000000000000000000'); // 15 with 18 decimals
      const currentAboveThreshold = currentScore >= ELIGIBILITY_THRESHOLD;
      const newAboveThreshold = newScore >= ELIGIBILITY_THRESHOLD;

      // Only bumpable if crossing the threshold in either direction
      if (currentAboveThreshold === newAboveThreshold) {
        logger.info(
          `Deposit ${deposit.deposit_id} not crossing threshold (${ethers.formatEther(currentScore)} → ${ethers.formatEther(newScore)})`,
        );
        return {
          profitable: false,
          reason: 'Does not cross eligibility threshold',
        };
      }

      logger.info(
        `Deposit ${deposit.deposit_id} crossing threshold ${currentAboveThreshold ? 'above->below' : 'below->above'} (${ethers.formatEther(currentScore)} → ${ethers.formatEther(newScore)})`,
      );

      // Get MAX_BUMP_TIP and unclaimed rewards
      const maxBumpTipValue = await this.stakerContract.maxBumpTip();
      const unclaimedRewards = await this.stakerContract.unclaimedReward(
        BigInt(deposit.deposit_id),
      );

      // Get gas costs
      const provider = this.stakerContract.runner?.provider || this.provider;
      const feeData = await provider.getFeeData();
      const gasPriceBigInt = feeData.gasPrice || BigInt('50000000000'); // 50 gwei default
      const gasLimit = BigInt(CONFIG.BUMP_GAS_LIMIT || '300000');
      const gasCost = gasPriceBigInt * gasLimit;

      // For power decreases, we need to ensure enough rewards to cover:
      // 1. Gas costs
      // 2. Tip amount
      // 3. maxBumpTip leftover for future operations
      const isEarningPowerDecrease = newScore < currentScore;

      if (isEarningPowerDecrease) {
        // Calculate minimum required rewards
        const minRequiredRewards = gasCost + maxBumpTipValue;

        // Check if we have enough unclaimed rewards
        if (unclaimedRewards <= minRequiredRewards) {
          logger.info(
            `Insufficient rewards for decrease (${ethers.formatEther(unclaimedRewards)} < ${ethers.formatEther(minRequiredRewards)})`,
          );
          return {
            profitable: false,
            reason: 'Insufficient rewards for gas and maxBumpTip reserve',
          };
        }

        // We can use any remaining rewards above minRequiredRewards as tip
        const availableForTip = unclaimedRewards - minRequiredRewards;

        // If we have enough for a tip, proceed with that amount
        if (availableForTip > 0n) {
          logger.info(
            `Profitable decrease: tip ${ethers.formatEther(availableForTip)}, reserve ${ethers.formatEther(minRequiredRewards)}`,
          );
          return {
            profitable: true,
            tipAmount: availableForTip,
          };
        }
      }

      // For increases, calculate profitability
      const scoreIncrease = newScore - currentScore;
      const rewardRatePerBlock = BigInt(
        CONFIG.REWARD_RATE_PER_BLOCK || '1000000000000000',
      );
      const expectedBlocks = BigInt(
        CONFIG.EXPECTED_BLOCKS_BEFORE_NEXT_BUMP || '40320',
      );
      const expectedRewards =
        (scoreIncrease * rewardRatePerBlock * expectedBlocks) / BigInt(1e18);
      const totalCost = gasCost;

      // Check if profitable
      if (expectedRewards > totalCost) {
        const profit = expectedRewards - totalCost;
        logger.info(
          `Profitable increase: expected profit ${ethers.formatEther(profit)}`,
        );
        return {
          profitable: true,
          tipAmount: 0n,
        };
      }

      logger.info(
        `Not profitable: rewards ${ethers.formatEther(expectedRewards)} < cost ${ethers.formatEther(totalCost)}`,
      );
      return {
        profitable: false,
        reason: 'Not profitable',
      };
    } catch (error) {
      logger.error(
        `Error calculating profitability for deposit ${deposit.deposit_id}: ${(error as Error).message}`,
      );
      return {
        profitable: false,
        reason: `Error: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Start periodic checks for bump opportunities
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    logger.info('Starting RariBumpEarningPowerEngine');
    this.isRunning = true;
    this.lastUpdateTimestamp = Date.now();
    this.startPeriodicChecks();

    // Perform initial check for all deposits
    try {
      const deposits = await this.database.getAllDeposits();
      if (deposits.length > 0) {
        logger.info(`Processing initial batch of ${deposits.length} deposits`);
        await this.processDepositsBatch({ deposits });
      }
    } catch (error) {
      logger.error(
        `Error during initial bump check: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Stop periodic checks
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping RariBumpEarningPowerEngine');
    this.isRunning = false;
    this.stopPeriodicChecks();
  }

  /**
   * Start periodic checks for bump opportunities
   */
  private startPeriodicChecks(): void {
    if (this.periodicCheckInterval) {
      return;
    }

    this.periodicCheckInterval = setInterval(async () => {
      try {
        const deposits = await this.database.getAllDeposits();
        if (deposits.length > 0) {
          logger.info(
            `Processing periodic batch of ${deposits.length} deposits`,
          );
          await this.processDepositsBatch({ deposits });
        }
      } catch (error) {
        logger.error(
          `Error during periodic bump check: ${(error as Error).message}`,
        );
      }
    }, this.PERIODIC_CHECK_INTERVAL);
  }

  /**
   * Stop periodic checks
   */
  private stopPeriodicChecks(): void {
    if (this.periodicCheckInterval) {
      clearInterval(this.periodicCheckInterval);
      this.periodicCheckInterval = null;
    }
  }

  /**
   * Get current engine status
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    lastGasPrice: bigint;
    lastUpdateTimestamp: number;
    queueSize: number;
    delegateeCount: number;
  }> {
    return {
      isRunning: this.isRunning,
      lastGasPrice: BigInt(0),
      lastUpdateTimestamp: this.lastUpdateTimestamp,
      queueSize: 0,
      delegateeCount: 0,
    };
  }

  protected async updateTimestamp(): Promise<void> {
    this.lastUpdateTimestamp = Date.now();
  }
}
