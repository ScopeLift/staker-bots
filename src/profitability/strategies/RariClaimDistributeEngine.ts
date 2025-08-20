import { ethers } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { IProfitabilityEngine } from '../interfaces/IProfitabilityEngine';
import { IDatabase } from '../../database/interfaces/IDatabase';
import { BaseProfitabilityEngine } from './BaseProfitabilityEngine';
import { Deposit, ProcessingQueueItem, TransactionType } from '../../database/interfaces/types';
import {
  ProfitabilityQueueBatchResult,
  ProfitabilityQueueResult,
} from '../interfaces/types';
import { CONFIG } from '../../configuration';
import { IPriceFeed } from '../../shared/price-feeds/interfaces';
import { ProfitabilityConfig } from '../interfaces/types';
import { BinaryEligibilityOracleEarningPowerCalculator } from '@/calculator';
import { ExecutorWrapper } from '../../executor/ExecutorWrapper';

export class RariClaimDistributeEngine
  extends BaseProfitabilityEngine
  implements IProfitabilityEngine
{
  private readonly lstToken: ethers.Contract & {
    getUnclaimedRewards(): Promise<bigint>;
    payoutAmount?(): Promise<bigint>;
  };
  protected readonly database: IDatabase;
  protected readonly executor: ExecutorWrapper;
  protected readonly stakerContract: ethers.Contract & {
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
  protected readonly logger: Logger;
  private periodicCheckInterval: NodeJS.Timeout | null = null;
  private readonly PERIODIC_CHECK_INTERVAL: number;
  protected isRunning = false;
  protected lastUpdateTimestamp: number;

  constructor({
    database,
    executor,
    calculator,
    stakerContract,
    provider,
    config,
    priceFeed,
    logger = new ConsoleLogger('info', { prefix: 'RariClaimDistributeEngine' }),
  }: {
    database: IDatabase;
    executor: ExecutorWrapper;
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
    logger?: Logger;
  }) {
    super(calculator, stakerContract, provider, config, priceFeed);
    this.database = database;
    this.executor = executor;
    this.logger = logger;
    this.stakerContract = stakerContract;
    this.lastUpdateTimestamp = Date.now();

    // Configure interval from environment variable with fallback
    this.PERIODIC_CHECK_INTERVAL = parseInt(
      process.env.CLAIM_AND_DISTRIBUTE_INTERVAL || '300000', // 5 minutes default
      10,
    );

    // Initialize LST token contract with correct ABI
    this.lstToken = new ethers.Contract(
      CONFIG.LST_ADDRESS,
      [
        'function getUnclaimedRewards() external view returns (uint256)',
        'function claimAndDistributeReward(address _recipient, uint256 _minExpectedReward, uint256[] calldata _depositIds) external',
        'function payoutAmount() external view returns (uint256)',
      ],
      provider,
    ) as ethers.Contract & {
      getUnclaimedRewards(): Promise<bigint>;
      claimAndDistributeReward(recipient: string, minExpectedReward: bigint, depositIds: bigint[]): Promise<any>;
      payoutAmount?(): Promise<bigint>;
    };
  }

  /**
   * Start periodic checks for claim opportunities
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    // Check if claim and distribute is enabled
    const enableClaimAndDistribute = process.env.ENABLE_CLAIM_AND_DISTRIBUTE === 'true';
    if (!enableClaimAndDistribute) {
      this.logger.info('Claim and Distribute Engine disabled by ENABLE_CLAIM_AND_DISTRIBUTE environment variable');
      return;
    }

    this.isRunning = true;
    this.lastUpdateTimestamp = Date.now();
    this.logger.info('Starting Rari Claim and Distribute Engine', {
      intervalMs: this.PERIODIC_CHECK_INTERVAL,
      enabledByFlag: true,
    });

    // Start periodic checks for claim opportunities
    this.startPeriodicChecks();

    // Perform initial check right away
    try {
      this.logger.info('Performing initial check for claim opportunities');
      await this.processDeposits();
    } catch (error) {
      this.logger.error('Error during initial claim check', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Stop periodic checks
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;
    this.stopPeriodicChecks();
    this.logger.info('Stopped Rari Claim and Distribute Engine');
  }

  /**
   * Start periodic checks for claim opportunities
   */
  private startPeriodicChecks(): void {
    if (this.periodicCheckInterval) return;

    this.periodicCheckInterval = setInterval(async () => {
      try {
        await this.processDeposits();
      } catch (error) {
        this.logger.error('Error during periodic claim check', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.PERIODIC_CHECK_INTERVAL);

    this.logger.info('Started periodic checks for claim opportunities', {
      intervalMs: this.PERIODIC_CHECK_INTERVAL,
    });
  }

  /**
   * Stop periodic checks
   */
  private stopPeriodicChecks(): void {
    if (!this.periodicCheckInterval) return;

    clearInterval(this.periodicCheckInterval);
    this.periodicCheckInterval = null;
    this.logger.info('Stopped periodic checks for claim opportunities');
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
      lastGasPrice: BigInt(0), // Default value
      lastUpdateTimestamp: this.lastUpdateTimestamp,
      queueSize: 0, // We don't maintain a queue in this engine
      delegateeCount: 0, // Not tracking delegatees separately
    };
  }

  async processItem({
    item,
  }: {
    item: ProcessingQueueItem;
  }): Promise<ProfitabilityQueueResult> {
    // Critical safety check: Block all processing if disabled
    const enableClaimAndDistribute = process.env.ENABLE_CLAIM_AND_DISTRIBUTE === 'true';
    if (!enableClaimAndDistribute) {
      this.logger.warn('BLOCKED: Claim and Distribute disabled - refusing to process item', {
        depositId: item.deposit_id,
        enabledFlag: false,
      });
      return {
        success: false,
        result: 'error',
        details: { reason: 'ENABLE_CLAIM_AND_DISTRIBUTE is false' },
      };
    }

    try {
      const deposit = await this.database.getDeposit(item.deposit_id);

      if (!deposit) {
        throw new Error(`Deposit ${item.deposit_id} not found`);
      }

      this.logger.info('Processing claim and distribute for deposit', {
        depositId: deposit.deposit_id,
        ownerAddress: deposit.owner_address,
      });

      const isClaimProfitable = await this.isClaimProfitable({
        deposit,
        unclaimedRewards: await this.getUnclaimedRewards(
          deposit.deposit_id.toString(),
        ),
      });

      if (!isClaimProfitable.profitable) {
        this.logger.info('Claim not profitable', {
          reason: isClaimProfitable.reason,
        });
        return {
          success: true,
          result: 'not_profitable',
          details: { reason: isClaimProfitable.reason },
        };
      }

      // Queue the transaction
      const recipient = CONFIG.executor.tipReceiver || CONFIG.profitability.defaultTipReceiver || ethers.ZeroAddress;
      const minExpectedReward = isClaimProfitable.rewardAmount!;
      const selectedDepositIds = [BigInt(deposit.deposit_id)];
      
      const tx = {
        to: CONFIG.LST_ADDRESS,
        data: this.lstToken.interface.encodeFunctionData(
          'claimAndDistributeReward',
          [
            recipient,
            minExpectedReward,
            selectedDepositIds
          ]
        ),
        gasLimit: CONFIG.CLAIM_GAS_LIMIT || '500000',
      };

      this.logger.info('Queueing claim and distribute transaction', {
        to: tx.to,
        rewardAmount: isClaimProfitable.rewardAmount,
      });

      // Final safety check before queuing
      const finalEnableCheck = process.env.ENABLE_CLAIM_AND_DISTRIBUTE === 'true';
      if (!finalEnableCheck) {
        this.logger.error('CRITICAL: Attempted to queue transaction with ENABLE_CLAIM_AND_DISTRIBUTE=false', {
          depositId: deposit.deposit_id,
          enabledFlag: false,
        });
        throw new Error('BLOCKED: Cannot queue transaction - ENABLE_CLAIM_AND_DISTRIBUTE is false');
      }

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
            payout_amount: isClaimProfitable.rewardAmount!,
            gas_estimate: BigInt(CONFIG.CLAIM_GAS_LIMIT || '500000'),
            gas_cost: BigInt(CONFIG.CLAIM_GAS_LIMIT || '500000'),
            expected_profit: isClaimProfitable.rewardAmount!,
          },
          deposit_details: [
            {
              depositId: BigInt(deposit.deposit_id),
              rewards: isClaimProfitable.rewardAmount!,
            },
          ],
        },
        tx.data,
        TransactionType.CLAIM_AND_DISTRIBUTE,
      );

      return {
        success: true,
        result: 'queued',
        details: {
          rewardAmount: isClaimProfitable.rewardAmount!.toString(),
        },
      };
    } catch (error) {
      this.logger.error('Error processing claim and distribute', {
        itemId: item.id,
        depositId: item.deposit_id,
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
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
    // Critical safety check: Block all processing if disabled
    const enableClaimAndDistribute = process.env.ENABLE_CLAIM_AND_DISTRIBUTE === 'true';
    if (!enableClaimAndDistribute) {
      this.logger.warn('BLOCKED: Claim and Distribute disabled - refusing to process batch', {
        depositCount: deposits.length,
        enabledFlag: false,
      });
      return {
        success: false,
        total: deposits.length,
        queued: 0,
        notProfitable: 0,
        errors: deposits.length,
        details: deposits.map((deposit) => ({
          depositId: deposit.deposit_id,
          result: 'error',
          details: { reason: 'ENABLE_CLAIM_AND_DISTRIBUTE is false' },
        })),
      };
    }

    this.logger.info(
      `Processing claim and distribute batch with optimal selection for ${deposits.length} deposits`,
    );

    if (deposits.length === 0) {
      return {
        success: true,
        total: 0,
        queued: 0,
        notProfitable: 0,
        errors: 0,
        details: [],
      };
    }

    try {
      // Step 1: Get the contract payout amount and calculate optimal threshold
      let contractPayoutAmount: bigint;
      try {
        if (this.lstToken.payoutAmount) {
          contractPayoutAmount = await this.lstToken.payoutAmount();
        } else {
          contractPayoutAmount = ethers.parseEther('50'); // Default to 50 tokens if method doesn't exist
        }
      } catch (error) {
        this.logger.warn('Failed to get contract payout amount, using default', {
          error: error instanceof Error ? error.message : String(error),
        });
        contractPayoutAmount = ethers.parseEther('50'); // Default to 50 tokens
      }

      // Step 2: Get current gas costs
      const provider = this.stakerContract.runner?.provider || this.provider;
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice || BigInt('50000000000'); // 50 gwei default
      const gasLimit = BigInt(CONFIG.CLAIM_GAS_LIMIT || '500000');
      const gasCost = gasPrice * gasLimit;

      // Step 3: Calculate optimal threshold (contract payout + gas + profit margin)
      const includeGasCost = CONFIG.profitability.includeGasCost;
      const effectiveGasCost = includeGasCost ? gasCost : BigInt(0);
      const baseAmount = contractPayoutAmount + effectiveGasCost;
      const profitMargin = CONFIG.profitability.minProfitMargin || 10; // 10% default
      const profitMarginAmount = (baseAmount * BigInt(Math.floor(profitMargin * 100))) / BigInt(10000);
      const optimalThreshold = baseAmount + profitMarginAmount;

      this.logger.info('Calculated optimal threshold for batch selection', {
        contractPayoutAmount: contractPayoutAmount.toString(),
        gasCost: gasCost.toString(),
        effectiveGasCost: effectiveGasCost.toString(),
        profitMargin: `${profitMargin}%`,
        profitMarginAmount: profitMarginAmount.toString(),
        optimalThreshold: optimalThreshold.toString(),
      });

      // Step 4: Get unclaimed rewards for all deposits and create rewards map
      const depositsWithRewards: Array<{ deposit: Deposit; rewards: bigint }> = [];
      const rewardsMap = new Map<string, bigint>();

      for (const deposit of deposits) {
        try {
          const unclaimedRewards = await this.getUnclaimedRewards(deposit.deposit_id);
          if (unclaimedRewards > 0n) {
            depositsWithRewards.push({ deposit, rewards: unclaimedRewards });
            rewardsMap.set(deposit.deposit_id.toString(), unclaimedRewards);
          }
        } catch (error) {
          this.logger.warn('Failed to get rewards for deposit', {
            depositId: deposit.deposit_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (depositsWithRewards.length === 0) {
        return {
          success: true,
          total: deposits.length,
          queued: 0,
          notProfitable: deposits.length,
          errors: 0,
          details: deposits.map((deposit) => ({
            depositId: deposit.deposit_id,
            result: 'not_profitable',
            details: { reason: 'No unclaimed rewards available' },
          })),
        };
      }

      // Step 5: Sort deposits by rewards (highest first) - optimal bin packing
      const sortedDeposits = depositsWithRewards.sort((a, b) => {
        return Number(b.rewards - a.rewards); // Descending order
      });

      this.logger.info('Sorted deposits by reward amount', {
        totalDeposits: sortedDeposits.length,
        topRewards: sortedDeposits.slice(0, 3).map(d => ({
          depositId: d.deposit.deposit_id,
          rewards: d.rewards.toString(),
        })),
      });

      // Step 6: Use greedy algorithm to select optimal deposit combination
      const selectedDeposits: Deposit[] = [];
      let totalRewards = BigInt(0);
      let totalShares = BigInt(0);

      for (const { deposit, rewards } of sortedDeposits) {
        selectedDeposits.push(deposit);
        totalRewards += rewards;
        totalShares += BigInt(deposit.amount);

        this.logger.debug('Added deposit to batch', {
          depositId: deposit.deposit_id,
          rewards: rewards.toString(),
          totalRewards: totalRewards.toString(),
          optimalThreshold: optimalThreshold.toString(),
          hasReachedThreshold: totalRewards >= optimalThreshold,
        });

        // Stop when we have enough rewards to meet the optimal threshold
        if (totalRewards >= optimalThreshold) {
          this.logger.info('Reached optimal threshold, stopping deposit selection', {
            selectedCount: selectedDeposits.length,
            totalRewards: totalRewards.toString(),
            optimalThreshold: optimalThreshold.toString(),
            excessRewards: (totalRewards - optimalThreshold).toString(),
          });
          break;
        }
      }

      // Step 7: Validate that we have enough total rewards
      if (totalRewards < optimalThreshold) {
        const insufficientAmount = optimalThreshold - totalRewards;
        this.logger.error('CRITICAL: Insufficient total rewards - REJECTING TRANSACTION', {
          totalRewards: totalRewards.toString(),
          optimalThreshold: optimalThreshold.toString(),
          shortfall: insufficientAmount.toString(),
          selectedDeposits: selectedDeposits.length,
          contractPayoutAmount: contractPayoutAmount.toString(),
          profitMargin: `${profitMargin}%`,
        });

        // CRITICAL: This is unprofitable - should NEVER proceed
        return {
          success: true,
          total: deposits.length,
          queued: 0,
          notProfitable: deposits.length,
          errors: 0,
          details: deposits.map((deposit) => ({
            depositId: deposit.deposit_id,
            result: 'not_profitable',
            details: { 
              reason: `UNPROFITABLE: Insufficient combined rewards: ${totalRewards.toString()} < ${optimalThreshold.toString()}`,
            },
          })),
        };
      }

      // Step 7.5: Double-check profitability before queueing
      const finalProfitCheck = totalRewards - optimalThreshold;
      if (finalProfitCheck <= 0n) {
        this.logger.error('CRITICAL: Final profitability check failed - transaction would lose money!', {
          totalRewards: totalRewards.toString(),
          optimalThreshold: optimalThreshold.toString(),
          finalProfit: finalProfitCheck.toString(),
        });
        
        return {
          success: true,
          total: deposits.length,
          queued: 0,
          notProfitable: deposits.length,
          errors: 0,
          details: deposits.map((deposit) => ({
            depositId: deposit.deposit_id,
            result: 'not_profitable',
            details: { 
              reason: `UNPROFITABLE: Final check failed, would lose ${(-finalProfitCheck).toString()} tokens`,
            },
          })),
        };
      }

      // Step 8: Calculate minimum expected reward (total rewards minus profit margin)
      const profitMarginBasisPoints = BigInt(Math.floor(profitMargin * 100));
      const actualProfitMarginAmount = (totalRewards * profitMarginBasisPoints) / 10000n;
      const minExpectedReward = totalRewards - actualProfitMarginAmount;
      
      // Queue the optimized transaction with selected deposits
      const recipient = CONFIG.executor.tipReceiver || CONFIG.profitability.defaultTipReceiver || ethers.ZeroAddress;
      const selectedDepositIds = selectedDeposits.map((d) => BigInt(d.deposit_id));
      
      const tx = {
        to: CONFIG.LST_ADDRESS,
        data: this.lstToken.interface.encodeFunctionData(
          'claimAndDistributeReward',
          [
            recipient,
            minExpectedReward,
            selectedDepositIds
          ]
        ),
        gasLimit: CONFIG.CLAIM_GAS_LIMIT || '500000',
      };

      this.logger.info('Queueing optimized claim and distribute transaction', {
        selectedDeposits: selectedDeposits.length,
        totalDeposits: deposits.length,
        totalRewards: totalRewards.toString(),
        minExpectedReward: minExpectedReward.toString(),
        contractPayoutAmount: contractPayoutAmount.toString(),
        profitMarginAmount: actualProfitMarginAmount.toString(),
      });

      // Calculate actual profit (rewards minus costs)
      const actualProfit = totalRewards - optimalThreshold;
      
      // CRITICAL: Final validation before queuing
      if (actualProfit <= 0n) {
        this.logger.error('CRITICAL: About to queue unprofitable transaction - BLOCKING!', {
          actualProfit: actualProfit.toString(),
          totalRewards: totalRewards.toString(),
          optimalThreshold: optimalThreshold.toString(),
        });
        
        throw new Error(`CRITICAL: Attempted to queue unprofitable transaction with profit: ${actualProfit.toString()}`);
      }
      
      this.logger.info('VALIDATED: Transaction is profitable, proceeding to queue', {
        actualProfit: actualProfit.toString(),
        totalRewards: totalRewards.toString(),
        optimalThreshold: optimalThreshold.toString(),
        profitMarginPercent: ((Number(actualProfit) / Number(totalRewards)) * 100).toFixed(2) + '%',
      });

      // Final safety check before queuing batch
      const finalEnableCheck = process.env.ENABLE_CLAIM_AND_DISTRIBUTE === 'true';
      if (!finalEnableCheck) {
        this.logger.error('CRITICAL: Attempted to queue batch transaction with ENABLE_CLAIM_AND_DISTRIBUTE=false', {
          depositCount: selectedDeposits.length,
          enabledFlag: false,
        });
        throw new Error('BLOCKED: Cannot queue batch transaction - ENABLE_CLAIM_AND_DISTRIBUTE is false');
      }

      await this.executor.queueTransaction(
        selectedDeposits.map((d) => BigInt(d.deposit_id)),
        {
          is_profitable: true,
          constraints: {
            has_enough_shares: true,
            meets_min_reward: true,
            meets_min_profit: true,
          },
          estimates: {
            total_shares: totalShares,
            payout_amount: contractPayoutAmount,
            gas_estimate: gasLimit,
            gas_cost: gasCost,
            expected_profit: totalRewards, // Use total rewards, not net profit - BaseExecutor expects total reward amount
          },
          deposit_details: selectedDeposits.map((d) => ({
            depositId: BigInt(d.deposit_id),
            rewards: rewardsMap.get(d.deposit_id.toString()) || BigInt(0),
          })),
        },
        tx.data,
        TransactionType.CLAIM_AND_DISTRIBUTE,
      );

      return {
        success: true,
        total: deposits.length,
        queued: 1,
        notProfitable: deposits.length - selectedDeposits.length,
        errors: 0,
        details: [
          {
            depositId: `batch_${selectedDeposits.length}_deposits`,
            result: 'queued',
            details: {
              selectedDeposits: selectedDeposits.length,
              totalRewards: totalRewards.toString(),
              minExpectedReward: minExpectedReward.toString(),
              selectedDepositIds: selectedDeposits.map(d => d.deposit_id.toString()),
            },
          },
        ],
      };
    } catch (error) {
      this.logger.error('Error in optimized batch processing', {
        error: error instanceof Error ? error.message : String(error),
        depositCount: deposits.length,
      });
      return {
        success: false,
        total: deposits.length,
        queued: 0,
        notProfitable: 0,
        errors: deposits.length,
        details: [
          {
            depositId: 'batch_error',
            result: 'error',
            details: {
              error: error instanceof Error ? error.message : String(error),
            },
          },
        ],
      };
    }
  }

  private async isClaimProfitable({
    deposit,
    unclaimedRewards,
  }: {
    deposit: Deposit;
    unclaimedRewards: bigint;
  }): Promise<{
    profitable: boolean;
    reason?: string;
    rewardAmount?: bigint;
  }> {
    try {
      // Get current gas price
      const provider = this.stakerContract.runner?.provider || this.provider;
      const feeData = await provider.getFeeData();
      const gasPriceBigInt = feeData.gasPrice || BigInt('50000000000'); // 50 gwei default

      // Estimate gas cost
      const gasLimit = BigInt(CONFIG.CLAIM_GAS_LIMIT || '300000');
      const gasCost = gasPriceBigInt * gasLimit;

      // Check if rewards exceed gas cost with minimum profit margin
      const minProfitMargin = BigInt(
        CONFIG.govlst.minProfitMargin || '1000000000000000',
      ); // 0.001 ETH default
      const minProfit = gasCost + minProfitMargin;

      if (unclaimedRewards <= minProfit) {
        return {
          profitable: false,
          reason: `Unclaimed rewards (${unclaimedRewards}) less than minimum profit (${minProfit})`,
          rewardAmount: unclaimedRewards,
        };
      }

      return {
        profitable: true,
        rewardAmount: unclaimedRewards,
      };
    } catch (error) {
      this.logger.error('Error calculating claim profitability', {
        depositId: deposit.deposit_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        profitable: false,
        reason: `Error: ${error instanceof Error ? error.message : String(error)}`,
        rewardAmount: 0n,
      };
    }
  }

  private async getUnclaimedRewards(depositId: string): Promise<bigint> {
    try {
      const unclaimedRewards = await this.stakerContract.unclaimedReward(
        BigInt(depositId),
      );
      return BigInt(unclaimedRewards.toString());
    } catch (error) {
      this.logger.error('Error getting unclaimed rewards', {
        depositId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public async processDeposits(): Promise<void> {
    // Critical safety check: Block all processing if disabled
    const enableClaimAndDistribute = process.env.ENABLE_CLAIM_AND_DISTRIBUTE === 'true';
    if (!enableClaimAndDistribute) {
      this.logger.warn('BLOCKED: Claim and Distribute disabled - refusing to process deposits', {
        enabledFlag: false,
      });
      return;
    }

    try {
      const deposits = await this.database.getAllDeposits();
      if (!deposits.length) {
        this.logger.info('No deposits found to process');
        return;
      }

      this.logger.info('Processing claim and distribute with batch optimization', {
        count: deposits.length,
      });

      // Use the optimized batch processing instead of individual processing
      const batchResult = await this.processDepositsBatch({ deposits });
      
      this.logger.info('Batch processing completed', {
        success: batchResult.success,
        total: batchResult.total,
        queued: batchResult.queued,
        notProfitable: batchResult.notProfitable,
        errors: batchResult.errors,
      });

      if (batchResult.details.length > 0) {
        this.logger.debug('Batch processing details', {
          details: batchResult.details,
        });
      }
    } catch (error) {
      this.logger.error('Error processing deposits for claim and distribute', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.lastUpdateTimestamp = Date.now();
  }

}
