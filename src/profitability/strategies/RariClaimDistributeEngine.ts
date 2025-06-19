import { ethers } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { IProfitabilityEngine } from '../interfaces/IProfitabilityEngine';
import { IExecutor } from '../../executor/interfaces/IExecutor';
import { IDatabase } from '../../database/interfaces/IDatabase';
import { BaseProfitabilityEngine } from './BaseProfitabilityEngine';
import { Deposit, ProcessingQueueItem } from '../../database/interfaces/types';
import {
  ProfitabilityQueueBatchResult,
  ProfitabilityQueueResult,
} from '../interfaces/types';
import { CONFIG } from '../../configuration';
import { IPriceFeed } from '../../shared/price-feeds/interfaces';
import { ProfitabilityConfig } from '../interfaces/types';
import { BinaryEligibilityOracleEarningPowerCalculator } from '@/calculator';

export class RariClaimDistributeEngine
  extends BaseProfitabilityEngine
  implements IProfitabilityEngine
{
  private readonly lstToken: ethers.Contract & {
    getUnclaimedRewards(): Promise<bigint>;
  };
  protected readonly database: IDatabase;
  protected readonly executor: IExecutor;
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
  private readonly PERIODIC_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
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
    executor: IExecutor;
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

    // Initialize LST token contract
    this.lstToken = new ethers.Contract(
      CONFIG.LST_ADDRESS,
      [
        'function getUnclaimedRewards() external view returns (uint256)',
        'function claimAndDistributeReward() external',
      ],
      provider,
    ) as ethers.Contract & {
      getUnclaimedRewards(): Promise<bigint>;
    };
  }

  /**
   * Start periodic checks for claim opportunities
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;
    this.lastUpdateTimestamp = Date.now();
    this.logger.info('Starting Rari Claim and Distribute Engine');

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
      const tx = {
        to: CONFIG.LST_ADDRESS,
        data: this.lstToken.interface.encodeFunctionData(
          'claimAndDistributeReward',
          [],
        ),
        gasLimit: CONFIG.CLAIM_GAS_LIMIT || '500000',
      };

      this.logger.info('Queueing claim and distribute transaction', {
        to: tx.to,
        rewardAmount: isClaimProfitable.rewardAmount,
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
    this.logger.info(
      `Processing claim and distribute for ${deposits.length} deposits`,
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

    // For claim and distribute, we only need to check profitability once
    // as it's a global operation, not per-deposit
    // We know deposits[0] exists because we checked length above
    // TypeScript doesn't understand our length check guarantees an element exists
    const firstDeposit = deposits[0]!;

    try {
      const unclaimedRewards = await this.getUnclaimedRewards(
        firstDeposit.deposit_id,
      );
      const isClaimProfitable = await this.isClaimProfitable({
        deposit: firstDeposit,
        unclaimedRewards,
      });

      if (!isClaimProfitable.profitable) {
        return {
          success: true,
          total: deposits.length,
          queued: 0,
          notProfitable: deposits.length,
          errors: 0,
          details: deposits.map((deposit) => ({
            depositId: deposit.deposit_id,
            result: 'not_profitable',
            details: { reason: isClaimProfitable.reason },
          })),
        };
      }

      // If profitable, queue one transaction
      const tx = {
        to: CONFIG.LST_ADDRESS,
        data: this.lstToken.interface.encodeFunctionData(
          'claimAndDistributeReward',
          [],
        ),
        gasLimit: CONFIG.CLAIM_GAS_LIMIT || '500000',
      };

      await this.executor.queueTransaction(
        deposits.map((d) => BigInt(d.deposit_id)),
        {
          is_profitable: true,
          constraints: {
            has_enough_shares: true,
            meets_min_reward: true,
            meets_min_profit: true,
          },
          estimates: {
            total_shares: deposits.reduce(
              (sum, d) => sum + BigInt(d.amount),
              0n,
            ),
            payout_amount: isClaimProfitable.rewardAmount!,
            gas_estimate: BigInt(CONFIG.CLAIM_GAS_LIMIT || '500000'),
            gas_cost: BigInt(CONFIG.CLAIM_GAS_LIMIT || '500000'),
            expected_profit: isClaimProfitable.rewardAmount!,
          },
          deposit_details: deposits.map((d) => ({
            depositId: BigInt(d.deposit_id),
            rewards: isClaimProfitable.rewardAmount!,
          })),
        },
        tx.data,
      );

      return {
        success: true,
        total: deposits.length,
        queued: 1, // Only one transaction regardless of deposit count
        notProfitable: 0,
        errors: 0,
        details: [
          {
            depositId: 'global', // Not tied to a specific deposit
            result: 'queued',
            details: {
              rewardAmount: isClaimProfitable.rewardAmount!.toString(),
            },
          },
        ],
      };
    } catch (error) {
      this.logger.error('Error processing first deposit', {
        depositId: firstDeposit.deposit_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        total: deposits.length,
        queued: 0,
        notProfitable: 0,
        errors: deposits.length,
        details: [
          {
            depositId: firstDeposit.deposit_id,
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
    try {
      const deposits = await this.database.getAllDeposits();
      if (!deposits.length) {
        this.logger.info('No deposits found to process');
        return;
      }

      this.logger.info('Processing claim and distribute for deposits', {
        count: deposits.length,
      });

      for (const deposit of deposits) {
        try {
          const unclaimedRewards = await this.getUnclaimedRewards(
            deposit.deposit_id,
          );

          if (unclaimedRewards <= 0n) {
            this.logger.debug('No unclaimed rewards for deposit', {
              depositId: deposit.deposit_id,
              unclaimedRewards: unclaimedRewards.toString(),
            });
            continue;
          }

          // Process claim if profitable
          const isClaimProfitable = await this.isClaimProfitable({
            deposit,
            unclaimedRewards,
          });

          if (!isClaimProfitable.profitable) {
            this.logger.debug('Claim not profitable for deposit', {
              depositId: deposit.deposit_id,
              reason: isClaimProfitable.reason,
            });
            continue;
          }

          // Queue the claim transaction
          await this.queueClaimTransaction(deposit, unclaimedRewards);
        } catch (error) {
          this.logger.error('Error processing deposit for claim', {
            depositId: deposit.deposit_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.logger.error('Error processing deposits for claim and distribute', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.lastUpdateTimestamp = Date.now();
  }

  private async queueClaimTransaction(
    deposit: Deposit,
    unclaimedRewards: bigint,
  ): Promise<void> {
    // Create transaction data
    const claimInterface = new ethers.Interface([
      'function claimReward(uint256 depositId)',
    ]);

    const data = claimInterface.encodeFunctionData('claimReward', [
      deposit.deposit_id,
    ]);

    const tx = {
      to: CONFIG.STAKER_CONTRACT_ADDRESS,
      data,
      gasLimit: CONFIG.CLAIM_GAS_LIMIT || '300000',
    };

    this.logger.info('Queueing claim transaction', {
      depositId: deposit.deposit_id,
      unclaimedRewards: unclaimedRewards.toString(),
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
          payout_amount: unclaimedRewards,
          gas_estimate: BigInt(CONFIG.CLAIM_GAS_LIMIT || '300000'),
          gas_cost: BigInt(CONFIG.CLAIM_GAS_LIMIT || '300000'),
          expected_profit: unclaimedRewards,
        },
        deposit_details: [
          {
            depositId: BigInt(deposit.deposit_id),
            rewards: unclaimedRewards,
          },
        ],
      },
      tx.data,
    );
  }
}
