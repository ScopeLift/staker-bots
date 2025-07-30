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
import { CoinMarketCapFeed } from '@/prices/CoinmarketcapFeed';
import { TokenPrice } from '@/prices/interface';
import { SimulationService } from '@/simulation';
import { estimateGasUsingSimulation } from '@/executor/strategies/helpers/simulation-helpers';

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
  private readonly priceFeed: CoinMarketCapFeed;
  private isRunning: boolean;
  private lastGasPrice: bigint;
  private lastUpdateTimestamp: number;
  private gasPriceCache: { price: bigint; timestamp: number } | null = null;
  private priceCache: {
    rewardToken: TokenPrice;
    gasToken: TokenPrice;
    timestamp: number;
  } | null = null;
  private readonly PRICE_CACHE_DURATION = 10 * 60 * 1000; // 10 minutes in milliseconds
  public readonly config: ProfitabilityConfig;
  private static readonly BATCH_SIZE = 100; // Number of deposits to fetch in a single batch
  private activeBin: GovLstDepositGroup | null = null; // Current active bin being filled
  private readonly simulationService: SimulationService | null;

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
    simulationService: SimulationService | null,
  ) {
    this.logger = new ConsoleLogger('info');
    this.errorLogger = config.errorLogger;
    this.isRunning = false;
    this.lastGasPrice = BigInt(0);
    this.lastUpdateTimestamp = 0;
    this.config = config;
    this.simulationService = simulationService;

    // Initialize price feed
    this.priceFeed = new CoinMarketCapFeed(
      {
        ...CONFIG.priceFeed.coinmarketcap,
        rewardToken: CONFIG.priceFeed.coinmarketcap.rewardTokenAddress,
        gasToken: 'ETH',
      },
      this.logger,
    );
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

      // Early check: Skip simulation if total rewards < payout amount
      if (totalRewards < payoutAmount) {
        this.logger.warn('Skipping gas simulation - rewards insufficient for payout', {
          totalRewards: totalRewards.toString(),
          payoutAmount: payoutAmount.toString(),
          depositCount: depositIds.length,
        });
        
        // Use fallback gas estimate without simulation
        const enhancedGasCost = gasCostInRewardToken;
        const actualGasEstimate = GAS_CONSTANTS.FALLBACK_GAS_ESTIMATE;
        
        // Return early with non-profitable result
        return {
          is_profitable: false,
          constraints: {
            meets_min_reward: false,
            meets_min_profit: false,
            has_enough_shares: false,
          },
          estimates: {
            total_shares: BigInt(0),
            payout_amount: payoutAmount,
            gas_estimate: actualGasEstimate,
            gas_cost: enhancedGasCost,
            expected_profit: BigInt(0),
            minExpectedReward: payoutAmount + enhancedGasCost,
          },
          deposit_details: depositDetails,
        };
      }

      // Try to get a better gas estimate using simulation
      const enhancedGasCost = await this.estimateGasWithSimulation(
        depositIds,
        gasCostInRewardToken,
      );

      // Get the actual gas units estimate from simulation
      let actualGasEstimate = GAS_CONSTANTS.FALLBACK_GAS_ESTIMATE;
      if (this.simulationService) {
        try {
          const mockRecipientAddress = CONFIG.profitability.defaultTipReceiver;
          const simulatedGasUnits = await estimateGasUsingSimulation(
            depositIds,
            mockRecipientAddress,
            payoutAmount,
            this.govLstContract,
            this.simulationService,
            this.logger,
          );
          
          if (simulatedGasUnits !== null) {
            actualGasEstimate = simulatedGasUnits;
            this.logger.info('Using simulated gas estimate for profitability calculation', {
              simulatedGasUnits: simulatedGasUnits.toString(),
              fallbackEstimate: GAS_CONSTANTS.FALLBACK_GAS_ESTIMATE.toString(),
              depositCount: depositIds.length,
            });
          }
        } catch (error) {
          this.logger.warn('Failed to get gas units from simulation for profitability', {
            error: error instanceof Error ? error.message : String(error),
            depositIds: depositIds.map(String),
          });
        }
      }

      // Calculate total shares for qualified deposits
      const totalShares = qualifiedDeposits.reduce(
        (sum, deposit) => sum + (deposit.earning_power || BigInt(0)),
        BigInt(0),
      );

      // Check constraints
      const meetsMinReward = totalRewards >= this.config.minProfitMargin;
      const meetsMinProfit = totalRewards > enhancedGasCost;
      const hasEnoughShares =
        totalShares >= CONTRACT_CONSTANTS.MIN_SHARES_THRESHOLD;

      // Calculate expected profit (total rewards minus gas cost)
      const expectedProfit =
        totalRewards > enhancedGasCost
          ? totalRewards - enhancedGasCost
          : BigInt(0);

      // Calculate minimum expected reward threshold
      const minExpectedReward = this.calculateMinExpectedReward(
        payoutAmount,
        enhancedGasCost,
        BigInt(deposits.length),
      );

      this.logProfitabilityThreshold(
        'minimum expected reward threshold',
        payoutAmount,
        actualGasEstimate,
        deposits.length,
        minExpectedReward,
      );

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
          gas_estimate: actualGasEstimate,
          gas_cost: enhancedGasCost,
          expected_profit: expectedProfit,
          minExpectedReward: minExpectedReward,
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
    return this.withRetry(operation, context, maxRetries, delayMs);
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
        earning_power: deposit.earning_power
          ? BigInt(deposit.earning_power)
          : BigInt(0),
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

  async analyzeAndGroupDeposits(
    deposits: GovLstDeposit[],
  ): Promise<GovLstBatchAnalysis> {
    try {
      if (!deposits.length) return this.createEmptyBatchAnalysis();

      this.logger.info('Starting single-bin accumulation analysis:', {
        depositCount: deposits.length,
      });

      // Convert any string values to BigInt if needed
      const normalizedDeposits = deposits.map((deposit) => {
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

      // Calculate realistic gas cost based on actual usage patterns (600k gas)
      const REALISTIC_GAS_UNITS = BigInt(600000); // 600k gas based on production data
      const gasPrice = await this.getGasPriceWithBuffer();
      const gasCostWei = gasPrice * REALISTIC_GAS_UNITS;
      const realisticGasCost = await this.convertGasCostToRewardTokens(gasCostWei);

      this.logger.info('Using realistic gas estimate for Stage 1 threshold', {
        gasUnits: REALISTIC_GAS_UNITS.toString(),
        gasPrice: ethers.formatUnits(gasPrice, 'gwei'),
        gasCostWei: gasCostWei.toString(),
        gasCostInTokens: realisticGasCost.toString(),
        gasCostInTokensFormatted: ethers.formatEther(realisticGasCost),
      });

      // We'll calculate enhanced gas cost and actualGasEstimate later, after we know total rewards
      let enhancedGasCost = realisticGasCost;
      let actualGasEstimate = REALISTIC_GAS_UNITS;

      const profitMargin = this.config.minProfitMargin;

      // Get all deposit IDs
      const depositIds = normalizedDeposits.map((d) => d.deposit_id);

      // Calculate optimal threshold based on payout amount and realistic gas cost
      const effectiveGasCost = CONFIG.profitability.includeGasCost
        ? realisticGasCost
        : BigInt(0);
      
      const baseAmount = payoutAmount + effectiveGasCost;

      // Scale profit margin based on deposit count
      const depositCount = BigInt(depositIds.length);
      // Convert to basis points (0.02% = 2 basis points per deposit, max 10 basis points)
      const depositScalingBasisPoints = BigInt(
        Math.min(10, Number(depositCount) * 2),
      );
      // Start with the minimum profit margin in basis points (convert percentage to basis points)
      const minProfitMarginBasisPoints = BigInt(Math.floor(profitMargin * 100));
      // Add the scaling factor (cap at 500 basis points = 5%)
      const scaledProfitMarginBasisPoints = BigInt(
        Math.min(
          500,
          Number(minProfitMarginBasisPoints + depositScalingBasisPoints),
        ),
      );

      // Apply profit margin to base amount
      const profitMarginAmount =
        (baseAmount * scaledProfitMarginBasisPoints) / 10000n;
      const optimalThreshold = baseAmount + profitMarginAmount;

      this.logProfitabilityThreshold(
        'optimal threshold for deposit group analysis',
        payoutAmount,
        actualGasEstimate,
        depositIds.length,
        optimalThreshold,
      );

      // Always create a new bin - don't reuse the active bin
      this.activeBin = {
        deposit_ids: [],
        total_rewards: BigInt(0),
        total_shares: BigInt(0),
        expected_profit: BigInt(0),
        total_payout: payoutAmount,
        gas_estimate: actualGasEstimate, // Use actual simulation gas estimate
      };

      // Fetch unclaimed rewards for all deposits in batch with retry
      const rewardsMap = await this.getContractDataWithRetry(
        () => this.batchFetchUnclaimedRewards(depositIds),
        'Fetching unclaimed rewards',
      );

      // Calculate total available rewards across all deposits
      let totalAvailableRewards = BigInt(0);
      for (const [, reward] of rewardsMap) {
        totalAvailableRewards += reward;
      }
      
      this.logger.info('Total available rewards across all deposits', {
        totalAvailableRewards: totalAvailableRewards.toString(),
        totalAvailableRewardsFormatted: ethers.formatEther(totalAvailableRewards),
        depositCount: depositIds.length,
      });

      // Sort deposits by rewards in descending order for optimal filling
      // Add secondary sort by deposit_id for deterministic ordering when rewards are equal
      const sortedDeposits = [...normalizedDeposits].sort((a, b) => {
        const rewardA = rewardsMap.get(a.deposit_id.toString()) || BigInt(0);
        const rewardB = rewardsMap.get(b.deposit_id.toString()) || BigInt(0);
        const rewardDiff = Number(rewardB - rewardA);
        // If rewards are equal, sort by deposit_id for deterministic ordering
        return rewardDiff !== 0 ? rewardDiff : Number(a.deposit_id - b.deposit_id);
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
            this.logger.info('Optimal threshold reached, stopping deposit addition', {
              depositsAdded: this.activeBin.deposit_ids.length,
              totalRewardsInBin: this.activeBin.total_rewards.toString(),
              optimalThreshold: optimalThreshold.toString(),
              remainingDeposits: sortedDeposits.length - addedDeposits.length,
            });
            break;
          }
        }
      }

      // Two-stage Tenderly simulation approach
      const readyBins: GovLstDepositGroup[] = [];

      // Stage 1: Initial check - trigger first simulation when rewards > payout + margin
      if (this.activeBin?.total_rewards >= optimalThreshold) {
        this.logger.info('Stage 1: Initial threshold reached, running first simulation', {
          totalRewards: this.activeBin.total_rewards.toString(),
          optimalThreshold: optimalThreshold.toString(),
          depositCount: this.activeBin.deposit_ids.length,
        });

        // First simulation to get accurate gas cost
        let firstSimulationGasCost = realisticGasCost;
        let firstSimulationGasUnits = REALISTIC_GAS_UNITS;
        
        if (this.simulationService && this.activeBin.total_rewards >= payoutAmount) {
          try {
            const mockRecipientAddress = CONFIG.profitability.defaultTipReceiver;
            const simulatedGasUnits = await estimateGasUsingSimulation(
              this.activeBin.deposit_ids,
              mockRecipientAddress,
              payoutAmount,
              this.govLstContract,
              this.simulationService,
              this.logger,
            );
            
            if (simulatedGasUnits !== null) {
              firstSimulationGasUnits = simulatedGasUnits;
              firstSimulationGasCost = await this.convertGasUnitsToRewardToken(simulatedGasUnits);
              
              this.logger.info('Stage 1 simulation completed', {
                simulatedGasUnits: simulatedGasUnits.toString(),
                simulatedGasCost: firstSimulationGasCost.toString(),
                depositCount: this.activeBin.deposit_ids.length,
              });
            }
          } catch (error) {
            this.logger.warn('Stage 1 simulation failed, using fallback estimates', {
              error: error instanceof Error ? error.message : String(error),
              depositIds: this.activeBin.deposit_ids.map(String),
            });
          }
        }

        // Stage 2: Check if rewards > payout + margin + gas cost from stage 1
        const scaledProfitMarginBasisPoints = this.calculateScaledProfitMargin(
          BigInt(this.activeBin.deposit_ids.length), 
          this.config.minProfitMargin
        );
        const marginOnPayout = (payoutAmount * scaledProfitMarginBasisPoints) / 10000n;
        const stage2Threshold = payoutAmount + 
          (CONFIG.profitability.includeGasCost ? firstSimulationGasCost : BigInt(0)) + 
          marginOnPayout;
        
        this.logger.info('Stage 2: Checking against refined threshold', {
          totalRewards: this.activeBin.total_rewards.toString(),
          stage2Threshold: stage2Threshold.toString(),
          firstSimulationGasCost: firstSimulationGasCost.toString(),
          payoutAmount: payoutAmount.toString(),
          scaledProfitMarginBasisPoints: scaledProfitMarginBasisPoints.toString(),
          marginOnPayout: marginOnPayout.toString(),
          depositCount: this.activeBin.deposit_ids.length,
        });

        if (this.activeBin.total_rewards >= stage2Threshold) {
          // Run second simulation for final validation
          let finalGasCost = firstSimulationGasCost;
          let finalGasUnits = firstSimulationGasUnits;
          
          if (this.simulationService) {
            try {
              const mockRecipientAddress = CONFIG.profitability.defaultTipReceiver;
              const secondSimulatedGasUnits = await estimateGasUsingSimulation(
                this.activeBin.deposit_ids,
                mockRecipientAddress,
                payoutAmount,
                this.govLstContract,
                this.simulationService,
                this.logger,
              );
              
              if (secondSimulatedGasUnits !== null) {
                finalGasUnits = secondSimulatedGasUnits;
                finalGasCost = await this.convertGasUnitsToRewardToken(secondSimulatedGasUnits);
                
                this.logger.info('Stage 2 simulation completed', {
                  secondSimulatedGasUnits: secondSimulatedGasUnits.toString(),
                  finalGasCost: finalGasCost.toString(),
                  depositCount: this.activeBin.deposit_ids.length,
                });
              }
            } catch (error) {
              this.logger.warn('Stage 2 simulation failed, using stage 1 estimates', {
                error: error instanceof Error ? error.message : String(error),
                depositIds: this.activeBin.deposit_ids.map(String),
              });
            }
          }
          
          // Update gas estimates with final simulation results
          enhancedGasCost = finalGasCost;
          actualGasEstimate = finalGasUnits;
          this.activeBin.gas_estimate = actualGasEstimate;
          
          // Calculate expected profit - total rewards minus gas cost
          const expectedProfit = this.activeBin.total_rewards > finalGasCost ? 
            this.activeBin.total_rewards - finalGasCost : BigInt(0);
          this.activeBin.expected_profit = expectedProfit;

          this.logger.info('Final profitability calculation', {
            totalRewards: this.activeBin.total_rewards.toString(),
            finalGasCost: finalGasCost.toString(),
            expectedProfit: expectedProfit.toString(),
            depositCount: this.activeBin.deposit_ids.length,
          });

          readyBins.push(this.activeBin);
        } else {
          this.logger.info('Stage 2: Insufficient rewards after accurate gas estimation', {
            totalRewards: this.activeBin.total_rewards.toString(),
            stage2Threshold: stage2Threshold.toString(),
            shortfall: (stage2Threshold - this.activeBin.total_rewards).toString(),
            breakdown: {
              payoutAmount: payoutAmount.toString(),
              gasCost: firstSimulationGasCost.toString(),
              marginBasisPoints: scaledProfitMarginBasisPoints.toString(),
              marginAmount: marginOnPayout.toString(),
              calculation: `${payoutAmount} + ${firstSimulationGasCost} + ${marginOnPayout} = ${stage2Threshold}`,
            },
          });
        }
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

      // Early check: Skip simulation if total rewards < payout amount
      if (this.activeBin.total_rewards < payoutAmount) {
        this.logger.warn('Skipping gas simulation for active bin - rewards insufficient for payout', {
          totalRewards: this.activeBin.total_rewards.toString(),
          payoutAmount: payoutAmount.toString(),
          depositCount: this.activeBin.deposit_ids.length,
        });
        
        // Return early with non-profitable result
        return {
          is_profitable: false,
          constraints: {
            meets_min_reward: false,
            meets_min_profit: false,
            has_enough_shares: false,
          },
          estimates: {
            total_shares: this.activeBin.total_shares,
            payout_amount: payoutAmount,
            gas_estimate: GAS_CONSTANTS.FALLBACK_GAS_ESTIMATE,
            gas_cost: gasCost,
            expected_profit: BigInt(0),
            minExpectedReward: payoutAmount + gasCost,
          },
          deposit_details: [],
        };
      }

      // Try to get a better gas estimate using simulation
      const enhancedGasCost = await this.estimateGasWithSimulation(
        this.activeBin.deposit_ids,
        gasCost,
      );

      // Get the actual gas units estimate from simulation
      let actualGasEstimate = GAS_CONSTANTS.FALLBACK_GAS_ESTIMATE;
      if (this.simulationService) {
        try {
          const mockRecipientAddress = CONFIG.profitability.defaultTipReceiver;
          const simulatedGasUnits = await estimateGasUsingSimulation(
            this.activeBin.deposit_ids,
            mockRecipientAddress,
            payoutAmount,
            this.govLstContract,
            this.simulationService,
            this.logger,
          );
          
          if (simulatedGasUnits !== null) {
            actualGasEstimate = simulatedGasUnits;
            this.logger.info('Using simulated gas estimate for active bin profitability', {
              simulatedGasUnits: simulatedGasUnits.toString(),
              fallbackEstimate: GAS_CONSTANTS.FALLBACK_GAS_ESTIMATE.toString(),
              depositCount: this.activeBin.deposit_ids.length,
            });
          }
        } catch (error) {
          this.logger.warn('Failed to get gas units from simulation for active bin', {
            error: error instanceof Error ? error.message : String(error),
            depositIds: this.activeBin.deposit_ids.map(String),
          });
        }
      }

      // Expected profit should be total rewards minus gas cost
      const expectedProfit = this.activeBin.total_rewards > enhancedGasCost ? 
        this.activeBin.total_rewards - enhancedGasCost : BigInt(0);

      this.activeBin.expected_profit = expectedProfit;
      this.activeBin.gas_estimate = actualGasEstimate; // Use actual simulation gas estimate
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

      // Calculate minimum expected reward threshold
      const minExpectedReward = this.calculateMinExpectedReward(
        payoutAmount,
        enhancedGasCost,
        BigInt(this.activeBin.deposit_ids.length),
      );

      this.logProfitabilityThreshold(
        'minimum expected reward threshold for active bin',
        payoutAmount,
        actualGasEstimate,
        this.activeBin.deposit_ids.length,
        minExpectedReward,
      );

      // Check profitability constraints
      const meetsMinReward =
        this.activeBin.total_rewards >= this.config.minProfitMargin;
      const meetsMinProfit = this.activeBin.total_rewards > enhancedGasCost; // Compare total rewards with gas cost
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
          gas_estimate: actualGasEstimate,
          gas_cost: enhancedGasCost,
          expected_profit: expectedProfit,
          minExpectedReward: minExpectedReward,
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

      this.logger.info('Starting batch fetch of unclaimed rewards:', {
        totalDeposits: depositIds.length,
        batchSize,
      });

      // Function to process a batch with retries
      const processBatch = async (batchIds: bigint[]) => {
        // Process batch with retries
        const results = await this.withRetry(
          async () => {
            const results = await Promise.all(
              batchIds.map(async (id) => {
                const reward = await this.stakerContract.unclaimedReward(id);
                return { id, reward };
              }),
            );

            // Check if all rewards are 0, might indicate we need to wait for chain update
            const allZero = results.every(({ reward }) => reward === BigInt(0));
            if (allZero) {
              this.logger.info(
                'All rewards are 0, waiting for chain update...',
              );
              // Throw to trigger retry
              throw new Error(
                'All rewards are zero - waiting for chain update',
              );
            }

            return results;
          },
          `Batch fetch rewards for ${batchIds.length} deposits`,
          3,
          2000,
        );

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
      };

      // Process batches
      for (let i = 0; i < depositIds.length; i += batchSize) {
        const batchIds = depositIds.slice(i, i + batchSize);
        await processBatch(batchIds);

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
      let gasPrice = feeData.gasPrice ?? BigInt(0);
      
      // Handle very low gas prices (sub 1 gwei) that can cause simulation issues
      const MIN_GAS_PRICE_GWEI = 1n; // 1 gwei minimum
      const MIN_GAS_PRICE_WEI = MIN_GAS_PRICE_GWEI * 10n ** 9n;
      
      if (gasPrice < MIN_GAS_PRICE_WEI) {
        this.logger.warn('Gas price is very low, using minimum threshold', {
          actualGasPriceGwei: Number(gasPrice) / 1e9,
          minGasPriceGwei: Number(MIN_GAS_PRICE_GWEI),
          usingMinimum: true,
        });
        gasPrice = MIN_GAS_PRICE_WEI;
      }

      // Handle zero gas price (should not happen but safety check)
      if (gasPrice === 0n) {
        const fallbackGasPrice = 3n * 10n ** 9n; // 3 gwei fallback
        this.logger.warn('Gas price is zero, using fallback', {
          fallbackGasPriceGwei: 3,
        });
        gasPrice = fallbackGasPrice;
      }

      const buffer = BigInt(Math.floor(this.config.gasPriceBuffer));
      const bufferedGasPrice = gasPrice + (gasPrice * buffer) / BigInt(100);

      // Log gas price details for debugging
      this.logger.debug('Gas price calculation', {
        rawGasPriceGwei: Number(feeData.gasPrice ?? 0n) / 1e9,
        adjustedGasPriceGwei: Number(gasPrice) / 1e9,
        bufferPercent: Number(buffer),
        finalGasPriceGwei: Number(bufferedGasPrice) / 1e9,
        isVeryLow: Number(feeData.gasPrice ?? 0n) < Number(MIN_GAS_PRICE_WEI),
      });

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

      this.logger.warn('Failed to get gas price from provider, using fallback', {
        error: error instanceof Error ? error.message : String(error),
        lastGasPrice: this.lastGasPrice.toString(),
      });

      // Use cached value if available, otherwise use fallback
      if (this.lastGasPrice > 0n) {
        this.logger.info('Using cached gas price due to provider error', {
          cachedGasPriceGwei: Number(this.lastGasPrice) / 1e9,
        });
        return this.lastGasPrice;
      }

      // Final fallback - use 3 gwei
      const fallbackGasPrice = 3n * 10n ** 9n; // 3 gwei
      this.logger.warn('Using hardcoded fallback gas price', {
        fallbackGasPriceGwei: 3,
      });

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, errorContext);
      }

      return fallbackGasPrice;
    }
  }

  /**
   * Calculates the scaled profit margin based on deposit count and base margin
   * @param depositCount Number of deposits
   * @param baseMargin Base profit margin percentage
   * @returns Scaled profit margin in basis points
   */
  private calculateScaledProfitMargin(
    depositCount: bigint,
    baseMargin: number,
  ): bigint {
    // Convert to basis points (0.02% = 2 basis points per deposit, max 10 basis points)
    const depositScalingBasisPoints = BigInt(
      Math.min(10, Number(depositCount) * 2),
    );
    // Start with the minimum profit margin in basis points
    const minProfitMarginBasisPoints = BigInt(Math.floor(baseMargin * 100));
    // Add the scaling factor (cap at 500 basis points = 5%)
    return BigInt(
      Math.min(
        500,
        Number(minProfitMarginBasisPoints + depositScalingBasisPoints),
      ),
    );
  }

  /**
   * Calculates the minimum expected reward threshold
   * @param payoutAmount Base payout amount
   * @param gasCost Estimated gas cost
   * @param depositCount Number of deposits
   * @returns Minimum expected reward threshold
   */
  private calculateMinExpectedReward(
    payoutAmount: bigint,
    gasCost: bigint,
    depositCount: bigint,
  ): bigint {
    const scaledProfitMarginBasisPoints = this.calculateScaledProfitMargin(
      depositCount,
      this.config.minProfitMargin,
    );

    const effectiveGasCost = CONFIG.profitability.includeGasCost
      ? gasCost
      : BigInt(0);
    const baseAmount = payoutAmount + effectiveGasCost;

    // Apply profit margin to base amount
    const profitMarginAmount =
      (baseAmount * scaledProfitMarginBasisPoints) / 10000n;

    return baseAmount + profitMarginAmount;
  }

  /**
   * Converts gas cost to reward tokens using current prices
   * @param gasCost Gas cost in wei
   * @returns Gas cost in reward tokens
   */
  private async convertGasCostToRewardTokens(gasCost: bigint): Promise<bigint> {
    const prices = await this.getPrices();

    // Use proper decimal handling like GasCostEstimator.ts
    const ETH_DECIMALS = 18;
    const TOKEN_DECIMALS = CONFIG.govlst.rewardTokenDecimals || 18;

    // Convert prices to wei/token base units with proper decimals
    const ethPriceScaled = BigInt(
      Math.floor(prices.gasToken.usd * 10 ** ETH_DECIMALS),
    );
    const tokenPriceScaled = BigInt(
      Math.floor(prices.rewardToken.usd * 10 ** TOKEN_DECIMALS),
    );

    // Calculate cost in tokens with decimal adjustment
    // Formula: (gasCostWei * ethPriceUSD) / tokenPriceUSD
    // Note: We need to adjust for the difference in decimals between ETH and the reward token
    const decimalAdjustment = 10n ** BigInt(Math.abs(ETH_DECIMALS - TOKEN_DECIMALS));
    let costInRewardTokens: bigint;

    this.logger.info('Gas cost conversion details', {
      gasCost: gasCost.toString(),
      gasCostEth: ethers.formatEther(gasCost),
      ethPrice: ethPriceScaled.toString(),
      tokenPrice: tokenPriceScaled.toString(),
      ethDecimals: ETH_DECIMALS,
      tokenDecimals: TOKEN_DECIMALS,
      decimalAdjustment: decimalAdjustment.toString(),
      ethPriceUsd: Number(ethPriceScaled) / 10 ** ETH_DECIMALS,
      tokenPriceUsd: Number(tokenPriceScaled) / 10 ** TOKEN_DECIMALS,
      priceRatio: (Number(ethPriceScaled) / 10 ** ETH_DECIMALS) / (Number(tokenPriceScaled) / 10 ** TOKEN_DECIMALS),
    });

    if (ETH_DECIMALS >= TOKEN_DECIMALS) {
      costInRewardTokens = (gasCost * ethPriceScaled) / (tokenPriceScaled * decimalAdjustment);
    } else {
      costInRewardTokens = (gasCost * ethPriceScaled * decimalAdjustment) / tokenPriceScaled;
    }

    // Add check for zero result and apply minimum cost if needed
    if (costInRewardTokens === 0n) {
      const minimumCostUSD = 30; // $30 minimum like in GasCostEstimator
      const minimumCost = (BigInt(minimumCostUSD) * 10n ** BigInt(TOKEN_DECIMALS)) / tokenPriceScaled;
      
      this.logger.warn('Gas cost in reward token calculated as zero, using minimum cost', {
        gasCost: gasCost.toString(),
        ethPrice: ethPriceScaled.toString(),
        tokenPrice: tokenPriceScaled.toString(),
        minimumCost: minimumCost.toString(),
      });
      
      return minimumCost;
    }

    this.logger.info('Final gas cost conversion result', {
      costInRewardTokens: costInRewardTokens.toString(),
      formattedCost: ethers.formatUnits(costInRewardTokens, TOKEN_DECIMALS),
      gasCostEth: ethers.formatEther(gasCost),
      conversionRate: `1 ETH = ${(Number(costInRewardTokens) / Number(gasCost) * 1e18).toFixed(2)} reward tokens`,
    });

    return costInRewardTokens;
  }

  /**
   * Estimates the gas cost of claiming rewards in terms of reward tokens
   * Uses current gas price and configured price assumptions
   * @returns Estimated gas cost denominated in reward tokens
   */
  async estimateGasCostInRewardToken(): Promise<bigint> {
    try {
      const gasPrice = await this.getGasPriceWithBuffer();
      const gasLimit = BigInt(300000);
      const gasCost = gasPrice * gasLimit;

      const gasCostInRewardTokens =
        await this.convertGasCostToRewardTokens(gasCost);

      this.logGasCost(
        'reward token conversion',
        gasPrice,
        gasLimit,
        gasCost,
        gasCostInRewardTokens,
      );

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

  private async getPrices(): Promise<{
    rewardToken: TokenPrice;
    gasToken: TokenPrice;
  }> {
    // Check if we have valid cached prices
    if (
      this.priceCache &&
      Date.now() - this.priceCache.timestamp < this.PRICE_CACHE_DURATION
    ) {
      return {
        rewardToken: this.priceCache.rewardToken,
        gasToken: this.priceCache.gasToken,
      };
    }

    // Fetch fresh prices
    const prices = await this.priceFeed.getTokenPrices();

    // Update cache
    this.priceCache = {
      ...prices,
      timestamp: Date.now(),
    };

    return prices;
  }

  /**
   * Estimates gas costs for a transaction using simulation if available
   * Falls back to standard gas estimation if simulation fails
   *
   * @param depositIds Array of deposit IDs
   * @param gasCostInRewardToken Initial gas cost estimate in reward token
   * @returns Updated gas cost estimate
   */
  private async estimateGasWithSimulation(
    depositIds: bigint[],
    gasCostInRewardToken: bigint,
  ): Promise<bigint> {
    // Early return if simulation service is not available
    if (!this.simulationService) {
      this.logger.info(
        'Simulation service not available, using default gas estimate',
      );
      return gasCostInRewardToken;
    }

    try {
      // Get relevant data for simulation
      const payoutAmount = await this.govLstContract.payoutAmount();

      // Use a mock address for simulation - can be any valid address since we're only estimating gas
      const mockRecipientAddress = CONFIG.profitability.defaultTipReceiver;

      // Get simulation-based gas estimate
      const simulatedGas = await estimateGasUsingSimulation(
        depositIds,
        mockRecipientAddress,
        payoutAmount,
        this.govLstContract,
        this.simulationService,
        this.logger,
      );

      if (simulatedGas !== null) {
        this.logger.info('Updated gas estimate from simulation', {
          originalGasEstimate: GAS_CONSTANTS.FALLBACK_GAS_ESTIMATE.toString(),
          simulatedGasEstimate: simulatedGas.toString(),
          depositCount: depositIds.length,
        });

        // Convert gas units to reward tokens
        const simulatedGasCostInRewardToken =
          await this.convertGasUnitsToRewardToken(simulatedGas);

        this.logger.info('Converted simulated gas to reward tokens', {
          gasUnits: simulatedGas.toString(),
          gasCostInRewardToken: simulatedGasCostInRewardToken.toString(),
        });

        // Return the higher of the two estimates for safety
        return simulatedGasCostInRewardToken > gasCostInRewardToken
          ? simulatedGasCostInRewardToken
          : gasCostInRewardToken;
      }
    } catch (error) {
      this.logger.warn('Simulation-based gas estimation failed', {
        error: error instanceof Error ? error.message : String(error),
        depositIds: depositIds.map(String),
      });

      if (this.errorLogger) {
        await this.errorLogger.warn(error as Error, {
          context: 'estimateGasWithSimulation',
          depositCount: depositIds.length,
        });
      }
    }

    // Return original estimate if simulation fails
    return gasCostInRewardToken;
  }

  /**
   * Converts gas units to reward token value
   *
   * @param gasUnits Gas units to convert
   * @returns Equivalent value in reward tokens
   */
  private async convertGasUnitsToRewardToken(
    gasUnits: bigint,
  ): Promise<bigint> {
    try {
      const gasPrice = await this.getGasPriceWithBuffer();
      const gasCost = gasPrice * gasUnits;

      const gasCostInRewardTokens =
        await this.convertGasCostToRewardTokens(gasCost);

      this.logGasCost(
        'gas units conversion',
        gasPrice,
        gasUnits,
        gasCost,
        gasCostInRewardTokens,
      );

      return gasCostInRewardTokens;
    } catch (error) {
      this.logger.error('Failed to convert gas units to reward token', {
        error: error instanceof Error ? error.message : String(error),
        gasUnits: gasUnits.toString(),
      });

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'convertGasUnitsToRewardToken',
          gasUnits: gasUnits.toString(),
        });
      }

      return gasUnits * BigInt(5000);
    }
  }

  /**
   * Standardized logging for gas cost calculations
   * @param operation Description of the operation
   * @param gasPrice Gas price in wei
   * @param gasUnits Gas units
   * @param gasCost Total gas cost in wei
   * @param gasCostInRewardTokens Gas cost converted to reward tokens
   */
  private logGasCost(
    operation: string,
    gasPrice: bigint,
    gasUnits: bigint,
    gasCost: bigint,
    gasCostInRewardTokens: bigint,
  ): void {
    this.logger.info(`Gas cost calculation for ${operation}:`, {
      gasPriceGwei: ethers.formatUnits(gasPrice, 'gwei'),
      gasUnits: gasUnits.toString(),
      gasCostWei: gasCost.toString(),
      gasCostEther: ethers.formatEther(gasCost),
      gasCostInRewardTokens: ethers.formatEther(gasCostInRewardTokens),
    });
  }

  /**
   * Standardized logging for profitability thresholds
   * @param context Context description
   * @param payoutAmount Payout amount
   * @param gasEstimate Gas estimate
   * @param depositCount Deposit count
   * @param minExpectedReward Minimum expected reward
   */
  private logProfitabilityThreshold(
    context: string,
    payoutAmount: bigint,
    gasEstimate: bigint,
    depositCount: number | bigint,
    minExpectedReward: bigint,
  ): void {
    const profitMarginPercentage = `${
      Number(
        this.calculateScaledProfitMargin(
          typeof depositCount === 'number'
            ? BigInt(depositCount)
            : depositCount,
          this.config.minProfitMargin,
        ),
      ) / 100
    }%`;

    this.logger.info(`Calculated ${context}:`, {
      payoutAmount: payoutAmount.toString(),
      gasEstimate: gasEstimate.toString(),
      profitMargin: profitMarginPercentage,
      minExpectedReward: minExpectedReward.toString(),
      depositCount:
        typeof depositCount === 'number' ? depositCount : Number(depositCount),
    });
  }

  /**
   * Generic retry wrapper for any async operation
   * @param operation Function to retry
   * @param context Context description
   * @param maxRetries Maximum number of retry attempts
   * @param delayMs Base delay between retries in milliseconds
   * @returns Result of the operation
   */
  private async withRetry<T>(
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
            method: 'withRetry',
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
        method: 'withRetry',
      });
    }

    throw new Error(errorMessage);
  }
}
