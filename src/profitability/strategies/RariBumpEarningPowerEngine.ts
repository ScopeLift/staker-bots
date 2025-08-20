import { IProfitabilityEngine } from '../interfaces/IProfitabilityEngine';
import { IExecutor } from '../../executor/interfaces/IExecutor';
import { IDatabase } from '../../database/interfaces/IDatabase';
import { BaseProfitabilityEngine } from './BaseProfitabilityEngine';
import { CalculatorWrapper } from '../../calculator/CalculatorWrapper';
import { Deposit, ProcessingQueueItem, BumpReaction, ThresholdTransition } from '../../database/interfaces/types';
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
import { TIME_CONSTANTS } from '../../configuration/constants';

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
  private readonly PERIODIC_CHECK_INTERVAL: number;
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
      updateEligibilityDelay(): Promise<bigint>;
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

    // Configure interval from environment variable with fallback
    this.PERIODIC_CHECK_INTERVAL = parseInt(
      process.env.BUMP_EARNING_POWER_INTERVAL || '300000', // 5 minutes default
      10,
    );

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

      // Safely convert and validate parameters before encoding to prevent overflow
      let depositIdBigInt: bigint;
      let tipAmountBigInt: bigint;
      
      try {
        // Handle deposit_id conversion
        if (typeof deposit.deposit_id === 'bigint') {
          depositIdBigInt = deposit.deposit_id;
        } else if (typeof deposit.deposit_id === 'string') {
          depositIdBigInt = BigInt(deposit.deposit_id);
        } else if (typeof deposit.deposit_id === 'number') {
          const depositIdNumber = Math.floor(deposit.deposit_id);
          depositIdBigInt = BigInt(depositIdNumber);
        } else {
          throw new Error(`Invalid deposit_id type: ${typeof deposit.deposit_id}`);
        }

        // Handle tip amount conversion
        if (!isBumpProfitable.tipAmount) {
          tipAmountBigInt = 0n;
        } else if (typeof isBumpProfitable.tipAmount === 'bigint') {
          tipAmountBigInt = isBumpProfitable.tipAmount;
        } else if (typeof isBumpProfitable.tipAmount === 'string') {
          tipAmountBigInt = BigInt(isBumpProfitable.tipAmount);
        } else if (typeof isBumpProfitable.tipAmount === 'number') {
          const tipNumber = Math.floor(isBumpProfitable.tipAmount);
          tipAmountBigInt = BigInt(tipNumber);
        } else {
          throw new Error(`Invalid tipAmount type: ${typeof isBumpProfitable.tipAmount}`);
        }
      } catch (conversionError) {
        logger.error(`Failed to convert parameters for deposit ${deposit.deposit_id}`, {
          error: conversionError instanceof Error ? conversionError.message : String(conversionError),
          depositId: deposit.deposit_id,
          depositIdType: typeof deposit.deposit_id,
          tipAmount: isBumpProfitable.tipAmount,
          tipAmountType: typeof isBumpProfitable.tipAmount,
        });
        return {
          success: false,
          result: 'error',
          details: { error: `Parameter conversion failed: ${conversionError instanceof Error ? conversionError.message : String(conversionError)}` },
        };
      }
      
      // Ensure values are within safe ranges for ethers encoding
      const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
      if (depositIdBigInt > MAX_UINT256) {
        logger.error(`Deposit ID ${depositIdBigInt} exceeds uint256 max`, {
          depositId: deposit.deposit_id,
        });
        return {
          success: false,
          result: 'error',
          details: { error: 'Deposit ID overflow' },
        };
      }
      
      if (tipAmountBigInt > MAX_UINT256) {
        logger.error(`Tip amount ${tipAmountBigInt} exceeds uint256 max`, {
          depositId: deposit.deposit_id,
          tipAmount: tipAmountBigInt.toString(),
        });
        return {
          success: false,
          result: 'error',
          details: { error: 'Tip amount overflow' },
        };
      }

      let data: string;
      try {
        data = bumpEarningPowerInterface.encodeFunctionData(
          'bumpEarningPower',
          [depositIdBigInt, tipReceiver, tipAmountBigInt],
        );
      } catch (encodingError) {
        logger.error(`Failed to encode function data for deposit ${deposit.deposit_id}`, {
          error: encodingError instanceof Error ? encodingError.message : String(encodingError),
          depositId: depositIdBigInt.toString(),
          tipReceiver,
          tipAmount: tipAmountBigInt.toString(),
        });
        return {
          success: false,
          result: 'error',
          details: { error: `Encoding failed: ${encodingError instanceof Error ? encodingError.message : String(encodingError)}` },
        };
      }

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
          transaction_type: 'bump',
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

        // Safely convert and validate parameters before encoding to prevent overflow
        let depositIdBigInt: bigint;
        let tipAmountBigInt: bigint;
        
        try {
          // Handle deposit_id conversion
          if (typeof deposit.deposit_id === 'bigint') {
            depositIdBigInt = deposit.deposit_id;
          } else if (typeof deposit.deposit_id === 'string') {
            depositIdBigInt = BigInt(deposit.deposit_id);
          } else if (typeof deposit.deposit_id === 'number') {
            const depositIdNumber = Math.floor(deposit.deposit_id);
            depositIdBigInt = BigInt(depositIdNumber);
          } else {
            throw new Error(`Invalid deposit_id type: ${typeof deposit.deposit_id}`);
          }

          // Handle tip amount conversion
          if (!isBumpProfitable.tipAmount) {
            tipAmountBigInt = 0n;
          } else if (typeof isBumpProfitable.tipAmount === 'bigint') {
            tipAmountBigInt = isBumpProfitable.tipAmount;
          } else if (typeof isBumpProfitable.tipAmount === 'string') {
            tipAmountBigInt = BigInt(isBumpProfitable.tipAmount);
          } else if (typeof isBumpProfitable.tipAmount === 'number') {
            const tipNumber = Math.floor(isBumpProfitable.tipAmount);
            tipAmountBigInt = BigInt(tipNumber);
          } else {
            throw new Error(`Invalid tipAmount type: ${typeof isBumpProfitable.tipAmount}`);
          }
        } catch (conversionError) {
          logger.error(`Failed to convert parameters for deposit ${deposit.deposit_id}`, {
            error: conversionError instanceof Error ? conversionError.message : String(conversionError),
            depositId: deposit.deposit_id,
            depositIdType: typeof deposit.deposit_id,
            tipAmount: isBumpProfitable.tipAmount,
            tipAmountType: typeof isBumpProfitable.tipAmount,
          });
          results.errors++;
          results.details.push({
            depositId: deposit.deposit_id,
            result: 'error',
            details: { error: `Parameter conversion failed: ${conversionError instanceof Error ? conversionError.message : String(conversionError)}` },
          });
          continue;
        }
        
        // Ensure values are within safe ranges for ethers encoding
        const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
        if (depositIdBigInt > MAX_UINT256) {
          logger.error(`Deposit ID ${depositIdBigInt} exceeds uint256 max`, {
            depositId: deposit.deposit_id,
          });
          results.errors++;
          results.details.push({
            depositId: deposit.deposit_id,
            result: 'error',
            details: { error: 'Deposit ID overflow' },
          });
          continue;
        }
        
        if (tipAmountBigInt > MAX_UINT256) {
          logger.error(`Tip amount ${tipAmountBigInt} exceeds uint256 max`, {
            depositId: deposit.deposit_id,
            tipAmount: tipAmountBigInt.toString(),
          });
          results.errors++;
          results.details.push({
            depositId: deposit.deposit_id,
            result: 'error',
            details: { error: 'Tip amount overflow' },
          });
          continue;
        }

        let data: string;
        try {
          data = bumpEarningPowerInterface.encodeFunctionData(
            'bumpEarningPower',
            [depositIdBigInt, tipReceiver, tipAmountBigInt],
          );
        } catch (encodingError) {
          logger.error(`Failed to encode function data for deposit ${deposit.deposit_id}`, {
            error: encodingError instanceof Error ? encodingError.message : String(encodingError),
            depositId: depositIdBigInt.toString(),
            tipReceiver,
            tipAmount: tipAmountBigInt.toString(),
          });
          results.errors++;
          results.details.push({
            depositId: deposit.deposit_id,
            result: 'error',
            details: { error: `Encoding failed: ${encodingError instanceof Error ? encodingError.message : String(encodingError)}` },
          });
          continue;
        }

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
      const ELIGIBILITY_THRESHOLD = BigInt('15000000000000000000'); // 15 with 18 decimals
      const newAboveThreshold = score >= ELIGIBILITY_THRESHOLD;

      // Get the latest reaction for this delegatee to determine previous state
      const latestReaction = await this.database.getLatestBumpReactionForDelegatee(delegatee);
      
      let previousScore: bigint;
      let previousAboveThreshold: boolean;

      if (latestReaction) {
        previousScore = BigInt(latestReaction.new_score);
        previousAboveThreshold = previousScore >= ELIGIBILITY_THRESHOLD;
      } else {
        // If no previous reaction, we need to check the latest score event
        const latestScoreEvent = await this.database.getLatestScoreEvent(delegatee);
        if (latestScoreEvent) {
          previousScore = BigInt(latestScoreEvent.score);
          previousAboveThreshold = previousScore >= ELIGIBILITY_THRESHOLD;
        } else {
          // No previous data available - assume previous score was 0 (below threshold)
          previousScore = 0n;
          previousAboveThreshold = false;
        }
      }

      logger.info(`📊 Threshold analysis for delegatee ${delegatee}`, {
        previousScore: previousScore.toString(),
        newScore: score.toString(),
        previousAboveThreshold,
        newAboveThreshold,
        threshold: '15',
      });

      // Check if this is a threshold crossing
      if (previousAboveThreshold === newAboveThreshold) {
        logger.info(`⚪ No threshold crossing for delegatee ${delegatee} - no action needed`, {
          previousAboveThreshold,
          newAboveThreshold,
        });
        return;
      }

      // Determine the transition type
      const transition = newAboveThreshold ? ThresholdTransition.BELOW_TO_ABOVE : ThresholdTransition.ABOVE_TO_BELOW;

      logger.info(`🚨 THRESHOLD CROSSING DETECTED for delegatee ${delegatee}`, {
        transition,
        previousScore: previousScore.toString(),
        newScore: score.toString(),
      });

      // Get current score event to find block number
      const currentScoreEvent = await this.database.getLatestScoreEvent(delegatee);
      const blockNumber = currentScoreEvent?.block_number || 0;

      // Check if we've already reacted to this exact transition at this block
      const alreadyReacted = await this.database.checkBumpReactionExists(
        delegatee,
        transition,
        blockNumber,
      );

      if (alreadyReacted) {
        logger.info(`⚠️ Already reacted to this transition for delegatee ${delegatee} at block ${blockNumber}`, {
          transition,
          blockNumber,
        });
        return;
      }

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
      const batchResult = await this.processDepositsBatch({ deposits });

      // Record this reaction to prevent duplicate processing
      const processedDepositIds = batchResult.details
        .filter(detail => detail.result === 'queued')
        .map(detail => detail.depositId.toString());

      if (processedDepositIds.length > 0) {
        await this.database.createBumpReaction({
          delegatee_address: delegatee,
          score_transition: transition,
          previous_score: previousScore.toString(),
          new_score: score.toString(),
          block_number: blockNumber,
          deposits_processed: processedDepositIds,
        });

        logger.info(`✅ Recorded bump reaction for delegatee ${delegatee}`, {
          transition,
          depositsProcessed: processedDepositIds.length,
          blockNumber,
        });
      } else {
        logger.info(`ℹ️ No deposits were queued for processing, skipping reaction record`, {
          delegatee,
          transition,
          reason: 'No profitable bumps found',
        });
      }
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

    // Check if profitability bypass is enabled for bump transactions
    const bypassProfitability = process.env.BUMP_BYPASS_PROFITABILITY === 'true';
    
    if (bypassProfitability) {
      logger.info(
        `⚡ BUMP_BYPASS_PROFITABILITY is enabled - performing eligibility checks only for deposit ${deposit.deposit_id}`,
      );
    }

    try {
      // Safely convert deposit_id to BigInt, handling various input types
      let depositIdBigInt: bigint;
      try {
        // Handle deposit_id whether it's string, number, or bigint
        if (typeof deposit.deposit_id === 'bigint') {
          depositIdBigInt = deposit.deposit_id;
        } else if (typeof deposit.deposit_id === 'string') {
          depositIdBigInt = BigInt(deposit.deposit_id);
        } else if (typeof deposit.deposit_id === 'number') {
          // For numbers, ensure they're whole numbers and not in scientific notation
          const depositIdNumber = Math.floor(deposit.deposit_id);
          depositIdBigInt = BigInt(depositIdNumber);
        } else {
          throw new Error(`Invalid deposit_id type: ${typeof deposit.deposit_id}`);
        }
      } catch (error) {
        logger.error(
          `❌ Failed to convert deposit_id to BigInt for deposit ${deposit.deposit_id}`,
          {
            depositId: deposit.deposit_id,
            type: typeof deposit.deposit_id,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return {
          profitable: false,
          reason: `Invalid deposit ID: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      // Get the current deposit state from the contract to ensure we have latest data
      const depositState = await this.stakerContract.deposits(depositIdBigInt);

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

      let currentScore: bigint;
      try {
        currentScore = await this.calculatorWrapper.getEarningPower(
          depositState.balance,
          depositState.owner,
          depositState.delegatee,
        );
      } catch (error) {
        logger.warn(
          `❌ Could not calculate current earning power for deposit ${deposit.deposit_id}: ${error}`,
        );
        return {
          profitable: false,
          reason: 'Could not calculate current earning power',
        };
      }

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
        // Log detailed decision data
        logger.info(
          `[@rari-staker] BUMP_DECISION: REJECTED - Deposit ${deposit.deposit_id} not bumpable by contract`,
          {
            depositId: deposit.deposit_id,
            owner: depositState.owner,
            delegatee: depositState.delegatee,
            currentScore: ethers.formatEther(currentScore),
            newScore: ethers.formatEther(newScore),
            balance: ethers.formatEther(depositState.balance),
            isBumpable,
            decision: 'REJECTED',
            reason: 'Contract reports not bumpable'
          }
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

      // Check updateEligibilityDelay - user must wait specified time after becoming eligible
      if (!currentAboveThreshold && newAboveThreshold) {
        // This is a below->above threshold crossing, check if enough time has passed since eligibility
        try {
          // Get updateEligibilityDelay from contract, fallback to 604800 seconds (7 days)
          let eligibilityDelaySeconds: bigint;
          try {
            if (this.stakerContract.updateEligibilityDelay) {
              eligibilityDelaySeconds = await this.stakerContract.updateEligibilityDelay();
            } else {
              throw new Error('updateEligibilityDelay method not available on contract');
            }
          } catch (contractError) {
            logger.warn(
              `Could not read updateEligibilityDelay from contract, using fallback: ${(contractError as Error).message}`,
            );
            eligibilityDelaySeconds = BigInt(TIME_CONSTANTS.WEEK); // 604800 seconds
          }
          
          // Get the latest score event for this delegatee to check when they became eligible
          const latestScoreEvent = await this.database.getLatestScoreEvent(depositState.delegatee);
          
          if (latestScoreEvent) {
            // Get the block timestamp when they became eligible
            const eligibilityBlock = await this.provider.getBlock(latestScoreEvent.block_number);
            if (eligibilityBlock && eligibilityBlock.timestamp) {
              const eligibilityTimestamp = eligibilityBlock.timestamp * 1000; // Convert to milliseconds
              const currentTimestamp = Date.now();
              const timeSinceEligible = currentTimestamp - eligibilityTimestamp;
              const requiredDelay = Number(eligibilityDelaySeconds) * 1000; // Convert to milliseconds
              
              if (timeSinceEligible < requiredDelay) {
                const remainingTime = requiredDelay - timeSinceEligible;
                logger.info(
                  `Deposit ${deposit.deposit_id} must wait ${remainingTime / 1000}s more (updateEligibilityDelay: ${eligibilityDelaySeconds}s)`,
                  {
                    eligibilityTimestamp,
                    currentTimestamp,
                    timeSinceEligible,
                    requiredDelay,
                    remainingTime,
                    eligibilityDelaySeconds: eligibilityDelaySeconds.toString(),
                  }
                );
                return {
                  profitable: false,
                  reason: `updateEligibilityDelay not met: ${Math.ceil(remainingTime / 1000)}s remaining`,
                };
              }
            }
          }
        } catch (error) {
          logger.warn(
            `Could not check eligibility delay for deposit ${deposit.deposit_id}: ${(error as Error).message}`,
          );
          // Continue with bump check if we can't determine eligibility timing
        }
      }

      // Get MAX_BUMP_TIP and unclaimed rewards
      const maxBumpTipValue = await this.stakerContract.maxBumpTip();
      const unclaimedRewards = await this.stakerContract.unclaimedReward(depositIdBigInt);

      // Safety constants to prevent overflow
      const MAX_SAFE_TIP = ethers.parseEther('1000000'); // 1M tokens max tip to prevent overflow
      const MAX_ETHERS_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

      // Get gas costs
      const provider = this.stakerContract.runner?.provider || this.provider;
      const feeData = await provider.getFeeData();
      const gasPriceBigInt = feeData.gasPrice || BigInt('50000000000'); // 50 gwei default
      const gasLimit = BigInt(CONFIG.BUMP_GAS_LIMIT || '300000');
      const gasCost = gasPriceBigInt * gasLimit;

      // For power decreases (going below threshold), we need to ensure enough rewards to cover:
      // 1. The tip amount requested by the bot
      // 2. maxBumpTip leftover AFTER the tip for future operations
      const isEarningPowerDecrease = newScore < currentScore;

      if (isEarningPowerDecrease) {
        // For negative bumps, we need to ensure:
        // 1. The tip we request must be less than total unclaimed rewards
        // 2. After paying the tip, there must be at least maxBumpTip remaining
        
        // First check if there are any unclaimed rewards at all
        if (unclaimedRewards <= maxBumpTipValue) {
          logger.info(
            `Insufficient rewards: need at least maxBumpTip (${ethers.formatEther(maxBumpTipValue)}) remaining after tip, but only have ${ethers.formatEther(unclaimedRewards)} total`,
          );
          return {
            profitable: false,
            reason: 'Insufficient rewards: need maxBumpTip remaining after tip',
          };
        }

        // Calculate the maximum tip we can request
        // This is unclaimed rewards minus the maxBumpTip that must remain
        let availableForTip = unclaimedRewards - maxBumpTipValue;

        // Apply safety caps to prevent overflow
        if (availableForTip > MAX_SAFE_TIP) {
          logger.warn(
            `Tip amount ${ethers.formatEther(availableForTip)} exceeds safety limit, capping to ${ethers.formatEther(MAX_SAFE_TIP)}`,
            {
              depositId: deposit.deposit_id,
              originalTip: availableForTip.toString(),
              cappedTip: MAX_SAFE_TIP.toString(),
            }
          );
          availableForTip = MAX_SAFE_TIP;
        }

        // Additional safety check for ethers uint256 overflow
        if (availableForTip > MAX_ETHERS_UINT256) {
          logger.error(
            `Tip amount ${availableForTip.toString()} exceeds uint256 max, this should not happen`,
            {
              depositId: deposit.deposit_id,
              availableForTip: availableForTip.toString(),
            }
          );
          return {
            profitable: false,
            reason: 'Tip calculation overflow error',
          };
        }

        // If we have enough for a tip, proceed with that amount
        if (availableForTip > 0n) {
          logger.info(
            `Profitable decrease: tip ${ethers.formatEther(availableForTip)}, reserve ${ethers.formatEther(maxBumpTipValue)}`,
          );
          // Log detailed decision data for successful bump with tip
          logger.info(
            `[@rari-staker] BUMP_DECISION: APPROVED - Deposit ${deposit.deposit_id} will be bumped (score decrease with tip)`,
            {
              depositId: deposit.deposit_id,
              owner: depositState.owner,
              delegatee: depositState.delegatee,
              currentScore: ethers.formatEther(currentScore),
              newScore: ethers.formatEther(newScore),
              balance: ethers.formatEther(depositState.balance),
              isBumpable,
              tipAmount: ethers.formatEther(availableForTip),
              reserveAmount: ethers.formatEther(maxBumpTipValue),
              decision: 'APPROVED',
              reason: 'Profitable score decrease with tip'
            }
          );
          return {
            profitable: true,
            tipAmount: availableForTip,
          };
        }
      }

      // For increases (going above threshold), check profitability unless bypassed
      if (bypassProfitability) {
        logger.info(
          `Bypassing profitability check for score increase (BUMP_BYPASS_PROFITABILITY=true)`,
        );
        logger.info(
          `[@rari-staker] BUMP_DECISION: APPROVED - Deposit ${deposit.deposit_id} will be bumped (score increase, profitability bypassed)`,
          {
            depositId: deposit.deposit_id,
            owner: depositState.owner,
            delegatee: depositState.delegatee,
            currentScore: ethers.formatEther(currentScore),
            newScore: ethers.formatEther(newScore),
            balance: ethers.formatEther(depositState.balance),
            isBumpable,
            tipAmount: ethers.formatEther(0n),
            decision: 'APPROVED',
            reason: 'Score increase with profitability bypass'
          }
        );
        return {
          profitable: true,
          tipAmount: 0n,
        };
      }
      
      // Calculate profitability for increases when not bypassed
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
        // Log detailed decision data for successful bump
        logger.info(
          `[@rari-staker] BUMP_DECISION: APPROVED - Deposit ${deposit.deposit_id} will be bumped (score increase)`,
          {
            depositId: deposit.deposit_id,
            owner: depositState.owner,
            delegatee: depositState.delegatee,
            currentScore: ethers.formatEther(currentScore),
            newScore: ethers.formatEther(newScore),
            balance: ethers.formatEther(depositState.balance),
            isBumpable,
            expectedProfit: ethers.formatEther(profit),
            tipAmount: ethers.formatEther(0n),
            decision: 'APPROVED',
            reason: 'Profitable score increase'
          }
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

    // Check if bump earning power is enabled
    const enableBumpEarningPower = process.env.ENABLE_BUMP_EARNING_POWER === 'true';
    if (!enableBumpEarningPower) {
      logger.info('Bump Earning Power Engine disabled by ENABLE_BUMP_EARNING_POWER environment variable');
      return;
    }

    logger.info('Starting RariBumpEarningPowerEngine', {
      enabledByFlag: true,
      intervalMs: this.PERIODIC_CHECK_INTERVAL,
    });
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
