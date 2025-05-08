import { ethers } from "ethers";
import { ConsoleLogger, Logger } from "@/monitor/logging";
import { IProfitabilityEngine } from "../interfaces/IProfitabilityEngine";
import { IPriceFeed } from "@/shared/price-feeds/interfaces";
import {
  BatchAnalysis,
  BumpRequirements,
  Deposit,
  ProfitabilityCheck,
  ProfitabilityConfig,
  TipOptimization,
} from "../interfaces/types";
import { BinaryEligibilityOracleEarningPowerCalculator } from "@/calculator";

export class BaseProfitabilityEngine implements IProfitabilityEngine {
  protected readonly logger: Logger;
  protected isRunning: boolean;
  protected lastGasPrice: bigint;
  protected lastUpdateTimestamp: number;
  protected rewardTokenAddress: string;

  constructor(
    protected readonly calculator: BinaryEligibilityOracleEarningPowerCalculator,
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
    },
    protected readonly provider: ethers.Provider,
    public readonly config: ProfitabilityConfig,
    protected readonly priceFeed: IPriceFeed,
  ) {
    this.logger = new ConsoleLogger("info");
    this.isRunning = false;
    this.lastGasPrice = BigInt(0);
    this.lastUpdateTimestamp = 0;
    this.rewardTokenAddress = "";

    // Validate staker contract
    if (!this.stakerContract.interface.hasFunction("bumpEarningPower")) {
      throw new Error(
        "Invalid staker contract: missing bumpEarningPower function",
      );
    }
  }

  async start(): Promise<void> {
    this.rewardTokenAddress = this.config.rewardTokenAddress;
    this.isRunning = true;
    this.logger.info("Profitability engine started");
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.logger.info("Profitability engine stopped");
  }

  async getStatus(): Promise<{
    isRunning: boolean;
    lastGasPrice: bigint;
    lastUpdateTimestamp: number;
    queueSize: number;
    delegateeCount: number;
  }> {
    return {
      isRunning: this.isRunning,
      lastGasPrice: this.lastGasPrice,
      lastUpdateTimestamp: this.lastUpdateTimestamp,
      queueSize: 0, // TODO: Implement queue tracking if needed
      delegateeCount: 0, // TODO: Implement delegatee tracking if needed
    };
  }

  async checkProfitability(deposit: Deposit): Promise<ProfitabilityCheck> {
    try {
      // Validate deposit has required fields
      if (!deposit.owner_address || !deposit.amount) {
        this.logger.error("Invalid deposit data:", {
          depositId: deposit.deposit_id,
          owner: deposit.owner_address,
          amount: deposit.amount?.toString(),
        });
        return this.createFailedProfitabilityCheck("calculatorEligible");
      }

      // Check bump requirements
      const requirements = await this.validateBumpRequirements(deposit);
      if (!requirements.isEligible) {
        return this.createFailedProfitabilityCheck("calculatorEligible");
      }

      // Check if delegatee score has changed
      const hasScoreChanged = await this.checkScoreChanged(
        deposit.delegatee_address!,
      );
      if (!hasScoreChanged) {
        return this.createFailedProfitabilityCheck("hasScoreChanged");
      }

      // Check if the transaction would succeed using static call
      const staticCallResult = await this.simulateTransaction(deposit);
      if (staticCallResult === null) {
        // If static call fails, transaction will also fail
        return this.createFailedProfitabilityCheck("calculatorEligible");
      }

      // Check if the earning power will actually change
      const isEarningPowerIncrease = staticCallResult !== deposit.earning_power;
      if (!isEarningPowerIncrease) {
        return this.createFailedProfitabilityCheck("hasEarningPowerIncrease");
      }

      // Calculate optimal tip
      const tipOptimization = await this.calculateOptimalTip(
        deposit,
        await this.getGasPriceWithBuffer(),
      );

      // Check unclaimed rewards rules based on earning power change
      const earningPowerIncreasing = staticCallResult > deposit.earning_power!;

      if (earningPowerIncreasing) {
        // For power increases: unclaimedRewards must be >= requestedTip
        if (requirements.unclaimedRewards < tipOptimization.optimalTip) {
          return this.createFailedProfitabilityCheck("hasEnoughRewards");
        }
      } else {
        // For power decreases: (unclaimedRewards - requestedTip) must be >= maxBumpTip
        if (
          requirements.unclaimedRewards - tipOptimization.optimalTip <
          requirements.maxBumpTip
        ) {
          return this.createFailedProfitabilityCheck("hasEnoughRewards");
        }
      }

      // Check if operation is profitable
      const isProfitable =
        tipOptimization.expectedProfit >= this.config.minProfitMargin;
      if (!isProfitable) {
        return this.createFailedProfitabilityCheck("isProfitable");
      }

      return {
        canBump: true,
        constraints: {
          calculatorEligible: true,
          hasEnoughRewards: true,
          isProfitable: true,
          hasScoreChanged: true,
          hasEarningPowerIncrease: true,
        },
        estimates: {
          optimalTip: tipOptimization.optimalTip,
          gasEstimate: tipOptimization.gasEstimate,
          expectedProfit: tipOptimization.expectedProfit,
          tipReceiver: this.config.defaultTipReceiver,
          staticCallResult,
        },
      };
    } catch (error) {
      this.logger.error("Error checking profitability:", {
        error,
        depositId: deposit.deposit_id,
      });
      throw error;
    }
  }

  async analyzeBatchProfitability(deposits: Deposit[]): Promise<BatchAnalysis> {
    try {
      // Limit batch size
      const batchDeposits = deposits.slice(0, this.config.maxBatchSize);
      // Analyze each deposit
      const results = await Promise.all(
        batchDeposits.map(async (deposit) => ({
          depositId: deposit.deposit_id,
          profitability: await this.checkProfitability(deposit),
        })),
      );

      // Filter profitable deposits
      const profitableDeposits = results.filter(
        (result) => result.profitability.canBump,
      );

      // Calculate batch metrics
      const totalGasEstimate = profitableDeposits.reduce(
        (sum, result) => sum + result.profitability.estimates.gasEstimate,
        BigInt(0),
      );

      const totalExpectedProfit = profitableDeposits.reduce(
        (sum, result) => sum + result.profitability.estimates.expectedProfit,
        BigInt(0),
      );

      // Determine optimal batch size based on gas costs and profits
      const recommendedBatchSize = this.calculateOptimalBatchSize(
        profitableDeposits.length,
        totalGasEstimate,
        totalExpectedProfit,
      );

      return {
        deposits: results,
        totalGasEstimate,
        totalExpectedProfit,
        recommendedBatchSize,
      };
    } catch (error) {
      this.logger.error("Error analyzing batch profitability:", { error });
      throw error;
    }
  }

  protected async validateBumpRequirements(
    deposit: Deposit,
  ): Promise<BumpRequirements> {
    // Get current and potential new earning power
    this.logger.info("Checking bump requirements for deposit:", {
      id: deposit.deposit_id.toString(),
      amount: ethers.formatEther(deposit.amount),
      earning_power: deposit.earning_power
        ? ethers.formatEther(deposit.earning_power)
        : "0.0",
      owner: deposit.owner_address,
      delegatee: deposit.delegatee_address,
    });

    // Get the latest score event for this delegatee from the database
    let latestScoreEvent = null;
    try {
      if (deposit.delegatee_address) {
        // First check if we can get the latest score event from the database
        latestScoreEvent = await this.calculator["db"].getLatestScoreEvent(
          deposit.delegatee_address,
        );

        if (latestScoreEvent) {
          this.logger.info("Found latest score event for delegatee:", {
            delegatee: deposit.delegatee_address,
            score: latestScoreEvent.score,
            blockNumber: latestScoreEvent.block_number,
            created_at: latestScoreEvent.created_at,
          });
        } else {
          this.logger.info("No score events found for delegatee in database", {
            delegatee: deposit.delegatee_address,
          });
        }
      }
    } catch (error) {
      this.logger.warn(
        "Error retrieving latest score event, continuing with contract call:",
        {
          error,
          delegatee: deposit.delegatee_address,
        },
      );
    }

    // Call getNewEarningPower with the deposit information
    const [newEarningPower, isEligible] =
      await this.calculator.getNewEarningPower(
        deposit.amount,
        deposit.owner_address,
        deposit.delegatee_address!,
        deposit.earning_power || BigInt(0),
      );

    this.logger.info("Calculator results:", {
      newEarningPower: ethers.formatEther(newEarningPower),
      isEligible,
      hasLatestScoreEvent: !!latestScoreEvent,
    });

    try {
      // Get unclaimed rewards and max tip
      const unclaimedRewards = await this.stakerContract.unclaimedReward(
        deposit.deposit_id,
      );
      const maxBumpTipValue = await this.stakerContract.maxBumpTip();

      this.logger.info("Contract values:", {
        unclaimedRewards: ethers.formatEther(unclaimedRewards),
        maxBumpTip: ethers.formatEther(maxBumpTipValue),
      });

      return {
        isEligible,
        newEarningPower,
        unclaimedRewards: BigInt(unclaimedRewards.toString()),
        maxBumpTip: BigInt(maxBumpTipValue.toString()),
      };
    } catch (error) {
      this.logger.error("Error getting staker contract values:", { error });
      throw error;
    }
  }

  protected async calculateOptimalTip(
    deposit: Deposit,
    gasPrice: bigint,
  ): Promise<TipOptimization> {
    try {
      // Get max tip value and requirements
      const maxBumpTipValue = await this.stakerContract.maxBumpTip();
      const requirements = await this.validateBumpRequirements(deposit);

      if (!requirements.isEligible) {
        return {
          optimalTip: BigInt(0),
          expectedProfit: BigInt(0),
          gasEstimate: BigInt(0),
        };
      }

      // Use a higher minimum tip for estimation (10% of max)
      const minimumTip = maxBumpTipValue / BigInt(10);

      // Use the configured tip receiver or default to zero address
      const tipReceiver = this.config.defaultTipReceiver || ethers.ZeroAddress;

      // Default/fallback gas estimate for when direct estimation fails
      // This is a reasonable estimate for an ERC20 transfer + some logic
      const FALLBACK_GAS_ESTIMATE = BigInt(150000);

      // Try to estimate gas, but use fallback if it fails
      let gasEstimate: bigint;
      try {
        // Get current network conditions
        const feeData = await this.provider.getFeeData();
        const maxFeePerGas = feeData.maxFeePerGas;
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;

        // Log fee data for debugging
        this.logger.info("Network fee data:", {
          maxFeePerGas: maxFeePerGas?.toString() || "undefined",
          maxPriorityFeePerGas: maxPriorityFeePerGas?.toString() || "undefined",
          gasPrice: feeData.gasPrice?.toString() || "undefined",
        });

        // Encode the function call
        const encodedData = this.stakerContract.interface.encodeFunctionData(
          "bumpEarningPower",
          [BigInt(deposit.deposit_id), tipReceiver, minimumTip],
        );

        // Estimate gas with proper parameters
        gasEstimate = await this.provider.estimateGas({
          to: this.stakerContract.target,
          data: encodedData,
          from: tipReceiver, // Add from address for more accurate estimation
          value: minimumTip, // Include value since this affects gas usage
        });

        // Add 20% buffer for safety
        gasEstimate = (gasEstimate * BigInt(120)) / BigInt(100);

        this.logger.info(
          `Gas estimation succeeded for deposit ${deposit.deposit_id}:`,
          {
            gasEstimate: gasEstimate.toString(),
            minimumTip: minimumTip.toString(),
            tipReceiver,
          },
        );
      } catch (error) {
        // Log specific error details for debugging
        this.logger.error("Failed to estimate gas", {
          error: error instanceof Error ? error.message : String(error),
          depositId: deposit.deposit_id.toString(),
          minimumTip: minimumTip.toString(),
          errorData:
            error instanceof Error && "data" in error ? error.data : undefined,
          errorReason:
            error instanceof Error && "reason" in error
              ? error.reason
              : undefined,
        });

        // Check for specific error types
        if (
          error instanceof Error &&
          "code" in error &&
          "data" in error &&
          "reason" in error
        ) {
          const err = error as { code: string; data: string; reason?: string };
          if (err.code === "CALL_EXCEPTION") {
            if (err.data === "0x4e487b71" && err.reason?.includes("OVERFLOW")) {
              this.logger.warn(
                `Overflow error for deposit ${deposit.deposit_id}. Using fallback gas estimate.`,
              );
            }
            if (err.data === "0xaca01fbc") {
              this.logger.warn(
                `Deposit ${deposit.deposit_id} not eligible for bump. Using fallback gas estimate.`,
              );
            }
          }
        }

        // Use a conservative fallback estimate
        gasEstimate = FALLBACK_GAS_ESTIMATE;
        this.logger.warn(
          `Gas estimation failed for deposit ${deposit.deposit_id}, using fallback estimate:`,
          {
            fallbackEstimate: FALLBACK_GAS_ESTIMATE.toString(),
          },
        );
      }

      // Calculate base cost in wei
      const baseCost = gasEstimate * gasPrice;

      // Get token price and convert base cost to token terms
      let baseCostInToken: bigint;
      try {
        baseCostInToken = await this.priceFeed.getTokenPriceInWei(
          this.rewardTokenAddress,
          baseCost,
        );
      } catch (error) {
        // TODO: In production, we should handle this error more gracefully
        // This mock value is only for testing purposes
        this.logger.warn(
          "Failed to fetch token price from CoinMarketCap, using mock value for testing:",
          {
            error,
            tokenAddress: this.rewardTokenAddress,
          },
        );

        // Mock conversion rate: 1 ETH = 10000 tokens (0.0001 ETH per token)
        baseCostInToken = baseCost * BigInt(10000); // 1/0.0001 = 10000
      }

      // Check if this is a power decrease
      const isEarningPowerDecrease =
        requirements.newEarningPower < deposit.earning_power!;

      // Calculate optimal tip based on gas cost and minimum profit margin
      // Ensure tip doesn't exceed maxBumpTip
      const maxTip = BigInt(maxBumpTipValue.toString());
      let desiredTip = baseCostInToken + this.config.minProfitMargin;

      // For power decreases, we need to ensure there's enough left for MAX_BUMP_TIP
      if (isEarningPowerDecrease) {
        // Calculate max available tip considering we need to leave MAX_BUMP_TIP
        const maxAvailableTip = requirements.unclaimedRewards - maxBumpTipValue;

        // If maxAvailableTip is negative or zero, we can't proceed
        if (maxAvailableTip <= 0) {
          this.logger.info(
            `Not enough unclaimed rewards for deposit ${deposit.deposit_id} to cover MAX_BUMP_TIP requirement:`,
            {
              unclaimedRewards: requirements.unclaimedRewards.toString(),
              maxBumpTip: maxBumpTipValue.toString(),
              availableForTip: maxAvailableTip.toString(),
            },
          );
          return {
            optimalTip: BigInt(0),
            expectedProfit: BigInt(0),
            gasEstimate: BigInt(0),
          };
        }

        // Ensure desiredTip doesn't exceed maxAvailableTip
        if (desiredTip > maxAvailableTip) {
          this.logger.info(
            `Adjusting tip for deposit ${deposit.deposit_id} to leave room for MAX_BUMP_TIP:`,
            {
              originalDesiredTip: desiredTip.toString(),
              adjustedTip: maxAvailableTip.toString(),
              maxBumpTip: maxBumpTipValue.toString(),
              unclaimedRewards: requirements.unclaimedRewards.toString(),
            },
          );
          desiredTip = maxAvailableTip;
        }
      }

      // Apply usual max tip constraint
      const optimalTip = desiredTip > maxTip ? maxTip : desiredTip;

      // Calculate expected profit
      const expectedProfit =
        optimalTip > baseCostInToken ? optimalTip - baseCostInToken : BigInt(0); // Ensure we never return negative profit

      return {
        optimalTip,
        expectedProfit,
        gasEstimate: BigInt(gasEstimate.toString()),
      };
    } catch (error) {
      this.logger.error("Error calculating optimal tip:", { error });
      throw error;
    }
  }

  protected async getGasPriceWithBuffer(): Promise<bigint> {
    const feeData = await this.provider.getFeeData();
    if (!feeData.gasPrice) {
      throw new Error("Failed to get gas price");
    }

    const baseGasPrice = BigInt(feeData.gasPrice.toString());
    const buffer =
      (baseGasPrice * BigInt(this.config.gasPriceBuffer)) / BigInt(100);

    this.lastGasPrice = baseGasPrice + buffer;
    this.lastUpdateTimestamp = Date.now();

    return this.lastGasPrice;
  }

  protected calculateOptimalBatchSize(
    availableDeposits: number,
    totalGasEstimate: bigint,
    totalExpectedProfit: bigint,
  ): number {
    // If no deposits are available, return 0
    if (availableDeposits === 0) {
      return 0;
    }

    // If no gas cost or profit, use max batch size
    if (totalGasEstimate === BigInt(0) || totalExpectedProfit === BigInt(0)) {
      return Math.min(availableDeposits, this.config.maxBatchSize);
    }

    // Calculate per-deposit metrics
    const profitPerDeposit = totalExpectedProfit / BigInt(availableDeposits);
    const gasPerDeposit = totalGasEstimate / BigInt(availableDeposits);

    // Start with maximum available deposits
    let optimalSize = availableDeposits;

    // Reduce batch size if profit per deposit is too low
    while (
      optimalSize > 1 &&
      profitPerDeposit < gasPerDeposit * BigInt(2) // Minimum 2x profit/gas ratio
    ) {
      optimalSize--;
    }

    return Math.min(optimalSize, this.config.maxBatchSize);
  }

  /**
   * Check if a delegatee's score has changed since the last score event
   * @param delegatee The delegatee address to check
   * @returns true if the score has changed or if there's no previous score to compare against
   */
  protected async checkScoreChanged(delegatee: string): Promise<boolean> {
    try {
      if (!delegatee) {
        this.logger.warn(
          "No delegatee address provided for score change check",
        );
        return false;
      }

      // Get the latest score event
      const latestScoreEvent =
        await this.calculator["db"].getLatestScoreEvent(delegatee);
      if (!latestScoreEvent) {
        this.logger.info(`No score events found for delegatee ${delegatee}`);
        // If there are no score events, we can't determine if it changed
        // Default to true for first-time delegatees to allow initial bumping
        return true;
      }

      // Get the latest score as BigInt
      const latestScore = BigInt(latestScoreEvent.score);
      this.logger.info(
        `Latest score for delegatee ${delegatee}: ${latestScore.toString()} at block ${latestScoreEvent.block_number}`,
      );

      // Get earlier score events to compare
      try {
        // Get earlier score events within a large block range
        const blockRange = 20000000; // Look back 20 million blocks
        const earlierEvents = await this.calculator[
          "db"
        ].getScoreEventsByBlockRange(
          Math.max(1, latestScoreEvent.block_number - blockRange),
          latestScoreEvent.block_number - 1, // Exclude the latest event
        );

        // Filter for events belonging to this delegatee
        const delegateeEvents = earlierEvents
          .filter(
            (event: {
              delegatee: string;
              block_number?: number;
              score?: string;
            }) => event?.delegatee === delegatee,
          )
          .filter((event) => event !== undefined);

        this.logger.info(
          `Found ${delegateeEvents.length} earlier score events for delegatee ${delegatee}`,
        );

        // If no earlier events, treat as a change (first event)
        if (delegateeEvents.length === 0) {
          this.logger.info(
            `No previous scores found for delegatee ${delegatee}, treating as changed`,
          );
          return true;
        }

        // Sort by block number (descending)
        delegateeEvents.sort(
          (a: { block_number?: number }, b: { block_number?: number }) => {
            if (!a?.block_number || !b?.block_number) return 0;
            return b.block_number - a.block_number;
          },
        );

        // Ensure we have score data
        if (!delegateeEvents[0]?.score) {
          this.logger.warn(
            `No score data found in previous events for delegatee ${delegatee}`,
          );
          return true;
        }

        // Get the most recent previous score
        const previousScore = BigInt(delegateeEvents[0].score);
        const previousBlockNumber = delegateeEvents[0].block_number || 0;

        this.logger.info(
          `Previous score for delegatee ${delegatee}: ${previousScore.toString()} at block ${previousBlockNumber}`,
        );

        // Compare scores
        const hasChanged = latestScore !== previousScore;
        this.logger.info(
          `Score change check for delegatee ${delegatee}: ${hasChanged ? "CHANGED" : "UNCHANGED"}`,
        );
        return hasChanged;
      } catch (blockRangeError) {
        this.logger.warn(`Error searching block range for scores:`, {
          error:
            blockRangeError instanceof Error
              ? blockRangeError.message
              : String(blockRangeError),
        });

        // If we couldn't determine if it changed, default to true to avoid missing opportunities
        return true;
      }
    } catch (error) {
      this.logger.warn(
        `Error checking score change for delegatee ${delegatee}:`,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      // If we couldn't determine if it changed, default to true to avoid missing opportunities
      return true;
    }
  }

  /**
   * Simulate the transaction to check if it would succeed and get the resulting earning power
   * @param deposit The deposit to simulate bumping
   * @returns The new earning power value on success, or null if the transaction would fail
   */
  protected async simulateTransaction(
    deposit: Deposit,
  ): Promise<bigint | null> {
    try {
      if (!deposit.deposit_id || deposit.earning_power === undefined) {
        this.logger.warn(
          `Cannot simulate transaction for deposit with missing ID or earning power`,
        );
        return null;
      }

      // Use the configured tip receiver or default to zero address
      const tipReceiver = this.config.defaultTipReceiver || ethers.ZeroAddress;

      // Use minimum tip for simulation (10% of max)
      const maxBumpTipValue = await this.stakerContract.maxBumpTip();
      const minimumTip = maxBumpTipValue / BigInt(10);

      this.logger.info(
        `Simulating bumpEarningPower transaction for deposit ${deposit.deposit_id}`,
        {
          tipReceiver,
          minimumTip: minimumTip.toString(),
        },
      );

      // Simulate the transaction using staticCall
      try {
        // Use the function reference with staticCall method
        const bumpFunction =
          this.stakerContract.getFunction("bumpEarningPower");
        const newEarningPower = await bumpFunction.staticCall(
          deposit.deposit_id,
          tipReceiver,
          minimumTip,
          { value: minimumTip },
        );

        this.logger.info(
          `Simulation successful for deposit ${deposit.deposit_id}:`,
          {
            currentEarningPower: deposit.earning_power.toString(),
            newEarningPower: newEarningPower.toString(),
            hasDifference: newEarningPower !== deposit.earning_power,
          },
        );

        return newEarningPower;
      } catch (error) {
        this.logger.error(
          `Transaction simulation failed for deposit ${deposit.deposit_id}:`,
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return null;
      }
    } catch (error) {
      this.logger.error(
        `Error in transaction simulation for deposit ${deposit.deposit_id}:`,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return null;
    }
  }

  private createFailedProfitabilityCheck(
    failedConstraint: keyof ProfitabilityCheck["constraints"],
  ): ProfitabilityCheck {
    const constraints: ProfitabilityCheck["constraints"] = {
      calculatorEligible: true,
      hasEnoughRewards: true,
      isProfitable: true,
      hasScoreChanged: true,
      hasEarningPowerIncrease: true,
    };

    // Set the failed constraint to false
    constraints[failedConstraint] = false;

    return {
      canBump: false,
      constraints,
      estimates: {
        optimalTip: BigInt(0),
        gasEstimate: BigInt(0),
        expectedProfit: BigInt(0),
        tipReceiver: this.config.defaultTipReceiver,
      },
    };
  }

  async getQueueStats(): Promise<{
    pendingCount: number;
    processingCount: number;
    completedCount: number;
    failedCount: number;
  }> {
    return {
      pendingCount: 0, // TODO: Implement queue tracking if needed
      processingCount: 0,
      completedCount: 0,
      failedCount: 0,
    };
  }
}
