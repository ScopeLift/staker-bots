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
import { ErrorLogger } from '@/configuration/errorLogger';

/**
 * Updated ProfitabilityConfig to include errorLogger
 */
export interface EnhancedProfitabilityConfig extends ProfitabilityConfig {
  errorLogger?: ErrorLogger;
}

/**
 * GovLstProfitabilityEngine - Analyzes and determines profitability of GovLst deposits
 * Handles gas estimation, share calculation, and groups deposits into profitable batches
 * using single-bin accumulation strategy that queues for execution when optimal threshold is reached
 */
export class GovLstProfitabilityEngine implements IGovLstProfitabilityEngine {
  private readonly logger: Logger;
  private readonly errorLogger?: ErrorLogger;
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
    config: EnhancedProfitabilityConfig,
  ) {
    this.logger = new ConsoleLogger('info');
    this.errorLogger = config.errorLogger;
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
    try {
      if (this.isRunning) return;
      this.isRunning = true;
      this.logger.info(EVENTS.ENGINE_STARTED);
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'start',
          method: 'GovLstProfitabilityEngine.start',
        });
      }
      throw error;
    }
  }

  /**
   * Stops the profitability engine
   * Halts all deposit processing and calculations
   */
  async stop(): Promise<void> {
    try {
      if (!this.isRunning) return;
      this.isRunning = false;
      this.logger.info(EVENTS.ENGINE_STOPPED);
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'stop',
          method: 'GovLstProfitabilityEngine.stop',
        });
      }
      throw error;
    }
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
    try {
      return {
        isRunning: this.isRunning,
        lastGasPrice: this.lastGasPrice,
        lastUpdateTimestamp: this.lastUpdateTimestamp,
        queueSize: 0,
        groupCount: this.activeBin ? 1 : 0,
      };
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'getStatus',
          method: 'GovLstProfitabilityEngine.getStatus',
        });
      }
      throw error;
    }
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
    try {
      const payoutAmount = await this.govLstContract.payoutAmount();
      const minQualifyingEarningPowerBips =
        await this.govLstContract.minQualifyingEarningPowerBips();

      // Get unclaimed rewards for all deposits at once
      const depositIds = deposits.map((d) => d.deposit_id);
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
            const [, , fetchedEarningPower] =
              await this.stakerContract.deposits(depositId);
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
          
          if (this.errorLogger) {
            await this.errorLogger.error(error as Error, {
              context: 'checkGroupProfitability',
              depositId: deposit.deposit_id.toString(),
              depositor: deposit.depositor_address,
              owner: deposit.owner_address,
            });
          }
          
          throw error;
        }
      }

      // Calculate gas cost in reward token
      const gasCostInRewardToken = await this.estimateGasCostInRewardToken();

      // Calculate total shares for qualified deposits
      const totalShares = qualifiedDeposits.reduce(
        (sum, deposit) => sum + (deposit.earning_power || BigInt(0)),
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
          gas_cost: gasCostInRewardToken,
          expected_profit: expectedProfit,
        },
        deposit_details: depositDetails,
      };
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'checkGroupProfitability',
          method: 'GovLstProfitabilityEngine.checkGroupProfitability',
          depositCount: deposits.length,
        });
      }
      throw error;
    }
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
    delayMs = 1000,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(
          `${context} attempt ${attempt}/${maxRetries} failed:`,
          {
            error: lastError.message,
            attempt,
            maxRetries,
          },
        );

        if (this.errorLogger) {
          await this.errorLogger.warn(lastError, {
            context,
            attempt,
            maxRetries,
            method: 'getContractDataWithRetry',
          });
        }

        if (attempt < maxRetries) {
          await new Promise((resolve) =>
            setTimeout(resolve, delayMs * attempt),
          );
        }
      }
    }

    const errorMessage = `${context} failed after ${maxRetries} attempts: ${lastError?.message}`;
    
    if (this.errorLogger) {
      await this.errorLogger.error(new Error(errorMessage), {
        context,
        maxRetries,
        method: 'getContractDataWithRetry',
      });
    }
    
    throw new Error(errorMessage);
  }

  // Add these helper functions at the top of the class
  private convertDatabaseDeposit(deposit: {
    deposit_id: string;
    owner_address: string;
    depositor_address?: string;
    delegatee_address: string;
    amount: string;
    earning_power?: string;
  }): GovLstDeposit {
    try {
      return {
        deposit_id: BigInt(deposit.deposit_id),
        owner_address: deposit.owner_address,
        depositor_address: deposit.depositor_address,
        delegatee_address: deposit.delegatee_address || '',
        amount: BigInt(deposit.amount),
        shares_of: BigInt(deposit.amount), // Default to amount if not specified
        payout_amount: BigInt(0), // Will be set during processing
        rewards: BigInt(0), // Will be calculated
        earning_power: deposit.earning_power ? BigInt(deposit.earning_power) : BigInt(0),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    } catch (error) {
      if (this.errorLogger) {
        this.errorLogger.error(error as Error, {
          context: 'convertDatabaseDeposit',
          method: 'GovLstProfitabilityEngine.convertDatabaseDeposit',
          deposit: JSON.stringify(deposit),
        });
      }
      throw error;
    }
  }

  async analyzeAndGroupDeposits(deposits: GovLstDeposit[]): Promise<GovLstBatchAnalysis> {
    try {
      if (!deposits.length) return this.createEmptyBatchAnalysis();

      this.logger.info('Starting single-bin accumulation analysis:', {
        depositCount: deposits.length,
      });

      // Convert any string values to BigInt if needed
      const normalizedDeposits = deposits.map(deposit => {
        if (typeof deposit.deposit_id === 'string') {
          return this.convertDatabaseDeposit({
            deposit_id: deposit.deposit_id,
            owner_address: deposit.owner_address,
            depositor_address: deposit.depositor_address,
            delegatee_address: deposit.delegatee_address,
            amount: deposit.amount.toString(),
            earning_power: deposit.earning_power?.toString(),
          });
        }
        return deposit;
      });

      // Get payoutAmount and estimate gas costs with retry
      const payoutAmount = await this.getContractDataWithRetry(
        () => this.govLstContract.payoutAmount(),
        'Fetching payout amount',
      );

      const gasCost = await this.getContractDataWithRetry(
        () => this.estimateGasCostInRewardToken(),
        'Estimating gas cost',
      );

      const profitMargin = this.config.minProfitMargin;

      // Calculate optimal threshold based on payout amount, gas cost and profit margin percentage
      const effectiveGasCost = CONFIG.profitability.includeGasCost
        ? gasCost
        : BigInt(0);
      const baseAmount = payoutAmount + effectiveGasCost;
      const profitMarginAmount =
        (baseAmount * BigInt(profitMargin)) / BigInt(100);
      const optimalThreshold = baseAmount + profitMarginAmount;

      // Always create a new bin - don't reuse the active bin
      this.activeBin = {
        deposit_ids: [],
        total_rewards: BigInt(0),
        total_shares: BigInt(0),
        expected_profit: BigInt(0),
        total_payout: payoutAmount,
        gas_estimate: GAS_CONSTANTS.FALLBACK_GAS_ESTIMATE,
      };

      // Fetch unclaimed rewards for all deposits in batch with retry
      const depositIds = normalizedDeposits.map((d) => d.deposit_id);
      const rewardsMap = await this.getContractDataWithRetry(
        () => this.batchFetchUnclaimedRewards(depositIds),
        'Fetching unclaimed rewards',
      );

      // Sort deposits by rewards in descending order for optimal filling
      const sortedDeposits = [...normalizedDeposits].sort((a, b) => {
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

        // Add deposit to active bin
        if (this.activeBin) {
          this.activeBin.deposit_ids.push(depositId);
          this.activeBin.total_rewards += reward;
          this.activeBin.total_shares += deposit.shares_of;
          addedDeposits.push(deposit);

          // Check if we've hit optimal threshold after adding this deposit
          if (this.activeBin.total_rewards >= optimalThreshold) {
            break;
          }
        }
      }

      // Check if bin has reached optimal threshold
      const readyBins: GovLstDepositGroup[] = [];

      if (this.activeBin?.total_rewards >= optimalThreshold) {
        // Calculate expected profit - should be equal to total rewards
        const expectedProfit = this.activeBin.total_rewards;
        this.activeBin.expected_profit = expectedProfit;

        readyBins.push(this.activeBin);
      }

      // Always clear the active bin after analysis
      this.activeBin = null;

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
        method: 'analyzeAndGroupDeposits',
      };

      this.logger.error('Failed to analyze and group deposits:', errorContext);
      
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, errorContext);
      }
      
      throw new QueueProcessingError(error as Error, errorContext);
    }
  }

  /**
   * Checks if the active bin is profitable and ready for execution
   * @returns Boolean indicating if bin is ready for processing
   */
  async isActiveBinReady(): Promise<boolean> {
    try {
      if (!this.activeBin || this.activeBin.deposit_ids.length === 0) {
        return false;
      }

      // Get current gas cost and payout amount
      const gasCost = await this.estimateGasCostInRewardToken();
      const payoutAmount = await this.govLstContract.payoutAmount();
      const profitMargin = this.config.minProfitMargin;

      // Calculate optimal threshold
      const optimalThreshold =
        payoutAmount +
        gasCost +
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
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'isActiveBinReady',
          method: 'GovLstProfitabilityEngine.isActiveBinReady',
          activeBin: this.activeBin 
            ? { depositCount: this.activeBin.deposit_ids.length } 
            : null,
        });
      }
      throw error;
    }
  }

  /**
   * Calculates profitability metrics for the active bin
   * @returns Profitability check result for the active bin
   */
  async calculateActiveBinProfitability(): Promise<GovLstProfitabilityCheck | null> {
    try {
      if (!this.activeBin || this.activeBin.deposit_ids.length === 0) {
        return null;
      }

      const gasCost = await this.estimateGasCostInRewardToken();
      const payoutAmount = await this.govLstContract.payoutAmount();

      // Expected profit should be equal to total rewards
      const expectedProfit = this.activeBin.total_rewards;

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
        }),
      );

      // Check profitability constraints
      const meetsMinReward =
        this.activeBin.total_rewards >= this.config.minProfitMargin;
      const meetsMinProfit = this.activeBin.total_rewards > gasCost; // Compare total rewards with gas cost
      const hasEnoughShares =
        this.activeBin.total_shares >= CONTRACT_CONSTANTS.MIN_SHARES_THRESHOLD;

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
          gas_cost: gasCost, // Add gas cost as separate field
          expected_profit: expectedProfit,
        },
        deposit_details: depositDetails,
      };
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'calculateActiveBinProfitability',
          method: 'GovLstProfitabilityEngine.calculateActiveBinProfitability',
          activeBin: this.activeBin 
            ? { depositCount: this.activeBin.deposit_ids.length } 
            : null,
        });
      }
      throw error;
    }
  }

  /**
   * Gets the current active bin
   * @returns The current active bin or null if none exists
   */
  getActiveBin(): GovLstDepositGroup | null {
    try {
      return this.activeBin;
    } catch (error) {
      if (this.errorLogger) {
        this.errorLogger.error(error as Error, {
          context: 'getActiveBin',
          method: 'GovLstProfitabilityEngine.getActiveBin',
        });
      }
      throw error;
    }
  }

  /**
   * Resets the active bin
   */
  resetActiveBin(): void {
    try {
      this.activeBin = null;
      this.logger.info('Active bin has been reset');
    } catch (error) {
      if (this.errorLogger) {
        this.errorLogger.error(error as Error, {
          context: 'resetActiveBin',
          method: 'GovLstProfitabilityEngine.resetActiveBin',
        });
      }
      throw error;
    }
  }

  /**
   * Fetches unclaimed rewards for multiple deposit IDs in batch
   */
  private async batchFetchUnclaimedRewards(
    depositIds: bigint[],
  ): Promise<Map<string, bigint>> {
    try {
      const rewardsMap = new Map<string, bigint>();
      const batchSize = GovLstProfitabilityEngine.BATCH_SIZE;
      const maxRetries = 3;

      this.logger.info('Starting batch fetch of unclaimed rewards:', {
        totalDeposits: depositIds.length,
        batchSize,
      });

      // Function to process a batch with retries
      const processBatchWithRetry = async (batchIds: bigint[]) => {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            const results = await Promise.all(
              batchIds.map(async (id) => {
                const reward = await this.stakerContract.unclaimedReward(id);
                return { id, reward };
              }),
            );

            // Check if all rewards are 0, might indicate we need to wait for chain update
            const allZero = results.every(({ reward }) => reward === BigInt(0));
            if (allZero && attempt < maxRetries - 1) {
              this.logger.info(
                'All rewards are 0, waiting for chain update...',
                {
                  attempt: attempt + 1,
                  batchIds: batchIds.map((id) => id.toString()),
                },
              );
              await new Promise((resolve) =>
                setTimeout(resolve, 2000 * (attempt + 1)),
              ); // Exponential backoff
              continue;
            }

            // Store results
            results.forEach(({ id, reward }) => {
              rewardsMap.set(id.toString(), reward);
              if (reward > BigInt(0)) {
                this.logger.info('Fetched non-zero reward:', {
                  depositId: id.toString(),
                  reward: ethers.formatEther(reward),
                });
              }
            });
            break; // Success, exit retry loop
          } catch (error) {
            if (this.errorLogger) {
              await this.errorLogger.warn(error as Error, {
                context: 'batchFetchUnclaimedRewards.processBatchWithRetry',
                attempt: attempt + 1,
                batchSize: batchIds.length,
                method: 'batchFetchUnclaimedRewards',
              });
            }
            
            if (attempt === maxRetries - 1) throw error;
            this.logger.warn('Error fetching rewards, retrying...', {
              attempt: attempt + 1,
              error: error instanceof Error ? error.message : String(error),
            });
            await new Promise((resolve) =>
              setTimeout(resolve, 1000 * (attempt + 1)),
            );
          }
        }
      };

      // Process batches
      for (let i = 0; i < depositIds.length; i += batchSize) {
        const batchIds = depositIds.slice(i, i + batchSize);
        await processBatchWithRetry(batchIds);

        // Small delay between batches
        if (i + batchSize < depositIds.length) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      const totalRewards = Array.from(rewardsMap.values()).reduce(
        (sum, reward) => sum + reward,
        BigInt(0),
      );
      const nonZeroRewards = Array.from(rewardsMap.values()).filter(
        (reward) => reward > BigInt(0),
      );

      this.logger.info('Completed batch fetch of unclaimed rewards:', {
        totalDeposits: depositIds.length,
        successfulFetches: rewardsMap.size,
        nonZeroRewards: nonZeroRewards.length,
        totalRewardsInEther: ethers.formatEther(totalRewards),
      });

      return rewardsMap;
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'batchFetchUnclaimedRewards',
          method: 'GovLstProfitabilityEngine.batchFetchUnclaimedRewards',
          depositCount: depositIds.length,
        });
      }
      
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
    try {
      const now = Date.now();
      if (
        this.gasPriceCache &&
        now - this.gasPriceCache.timestamp <
          GAS_CONSTANTS.GAS_PRICE_UPDATE_INTERVAL
      ) {
        return this.gasPriceCache.price;
      }

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
      const errorContext = {
        lastGasPrice: this.lastGasPrice.toString(),
        lastUpdateTimestamp: this.lastUpdateTimestamp,
        method: 'getGasPriceWithBuffer',
      };
      
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, errorContext);
      }
      
      throw new GasEstimationError(error as Error, errorContext);
    }
  }

  /**
   * Estimates the gas cost of claiming rewards in terms of reward tokens
   * Uses current gas price and configured price assumptions
   * @returns Estimated gas cost denominated in reward tokens
   */
  private async estimateGasCostInRewardToken(): Promise<bigint> {
    try {
      // Get current gas price and estimate gas cost
      const gasPrice = await this.getGasPriceWithBuffer();
      const gasLimit = BigInt(300000); // Estimated gas limit for claim
      const gasCost = gasPrice * gasLimit;

      this.logger.info('Gas cost calculation:', {
        gasPriceGwei: ethers.formatUnits(gasPrice, 'gwei'),
        gasLimit: gasLimit.toString(),
        gasCostWei: gasCost.toString(),
        gasCostEther: ethers.formatEther(gasCost),
      });

      // Use hardcoded prices for testing
      // ETH price: $1800, Token price: $1
      const ethPriceScaled = BigInt(1800) * BigInt(1e18);
      const rewardTokenPriceScaled = BigInt(1) * BigInt(1e18);

      // Calculate gas cost in reward tokens
      const gasCostInRewardTokens =
        (gasCost * ethPriceScaled) / rewardTokenPriceScaled;

      this.logger.info('Gas cost in reward tokens:', {
        ethPriceUSD: ethers.formatEther(ethPriceScaled),
        tokenPriceUSD: ethers.formatEther(rewardTokenPriceScaled),
        gasCostInTokens: ethers.formatEther(gasCostInRewardTokens),
      });

      return gasCostInRewardTokens;
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'estimateGasCostInRewardToken',
          method: 'GovLstProfitabilityEngine.estimateGasCostInRewardToken',
        });
      }
      throw error;
    }
  }

  /**
   * Calculates total gas estimate across all deposit groups
   * @param groups Array of deposit groups to sum gas estimates for
   * @returns Total gas estimate
   */
  private calculateTotalGasEstimate(groups: GovLstDepositGroup[]): bigint {
    try {
      return groups.reduce((sum, group) => sum + group.gas_estimate, BigInt(0));
    } catch (error) {
      if (this.errorLogger) {
        this.errorLogger.error(error as Error, {
          context: 'calculateTotalGasEstimate',
          method: 'GovLstProfitabilityEngine.calculateTotalGasEstimate',
          groupCount: groups.length,
        });
      }
      throw error;
    }
  }

  /**
   * Calculates total expected profit across all deposit groups
   * @param groups Array of deposit groups to sum profits for
   * @returns Total expected profit
   */
  private calculateTotalExpectedProfit(groups: GovLstDepositGroup[]): bigint {
    try {
      return groups.reduce(
        (sum, group) => sum + group.expected_profit,
        BigInt(0),
      );
    } catch (error) {
      if (this.errorLogger) {
        this.errorLogger.error(error as Error, {
          context: 'calculateTotalExpectedProfit',
          method: 'GovLstProfitabilityEngine.calculateTotalExpectedProfit',
          groupCount: groups.length,
        });
      }
      throw error;
    }
  }

  /**
   * Creates a default empty batch analysis result
   * Used when deposits array is empty
   * @returns Default empty batch analysis
   */
  private createEmptyBatchAnalysis(): GovLstBatchAnalysis {
    try {
      return {
        deposit_groups: [],
        total_gas_estimate: BigInt(0),
        total_expected_profit: BigInt(0),
        total_deposits: 0,
      };
    } catch (error) {
      if (this.errorLogger) {
        this.errorLogger.error(error as Error, {
          context: 'createEmptyBatchAnalysis',
          method: 'GovLstProfitabilityEngine.createEmptyBatchAnalysis',
        });
      }
      throw error;
    }
  }
}
