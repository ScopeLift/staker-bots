import { ethers } from 'ethers';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { IGovLstProfitabilityEngine } from '../interfaces/IProfitabilityEngine';
import {
  GovLstDeposit,
  GovLstProfitabilityCheck,
  GovLstBatchAnalysis,
  GovLstDepositGroup,
  ProfitabilityConfig,
} from '../interfaces/types';
import { GAS_CONSTANTS, CONTRACT_CONSTANTS, EVENTS } from '../constants';
import {
  GasEstimationError,
  QueueProcessingError,
} from '@/configuration/errors';

/**
 * GovLstProfitabilityEngine - Analyzes and determines profitability of GovLst deposits
 * Handles gas estimation, share calculation, and grouping deposits into profitable batches
 */
export class GovLstProfitabilityEngine implements IGovLstProfitabilityEngine {
  private readonly logger: Logger;
  private isRunning: boolean;
  private lastGasPrice: bigint;
  private lastUpdateTimestamp: number;
  private gasPriceCache: { price: bigint; timestamp: number } | null = null;
  public readonly config: ProfitabilityConfig;

  /**
   * Creates a new GovLstProfitabilityEngine instance
   * @param govLstContract - The GovLst contract instance with required methods
   * @param stakerContract - The staker contract instance with required methods
   * @param provider - Ethers provider for blockchain interaction
   * @param config - Configuration for profitability calculations
   * @param priceFeed - Price feed for token price conversions
   */
  constructor(
    private readonly govLstContract: ethers.Contract & {
      payoutAmount(): Promise<bigint>;
      claimAndDistributeReward(
        recipient: string,
        minExpectedReward: bigint,
        depositIds: bigint[],
      ): Promise<void>;
      depositIdForHolder(account: string): Promise<bigint>;
      minQualifyingEarningPowerBips(): Promise<bigint>;
    },
    private readonly stakerContract: ethers.Contract & {
      balanceOf(account: string): Promise<bigint>;
      deposits(
        depositId: bigint,
      ): Promise<[string, bigint, bigint, string, string]>;
      unclaimedReward(depositId: bigint): Promise<bigint>;
    },
    private readonly provider: ethers.Provider,
    config: ProfitabilityConfig,
  ) {
    this.logger = new ConsoleLogger('info');
    this.isRunning = false;
    this.lastGasPrice = BigInt(0);
    this.lastUpdateTimestamp = 0;
    this.config = config;
  }

  /**
   * Starts the profitability engine
   * Enables processing of deposits and profitability calculations
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info(EVENTS.ENGINE_STARTED);
  }

  /**
   * Stops the profitability engine
   * Halts all deposit processing and calculations
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.logger.info(EVENTS.ENGINE_STOPPED);
  }

  /**
   * Gets the current status of the profitability engine
   * @returns Object containing running state, gas prices, and queue metrics
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    lastGasPrice: bigint;
    lastUpdateTimestamp: number;
    queueSize: number;
    groupCount: number;
  }> {
    return {
      isRunning: this.isRunning,
      lastGasPrice: this.lastGasPrice,
      lastUpdateTimestamp: this.lastUpdateTimestamp,
      queueSize: 0,
      groupCount: 0,
    };
  }

  /**
   * Checks if a group of deposits can be profitably claimed
   * Calculates total shares, payout amount, gas costs and expected profit
   * @param deposits Array of deposits to check
   * @returns Profitability analysis for the deposit group
   * @throws {GasEstimationError} If gas estimation fails
   * @throws {QueueProcessingError} If processing fails
   */
  async checkGroupProfitability(
    deposits: GovLstDeposit[],
  ): Promise<GovLstProfitabilityCheck> {
    const payoutAmount = await this.govLstContract.payoutAmount();
    const minQualifyingEarningPowerBips =
      await this.govLstContract.minQualifyingEarningPowerBips();

    this.logger.info('Current payout amount:', {
      payoutAmount: payoutAmount.toString(),
      payoutAmountInEther: ethers.formatEther(payoutAmount),
    });

    let totalRewards = BigInt(0);
    const depositDetails = [];

    for (const deposit of deposits) {
      try {
        // Use deposit ID from the database
        const depositId = deposit.deposit_id;

        this.logger.info('Using deposit ID from database:', {
          depositId: depositId.toString(),
          depositor: deposit.depositor_address,
          owner: deposit.owner_address,
        });

        // Get deposit details from staker contract
        if (!this.stakerContract.deposits) {
          throw new Error('Contract method deposits not found');
        }
        const [, , earningPower] =
          await this.stakerContract.deposits(depositId);

        // Check if earning power meets minimum threshold
        if (earningPower < minQualifyingEarningPowerBips) {
          this.logger.info('Deposit does not meet minimum earning power:', {
            depositId: depositId.toString(),
            earningPower: earningPower.toString(),
            minRequired: minQualifyingEarningPowerBips.toString(),
          });
          continue; // Skip this deposit
        }

        // Get unclaimed rewards
        const unclaimedRewards =
          await this.stakerContract.unclaimedReward(depositId);
        totalRewards += unclaimedRewards;

        this.logger.info('Calculated rewards for deposit:', {
          depositId: depositId.toString(),
          depositor: deposit.depositor_address,
          owner: deposit.owner_address,
          rewards: unclaimedRewards.toString(),
          rewardsInEther: ethers.formatEther(unclaimedRewards),
          earningPower: earningPower.toString(),
        });

        depositDetails.push({
          depositId,
          rewards: unclaimedRewards,
        });
      } catch (error) {
        this.logger.error('Error processing deposit:', {
          error,
          depositId: deposit.deposit_id.toString(),
          depositor: deposit.depositor_address,
          owner: deposit.owner_address,
        });
        throw error;
      }
    }

    // Calculate gas cost in reward token
    const gasCostInRewardToken = await this.estimateGasCostInRewardToken();

    // Calculate total shares and payout amount
    const totalShares = deposits.reduce(
      (acc, deposit) => acc + deposit.shares_of,
      BigInt(0),
    );

    // Check constraints
    const meetsMinReward = totalRewards >= this.config.minProfitMargin;
    const meetsMinProfit = totalRewards > gasCostInRewardToken;
    const hasEnoughShares =
      totalShares >= CONTRACT_CONSTANTS.MIN_SHARES_THRESHOLD;

    // Calculate expected profit (total rewards minus gas cost)
    const expectedProfit =
      totalRewards > gasCostInRewardToken
        ? totalRewards - gasCostInRewardToken
        : BigInt(0);

    return {
      is_profitable: meetsMinReward && meetsMinProfit && hasEnoughShares,
      constraints: {
        meets_min_reward: meetsMinReward,
        meets_min_profit: meetsMinProfit,
        has_enough_shares: hasEnoughShares,
      },
      estimates: {
        total_shares: totalShares,
        payout_amount: payoutAmount,
        gas_estimate: GAS_CONSTANTS.FALLBACK_GAS_ESTIMATE,
        expected_profit: expectedProfit,
      },
      deposit_details: depositDetails,
    };
  }

  /**
   * Analyzes deposits and groups them into profitable batches
   * Sorts deposits by shares and creates optimal groups for claiming
   * @param deposits Array of deposits to analyze
   * @returns Analysis of deposit groups with profitability metrics
   * @throws QueueProcessingError if analysis fails
   */
  async analyzeAndGroupDeposits(
    deposits: GovLstDeposit[],
  ): Promise<GovLstBatchAnalysis> {
    if (!deposits.length) return this.createEmptyBatchAnalysis();

    try {
      const sortedDeposits = this.sortDepositsByShares(deposits);
      const payoutAmount = await this.govLstContract.payoutAmount();
      const depositGroups = await this.createProfitableGroups(
        sortedDeposits,
        payoutAmount,
      );

      return {
        deposit_groups: depositGroups,
        total_gas_estimate: this.calculateTotalGasEstimate(depositGroups),
        total_expected_profit: this.calculateTotalExpectedProfit(depositGroups),
        total_deposits: deposits.length,
      };
    } catch (error) {
      throw new QueueProcessingError(error as Error, {
        depositCount: deposits.length,
        operation: 'analyze_and_group',
      });
    }
  }

  /**
   * Gets current gas price with buffer added for safety margin
   * Caches results to avoid excessive provider calls
   * @returns Current gas price with buffer applied
   * @throws GasEstimationError if gas price fetch fails
   */
  private async getGasPriceWithBuffer(): Promise<bigint> {
    const now = Date.now();
    if (
      this.gasPriceCache &&
      now - this.gasPriceCache.timestamp <
        GAS_CONSTANTS.GAS_PRICE_UPDATE_INTERVAL
    ) {
      return this.gasPriceCache.price;
    }

    try {
      const feeData = await this.provider.getFeeData();
      const gasPrice = feeData.gasPrice ?? BigInt(0);
      const buffer = BigInt(Math.floor(this.config.gasPriceBuffer));
      const bufferedGasPrice = gasPrice + (gasPrice * buffer) / BigInt(100);

      this.gasPriceCache = {
        price: bufferedGasPrice,
        timestamp: now,
      };
      this.lastGasPrice = bufferedGasPrice;
      this.lastUpdateTimestamp = now;

      return bufferedGasPrice;
    } catch (error) {
      throw new GasEstimationError(error as Error, {
        lastGasPrice: this.lastGasPrice.toString(),
        lastUpdateTimestamp: this.lastUpdateTimestamp,
      });
    }
  }

  /**
   * Estimates gas required for claiming rewards for given deposit IDs
   * @param depositIds Array of deposit IDs to estimate gas for
   * @returns Estimated gas amount or fallback value
   * @throws GasEstimationError if estimation fails
   */
  private async estimateClaimGas(depositIds: bigint[]): Promise<bigint> {
    try {
      const payoutAmount = await this.govLstContract.payoutAmount();
      const minExpectedReward = payoutAmount / BigInt(2);

      const gasEstimate = await this.provider.estimateGas({
        to: this.govLstContract.target,
        data: this.govLstContract.interface.encodeFunctionData(
          'claimAndDistributeReward',
          [CONTRACT_CONSTANTS.ZERO_ADDRESS, minExpectedReward, depositIds],
        ),
      });

      return gasEstimate || GAS_CONSTANTS.FALLBACK_GAS_ESTIMATE;
    } catch (error) {
      throw new GasEstimationError(error as Error, {
        depositIds: depositIds.map((id) => id.toString()),
        operation: 'estimate_claim_gas',
      });
    }
  }

  /**
   * Calculates total shares for a group of deposits
   * @param deposits Array of deposits to sum shares for
   * @returns Total shares across all deposits
   */
  private async calculateTotalShares(
    deposits: GovLstDeposit[],
  ): Promise<bigint> {
    const shares = await Promise.all(
      deposits.map(async (deposit) => {
        try {
          const balance = await this.stakerContract.balanceOf(
            deposit.owner_address,
          );
          this.logger.info(`Got balance for ${deposit.owner_address}:`, {
            balance: balance.toString(),
          });
          return balance;
        } catch (error) {
          this.logger.error(
            `Failed to get balance for ${deposit.owner_address}:`,
            {
              error:
                error instanceof Error
                  ? {
                      message: error.message,
                      stack: error.stack,
                      // @ts-expect-error Error type from ethers may include additional properties
                      code: error.code,
                      // @ts-expect-error Error type from ethers may include additional properties
                      data: error.data,
                      // @ts-expect-error Error type from ethers may include additional properties
                      transaction: error.transaction,
                    }
                  : String(error),
            },
          );
          return 0n;
        }
      }),
    );
    const totalShares = shares.reduce((sum, share) => sum + share, BigInt(0));
    this.logger.info('Total shares calculated:', {
      totalShares: totalShares.toString(),
    });
    return totalShares;
  }

  /**
   * Sorts deposits by share amount in descending order
   * @param deposits Array of deposits to sort
   * @returns Sorted array of deposits
   */
  private sortDepositsByShares(deposits: GovLstDeposit[]): GovLstDeposit[] {
    return [...deposits].sort((a, b) => Number(b.shares_of - a.shares_of));
  }

  /**
   * Creates groups of deposits that would be profitable to claim
   * Groups deposits until they exceed payout amount, then checks profitability
   * @param deposits Array of deposits to group
   * @param payoutAmount Current payout amount from contract
   * @returns Array of profitable deposit groups
   * @throws QueueProcessingError if grouping fails
   */
  private async createProfitableGroups(
    deposits: GovLstDeposit[],
    payoutAmount: bigint,
  ): Promise<GovLstDepositGroup[]> {
    const groups: GovLstDepositGroup[] = [];
    let currentGroup: GovLstDeposit[] = [];
    let currentTotalShares = BigInt(0);

    this.logger.info('Starting profitable group creation:', {
      totalDeposits: deposits.length,
      payoutAmount: payoutAmount.toString(),
    });

    try {
      for (const deposit of deposits) {
        // Get current shares for this deposit
        const shares = await this.stakerContract.balanceOf(
          deposit.owner_address,
        );

        this.logger.info('Checking deposit shares:', {
          depositId: deposit.deposit_id,
          owner: deposit.owner_address,
          shares: shares.toString(),
        });

        // Skip deposits with no shares (could be withdrawn or never staked)
        if (shares <= BigInt(0)) {
          this.logger.info('Skipping deposit with no shares:', {
            depositId: deposit.deposit_id,
            owner: deposit.owner_address,
          });
          continue;
        }

        // Add deposit to current group
        currentGroup.push({ ...deposit, shares_of: shares });
        currentTotalShares += shares;

        this.logger.info('Added deposit to current group:', {
          depositId: deposit.deposit_id,
          groupSize: currentGroup.length,
          currentTotalShares: currentTotalShares.toString(),
          payoutThreshold: payoutAmount.toString(),
        });

        // Check if current group exceeds payout amount or max batch size
        const isOverPayout = currentTotalShares > payoutAmount;
        const isMaxBatchSize = currentGroup.length >= this.config.maxBatchSize;

        if (isOverPayout || isMaxBatchSize) {
          this.logger.info('Group threshold reached:', {
            reason: isOverPayout ? 'payout exceeded' : 'max batch size',
            groupSize: currentGroup.length,
            totalShares: currentTotalShares.toString(),
          });

          // Check profitability of current group
          const profitability =
            await this.checkGroupProfitability(currentGroup);

          this.logger.info('Group profitability check:', {
            isProfitable: profitability.is_profitable,
            expectedProfit: profitability.estimates.expected_profit.toString(),
            gasEstimate: profitability.estimates.gas_estimate.toString(),
            depositCount: currentGroup.length,
          });

          if (profitability.is_profitable) {
            groups.push({
              deposit_ids: currentGroup.map((d) => d.deposit_id),
              total_shares: profitability.estimates.total_shares,
              total_payout: profitability.estimates.payout_amount,
              expected_profit: profitability.estimates.expected_profit,
              gas_estimate: profitability.estimates.gas_estimate,
            });

            this.logger.info('Added profitable group:', {
              groupIndex: groups.length - 1,
              depositIds: currentGroup.map((d) => d.deposit_id),
              expectedProfit:
                profitability.estimates.expected_profit.toString(),
            });
          }

          // Reset for next group
          currentGroup = [];
          currentTotalShares = BigInt(0);
        }
      }

      // Check final group if not empty
      if (currentGroup.length > 0) {
        this.logger.info('Checking final group:', {
          size: currentGroup.length,
          totalShares: currentTotalShares.toString(),
        });

        const profitability = await this.checkGroupProfitability(currentGroup);
        if (profitability.is_profitable) {
          groups.push({
            deposit_ids: currentGroup.map((d) => d.deposit_id),
            total_shares: profitability.estimates.total_shares,
            total_payout: profitability.estimates.payout_amount,
            expected_profit: profitability.estimates.expected_profit,
            gas_estimate: profitability.estimates.gas_estimate,
          });

          this.logger.info('Added final profitable group:', {
            groupIndex: groups.length - 1,
            depositIds: currentGroup.map((d) => d.deposit_id),
            expectedProfit: profitability.estimates.expected_profit.toString(),
          });
        }
      }

      this.logger.info('Profitable group creation complete:', {
        totalGroups: groups.length,
        totalDepositsProcessed: deposits.length,
        groupSizes: groups.map((g) => g.deposit_ids.length),
      });

      return groups;
    } catch (error) {
      this.logger.error('Error creating profitable groups:', {
        error: error instanceof Error ? error.message : String(error),
        depositCount: deposits.length,
        currentGroupSize: currentGroup.length,
      });

      throw new QueueProcessingError(error as Error, {
        depositCount: deposits.length,
        currentGroupSize: currentGroup.length,
        operation: 'create_profitable_groups',
      });
    }
  }

  /**
   * Calculates total gas estimate across all deposit groups
   * @param groups Array of deposit groups to sum gas estimates for
   * @returns Total gas estimate
   */
  private calculateTotalGasEstimate(groups: GovLstDepositGroup[]): bigint {
    return groups.reduce((sum, group) => sum + group.gas_estimate, BigInt(0));
  }

  /**
   * Calculates total expected profit across all deposit groups
   * @param groups Array of deposit groups to sum profits for
   * @returns Total expected profit
   */
  private calculateTotalExpectedProfit(groups: GovLstDepositGroup[]): bigint {
    return groups.reduce(
      (sum, group) => sum + group.expected_profit,
      BigInt(0),
    );
  }

  /**
   * Creates a default empty batch analysis result
   * Used when deposits array is empty
   * @returns Default empty batch analysis
   */
  private createEmptyBatchAnalysis(): GovLstBatchAnalysis {
    return {
      deposit_groups: [],
      total_gas_estimate: BigInt(0),
      total_expected_profit: BigInt(0),
      total_deposits: 0,
    };
  }

  /**
   * Estimates the gas cost of claiming rewards in terms of reward tokens
   * Uses current gas price and hardcoded price assumptions for testing:
   * - ETH price: $1800
   * - Reward token price: $1
   * Calculates: (gasPrice * gasLimit * ethPrice) / tokenPrice
   * @returns Estimated gas cost denominated in reward tokens (scaled to 18 decimals)
   */

  private async estimateGasCostInRewardToken(): Promise<bigint> {
    // Get current gas price and estimate gas cost
    const gasPrice = await this.provider.getFeeData();
    const gasLimit = BigInt(300000); // Estimated gas limit for claim
    const gasCost = (gasPrice.gasPrice || BigInt(0)) * gasLimit;

    // Use hardcoded prices for testing
    // ETH price: $1800, Token price: $1
    const ethPriceScaled = BigInt(1800) * BigInt(1e18);
    const rewardTokenPriceScaled = BigInt(1) * BigInt(1e18);

    // Calculate gas cost in reward tokens
    return (gasCost * ethPriceScaled) / rewardTokenPriceScaled;
  }
}
