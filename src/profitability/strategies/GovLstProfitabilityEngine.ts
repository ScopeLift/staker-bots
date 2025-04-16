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
  BatchFetchError,
} from '@/configuration/errors';
import { CONFIG } from '@/configuration';

/**
 * GovLstProfitabilityEngine - Analyzes and determines profitability of GovLst deposits
 * Handles gas estimation, share calculation, and groups deposits into profitable batches
 * using single-bin accumulation strategy that queues for execution when optimal threshold is reached
 */
export class GovLstProfitabilityEngine implements IGovLstProfitabilityEngine {
  private readonly logger: Logger;
  private isRunning: boolean;
  private lastGasPrice: bigint;
  private lastUpdateTimestamp: number;
  private gasPriceCache: { price: bigint; timestamp: number } | null = null;
  public readonly config: ProfitabilityConfig;
  private static readonly BATCH_SIZE = 100; // Number of deposits to fetch in a single batch
  private activeBin: GovLstDepositGroup | null = null; // Current active bin being filled

  /**
   * Creates a new GovLstProfitabilityEngine instance
   * @param govLstContract - The GovLst contract instance with required methods
   * @param stakerContract - The staker contract instance with required methods
   * @param provider - Ethers provider for blockchain interaction
   * @param config - Configuration for profitability calculations
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
      groupCount: this.activeBin ? 1 : 0,
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

    // Get unclaimed rewards for all deposits at once
    const depositIds = deposits.map(d => d.deposit_id);
    const rewardsMap = await this.batchFetchUnclaimedRewards(depositIds);
    
    let totalRewards = BigInt(0);
    const depositDetails = [];
    const qualifiedDeposits = [];

    // Filter qualified deposits and calculate total rewards
    for (const deposit of deposits) {
      try {
        const depositId = deposit.deposit_id;
        const depositIdStr = depositId.toString();
        
        // Get deposit details from staker contract if needed
        let earningPower = deposit.earning_power;
        
        // If earning power not available, fetch from contract
        if (!earningPower || earningPower === BigInt(0)) {
          const [, , fetchedEarningPower] = await this.stakerContract.deposits(depositId);
          earningPower = fetchedEarningPower;
        }

        // Check if earning power meets minimum threshold
        if (earningPower < minQualifyingEarningPowerBips) {
          this.logger.info('Deposit does not meet minimum earning power:', {
            depositId: depositIdStr,
            earningPower: earningPower.toString(),
            minRequired: minQualifyingEarningPowerBips.toString(),
          });
          continue; // Skip this deposit
        }

        // Get unclaimed rewards from our batch results
        const unclaimedRewards = rewardsMap.get(depositIdStr) || BigInt(0);
        
        // Skip deposits with zero rewards
        if (unclaimedRewards <= BigInt(0)) {
          this.logger.info('Skipping deposit with zero rewards:', {
            depositId: depositIdStr,
          });
          continue;
        }
        
        totalRewards += unclaimedRewards;
        qualifiedDeposits.push(deposit);

        this.logger.info('Calculated rewards for deposit:', {
          depositId: depositIdStr,
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

    // Calculate total shares for qualified deposits
    const totalShares = qualifiedDeposits.reduce(
      (acc, deposit) => acc + deposit.shares_of,
      BigInt(0),
    );

    // Check constraints
    const meetsMinReward = totalRewards >= this.config.minProfitMargin;
    const meetsMinProfit = totalRewards > gasCostInRewardToken;
    const hasEnoughShares = totalShares >= CONTRACT_CONSTANTS.MIN_SHARES_THRESHOLD;

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
   * Analyzes deposits and adds them to the active bin until it reaches optimal threshold
   * When bin reaches threshold, it's marked as ready for execution
   * @param deposits Array of deposits to analyze
   * @returns Analysis with deposit groups ready for execution
   * @throws QueueProcessingError if analysis fails
   */
  private async getContractDataWithRetry<T>(
    operation: () => Promise<T>,
    context: string,
    maxRetries = 3,
    delayMs = 1000
  ): Promise<T> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(`${context} attempt ${attempt}/${maxRetries} failed:`, {
          error: lastError.message,
          attempt,
          maxRetries
        });
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
        }
      }
    }
    
    throw new Error(`${context} failed after ${maxRetries} attempts: ${lastError?.message}`);
  }

  async analyzeAndGroupDeposits(
    deposits: GovLstDeposit[],
  ): Promise<GovLstBatchAnalysis> {
    if (!deposits.length) return this.createEmptyBatchAnalysis();

    try {
      this.logger.info('Starting single-bin accumulation analysis:', {
        depositCount: deposits.length,
      });
      
      // Get payoutAmount and estimate gas costs with retry
      const payoutAmount = await this.getContractDataWithRetry(
        () => this.govLstContract.payoutAmount(),
        'Fetching payout amount'
      );
      
      const gasCost = await this.getContractDataWithRetry(
        () => this.estimateGasCostInRewardToken(),
        'Estimating gas cost'
      );
      
      const profitMargin = this.config.minProfitMargin;
      
      // Calculate optimal threshold based on payout amount, gas cost and profit margin percentage
      const effectiveGasCost = CONFIG.profitability.includeGasCost ? gasCost : BigInt(0);
      const baseAmount = payoutAmount + effectiveGasCost;
      const profitMarginAmount = (baseAmount * BigInt(profitMargin)) / BigInt(100);
      const optimalThreshold = baseAmount + profitMarginAmount;

      this.logger.info('Bin optimization parameters:', {
        optimalThreshold: ethers.formatEther(optimalThreshold),
      });

      // Fetch unclaimed rewards for all deposits in batch with retry
      const depositIds = deposits.map(d => d.deposit_id);
      const rewardsMap = await this.getContractDataWithRetry(
        () => this.batchFetchUnclaimedRewards(depositIds),
        'Fetching unclaimed rewards'
      );
      
      // Create or continue filling the active bin
      if (!this.activeBin) {
        this.activeBin = {
          deposit_ids: [],
          total_rewards: BigInt(0),
          total_shares: BigInt(0),
          expected_profit: BigInt(0),
          total_payout: payoutAmount,
          gas_estimate: GAS_CONSTANTS.FALLBACK_GAS_ESTIMATE,
        };
      }
      
      // Sort deposits by rewards in descending order for optimal filling
      const sortedDeposits = [...deposits].sort((a, b) => {
        const rewardA = rewardsMap.get(a.deposit_id.toString()) || BigInt(0);
        const rewardB = rewardsMap.get(b.deposit_id.toString()) || BigInt(0);
        return Number(rewardB - rewardA);
      });
      
      // Track which deposits were added to the bin
      const addedDeposits: GovLstDeposit[] = [];
      
      // Add deposits to the active bin until it reaches optimal threshold
      for (const deposit of sortedDeposits) {
        const depositId = deposit.deposit_id;
        const depositIdStr = depositId.toString();
        const reward = rewardsMap.get(depositIdStr) || BigInt(0);
        
        // Skip deposits with zero rewards
        if (reward <= BigInt(0)) continue;
        
        // Check if deposit already exists in the bin
        if (this.activeBin?.deposit_ids.some(id => id === depositId)) continue;

        // Add deposit to active bin
        if (this.activeBin) {
          this.activeBin.deposit_ids.push(depositId);
          this.activeBin.total_rewards += reward;
          this.activeBin.total_shares += deposit.shares_of;
          addedDeposits.push(deposit);

          // Only log when we're getting close to threshold or hit it
          const percentComplete = Number((this.activeBin.total_rewards * BigInt(100)) / optimalThreshold);
          if (percentComplete >= 90 || this.activeBin.total_rewards >= optimalThreshold) {
            this.logger.info(`Bin accumulation progress:`, {
              currentTotal: ethers.formatEther(this.activeBin.total_rewards),
              percentComplete,
              depositCount: this.activeBin.deposit_ids.length
            });
          }

          // Check if we've hit optimal threshold after adding this deposit
          if (this.activeBin.total_rewards >= optimalThreshold) {
            break;
          }
        }
      }
      
      // Check if bin has reached optimal threshold
      const readyBins: GovLstDepositGroup[] = [];
      
      if (this.activeBin?.total_rewards >= optimalThreshold) {
        // Calculate expected profit
        const expectedProfit = this.activeBin.total_rewards - gasCost;
        this.activeBin.expected_profit = expectedProfit;
        
        this.logger.info('Bin ready for execution:', {
          depositCount: this.activeBin.deposit_ids.length,
          totalRewards: ethers.formatEther(this.activeBin.total_rewards),
          expectedProfit: ethers.formatEther(expectedProfit)
        });
        
        readyBins.push(this.activeBin);
        this.activeBin = null;
      }

      return {
        deposit_groups: readyBins,
        total_gas_estimate: this.calculateTotalGasEstimate(readyBins),
        total_expected_profit: this.calculateTotalExpectedProfit(readyBins),
        total_deposits: deposits.length,
      };
    } catch (error) {
      // Enhanced error handling with more context
      const errorContext = {
        depositCount: deposits.length,
        operation: 'analyze_and_group',
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
        activeBinState: this.activeBin ? {
          depositCount: this.activeBin.deposit_ids.length,
          totalRewards: this.activeBin.total_rewards.toString(),
        } : null
      };

      this.logger.error('Failed to analyze and group deposits:', errorContext);
      throw new QueueProcessingError(error as Error, errorContext);
    }
  }

  /**
   * Checks if the active bin is profitable and ready for execution
   * @returns Boolean indicating if bin is ready for processing
   */
  async isActiveBinReady(): Promise<boolean> {
    if (!this.activeBin || this.activeBin.deposit_ids.length === 0) {
      return false;
    }
    
    // Get current gas cost and payout amount
    const gasCost = await this.estimateGasCostInRewardToken();
    const payoutAmount = await this.govLstContract.payoutAmount();
    const profitMargin = this.config.minProfitMargin;
    
    // Calculate optimal threshold
    const optimalThreshold = payoutAmount + gasCost + 
      ((payoutAmount + gasCost) * BigInt(profitMargin)) / BigInt(100);
    
    // Check if bin has reached threshold
    const isReady = this.activeBin.total_rewards >= optimalThreshold;
    
    if (isReady) {
      this.logger.info('Active bin is ready for execution:', {
        depositCount: this.activeBin.deposit_ids.length,
        totalRewards: this.activeBin.total_rewards.toString(),
        threshold: optimalThreshold.toString(),
        rewardsInEther: ethers.formatEther(this.activeBin.total_rewards),
      });
    }
    
    return isReady;
  }
  
  /**
   * Calculates profitability metrics for the active bin
   * @returns Profitability check result for the active bin
   */
  async calculateActiveBinProfitability(): Promise<GovLstProfitabilityCheck | null> {
    if (!this.activeBin || this.activeBin.deposit_ids.length === 0) {
      return null;
    }
    
    const gasCost = await this.estimateGasCostInRewardToken();
    const payoutAmount = await this.govLstContract.payoutAmount();
    
    // Calculate expected profit
    const expectedProfit = this.activeBin.total_rewards > gasCost
      ? this.activeBin.total_rewards - gasCost
      : BigInt(0);
    
    this.activeBin.expected_profit = expectedProfit;
    this.activeBin.gas_estimate = GAS_CONSTANTS.FALLBACK_GAS_ESTIMATE;
    this.activeBin.total_payout = payoutAmount;
    
    // Generate deposit details for profitability check
    const depositDetails = await Promise.all(
      this.activeBin.deposit_ids.map(async (id) => {
        const reward = await this.stakerContract.unclaimedReward(id);
        return {
          depositId: id,
          rewards: reward,
        };
      })
    );
    
    // Check profitability constraints
    const meetsMinReward = this.activeBin.total_rewards >= this.config.minProfitMargin;
    const meetsMinProfit = expectedProfit > BigInt(0);
    const hasEnoughShares = this.activeBin.total_shares >= CONTRACT_CONSTANTS.MIN_SHARES_THRESHOLD;
    
    return {
      is_profitable: meetsMinReward && meetsMinProfit && hasEnoughShares,
      constraints: {
        meets_min_reward: meetsMinReward,
        meets_min_profit: meetsMinProfit,
        has_enough_shares: hasEnoughShares,
      },
      estimates: {
        total_shares: this.activeBin.total_shares,
        payout_amount: payoutAmount,
        gas_estimate: GAS_CONSTANTS.FALLBACK_GAS_ESTIMATE,
        expected_profit: expectedProfit,
      },
      deposit_details: depositDetails,
    };
  }
  
  /**
   * Gets the current active bin
   * @returns The current active bin or null if none exists
   */
  getActiveBin(): GovLstDepositGroup | null {
    return this.activeBin;
  }
  
  /**
   * Resets the active bin
   */
  resetActiveBin(): void {
    this.activeBin = null;
    this.logger.info('Active bin has been reset');
  }

  /**
   * Fetches unclaimed rewards for multiple deposit IDs in batch
   */
  private async batchFetchUnclaimedRewards(depositIds: bigint[]): Promise<Map<string, bigint>> {
    try {
      const rewardsMap = new Map<string, bigint>();
      const batchSize = GovLstProfitabilityEngine.BATCH_SIZE;
      
      for (let i = 0; i < depositIds.length; i += batchSize) {
        const batchIds = depositIds.slice(i, i + batchSize);
        
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        await Promise.all(
          batchIds.map(async (id) => {
            try {
              const reward = await this.stakerContract.unclaimedReward(id);
              rewardsMap.set(id.toString(), reward);
            } catch (error) {
              this.logger.error(`Error fetching reward for deposit ${id}:`, { error });
            }
          })
        );
      }
      
      return rewardsMap;
    } catch (error) {
      throw new BatchFetchError(error as Error, {
        depositCount: depositIds.length,
        operation: 'batch_fetch_rewards',
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
   * Estimates the gas cost of claiming rewards in terms of reward tokens
   * Uses current gas price and configured price assumptions
   * @returns Estimated gas cost denominated in reward tokens
   */
  private async estimateGasCostInRewardToken(): Promise<bigint> {
    // Get current gas price and estimate gas cost
    const gasPrice = await this.getGasPriceWithBuffer();
    const gasLimit = BigInt(300000); // Estimated gas limit for claim
    const gasCost = gasPrice * gasLimit;

    // Use hardcoded prices for testing
    // ETH price: $1800, Token price: $1
    const ethPriceScaled = BigInt(1800) * BigInt(1e18);
    const rewardTokenPriceScaled = BigInt(1) * BigInt(1e18);

    // Calculate gas cost in reward tokens
    return (gasCost * ethPriceScaled) / rewardTokenPriceScaled;
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
}