import { ethers } from 'ethers';
import { IDatabase } from '@/database';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { ExecutorWrapper } from '@/executor';
import {
  IGovLstClaimer
} from '../interfaces/IGovLstClaimer';
import {
  ClaimBatch,
  ClaimResult,
  GovLstClaimerConfig,
  RewardAnalysis
} from '../interfaces/types';
import { GOVLST_ABI, STAKER_CLAIM_ABI } from '../constants';
import {
  calculateUnclaimedRewards,
  sortDepositsByReward,
  verifyDepositOwnership
} from '../utils/rewardCalculator';
import {
  calculateProfitability,
  groupDepositsForMaximumProfit
} from '../utils/batchOptimizer';

// Define contract types to avoid linter errors
type GovLstContract = ethers.Contract & {
  STAKER(): Promise<string>;
  payoutAmount(): Promise<bigint>;
  claimAndDistributeReward(
    tipReceiver: string,
    minTotalRewards: bigint,
    depositIds: bigint[]
  ): Promise<bigint>;
};

type StakerContract = ethers.Contract & {
  unclaimedReward(depositId: string | bigint): Promise<bigint>;
  deposits(depositId: string | bigint): Promise<{
    owner: string;
    balance: bigint;
    earningPower: bigint;
    delegatee: string;
    claimer: string;
  }>;
};

export class BaseGovLstClaimer implements IGovLstClaimer {
  private isRunning = false;
  private processingInterval: NodeJS.Timeout | null = null;
  private contractCache = new Map<string, {
    govLstContract: ethers.Contract,
    stakerContract: ethers.Contract,
    stakerAddress: string,
    payoutAmount: bigint
  }>();

  private readonly logger: Logger;

  // Status tracking
  private monitorStatus: Record<string, {
    lastCheck: string;
    depositCount: number;
    pendingClaims: number;
  }> = {};

  constructor(
    private readonly db: IDatabase,
    private readonly provider: ethers.Provider,
    private readonly executor: ExecutorWrapper,
    private readonly config: GovLstClaimerConfig
  ) {
    this.logger = new ConsoleLogger('info');
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;
    this.logger.info('Starting GovLst Claimer', {
      govLstAddresses: this.config.addresses
    });

    // Initialize GovLst contracts in database
    await this.initializeGovLstContracts();

    // Start periodic processing
    this.processingInterval = setInterval(
      () => this.processClaimableRewards().catch(error => {
        this.logger.error('Error in periodic claim processing', { error });
      }),
      this.config.claimInterval * 1000
    );

    // Process immediately
    this.processClaimableRewards().catch(error => {
      this.logger.error('Error in initial claim processing', { error });
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    this.logger.info('GovLst Claimer stopped');
  }

  async getStatus(): Promise<{
    isRunning: boolean;
    monitors: Record<string, {
      lastCheck: string;
      depositCount: number;
      pendingClaims: number;
    }>;
  }> {
    return {
      isRunning: this.isRunning,
      monitors: this.monitorStatus,
    };
  }

  async processClaimableRewards(): Promise<void> {
    if (!this.isRunning) return;

    try {
      this.logger.info('Processing claimable rewards for all GovLst contracts');

      // For each GovLst contract
      for (const govLstAddress of this.config.addresses) {
        try {
          // Analyze rewards
          const analysis = await this.analyzeRewards(govLstAddress);

          // Update monitor status
          this.monitorStatus[govLstAddress] = {
            lastCheck: new Date().toISOString(),
            depositCount: analysis.totalDeposits,
            pendingClaims: analysis.optimalBatches.length,
          };

          // Execute profitable batches
          for (const batch of analysis.optimalBatches) {
            await this.executeClaimBatch(govLstAddress, batch);
          }
        } catch (error) {
          this.logger.error(`Error processing GovLst contract ${govLstAddress}`, { error });
        }
      }
    } catch (error) {
      this.logger.error('Error in processClaimableRewards', { error });
    }
  }

  async analyzeRewards(govLstAddress: string): Promise<RewardAnalysis> {
    this.logger.info(`Analyzing rewards for GovLst contract ${govLstAddress}`);

    try {
      // Get contracts for this GovLst
      const { stakerContract, payoutAmount } = await this.getContracts(govLstAddress);

      // Get deposits owned by this GovLst
      const deposits = await this.db.getDepositsByOwner(govLstAddress);
      const depositIds = deposits.map(deposit => deposit.deposit_id);

      this.logger.info(`Found ${depositIds.length} deposits for GovLst ${govLstAddress}`);

      // Verify ownership
      const verifiedDepositIds = await verifyDepositOwnership(
        stakerContract as any, // Type cast to satisfy TypeScript
        depositIds,
        govLstAddress,
        this.logger
      );

      this.logger.info(`Verified ${verifiedDepositIds.length} deposits for GovLst ${govLstAddress}`);

      // Calculate unclaimed rewards
      const depositRewards = await calculateUnclaimedRewards(
        stakerContract as any, // Type cast to satisfy TypeScript
        verifiedDepositIds,
        this.logger
      );

      // Sort by reward amount
      const sortedDepositIds = sortDepositsByReward(depositRewards);

      // Get gas price for profitability calculation
      const gasPrice = await this.provider.getFeeData()
        .then(fees => fees.gasPrice || BigInt(0))
        .catch(() => BigInt(0));

      // Group into batches
      const optimizedBatches = groupDepositsForMaximumProfit(
        sortedDepositIds,
        depositRewards,
        payoutAmount,
        gasPrice,
        {
          maxBatchSize: this.config.maxBatchSize,
          gasPriceBuffer: this.config.gasPriceBuffer,
          minProfitMargin: this.config.minProfitMargin,
        },
        this.logger
      );

      // Calculate total rewards
      let totalClaimableRewards = BigInt(0);
      for (const [depositId, reward] of depositRewards.entries()) {
        totalClaimableRewards += reward;
      }

      // Create analysis result
      const result: RewardAnalysis = {
        govLstAddress,
        totalDeposits: verifiedDepositIds.length,
        totalClaimableRewards,
        profitableDeposits: optimizedBatches.reduce(
          (sum, batch) => sum + batch.depositIds.length,
          0
        ),
        optimalBatches: optimizedBatches,
      };

      this.logger.info('Reward analysis complete', {
        govLstAddress,
        totalDeposits: result.totalDeposits,
        claimableRewards: result.totalClaimableRewards.toString(),
        profitableDeposits: result.profitableDeposits,
        batchCount: result.optimalBatches.length,
      });

      return result;
    } catch (error) {
      this.logger.error(`Error analyzing rewards for ${govLstAddress}`, { error });
      throw new Error(`Failed to analyze rewards: ${error}`);
    }
  }

  async executeClaimBatch(
    govLstAddress: string,
    batch: ClaimBatch
  ): Promise<ClaimResult> {
    try {
      this.logger.info(`Executing claim batch for GovLst ${govLstAddress}`, {
        depositCount: batch.depositIds.length,
        estimatedReward: batch.estimatedReward.toString(),
        estimatedProfit: batch.estimatedProfit.toString(),
      });

      // Get contracts
      const { govLstContract } = await this.getContracts(govLstAddress);

      // Prepare transaction data
      const txData = {
        govLstAddress,
        depositIds: batch.depositIds.map(id => BigInt(id)),
        tipReceiver: this.config.tipReceiver || '0x0000000000000000000000000000000000000000',
        minExpectedReward: batch.estimatedReward * BigInt(95) / BigInt(100), // 5% safety buffer
      };

      // Queue transaction for execution
      const transaction = await this.executor.queueTransaction(
        BigInt(0), // Not using depositId for this transaction
        {
          canBump: false, // This is a claim, not a bump
          constraints: {
            calculatorEligible: true, // Not relevant for claims
            hasEnoughRewards: true, // We've already verified this
            isProfitable: true, // We've already calculated profitability
          },
          estimates: {
            optimalTip: BigInt(0), // Not using tips for claims
            gasEstimate: batch.estimatedGasCost,
            expectedProfit: batch.estimatedProfit,
            tipReceiver: txData.tipReceiver,
          },
        },
        JSON.stringify(txData)
      );

      // Create claim history record
      await this.db.createGovLstClaimHistory({
        govlst_address: govLstAddress,
        deposit_ids: batch.depositIds,
        claimed_reward: batch.estimatedReward.toString(),
        payout_amount: this.config.payoutAmount.toString(),
        profit: batch.estimatedProfit.toString(),
      });

      // Update GovLst deposits
      for (const depositId of batch.depositIds) {
        const existingDeposit = await this.db.getGovLstDeposit(depositId);

        if (existingDeposit) {
          // Update existing record
          await this.db.updateGovLstDeposit(depositId, {
            last_reward_check: new Date().toISOString(),
            last_unclaimed_reward: '0', // Reset after claim
          });
        } else {
          // Create new record
          await this.db.createGovLstDeposit({
            deposit_id: depositId,
            govlst_address: govLstAddress,
            last_reward_check: new Date().toISOString(),
            last_unclaimed_reward: '0', // Claimed
          });
        }
      }

      return {
        govLstAddress,
        batch,
        transactionId: transaction.id,
        success: true,
      };
    } catch (error) {
      this.logger.error(`Error executing claim batch for ${govLstAddress}`, { error });

      return {
        govLstAddress,
        batch,
        success: false,
        error: `Failed to execute claim: ${error}`,
      };
    }
  }

  private async initializeGovLstContracts(): Promise<void> {
    this.logger.info('Initializing GovLst contracts');

    for (const govLstAddress of this.config.addresses) {
      try {
        // Get contract instances
        await this.getContracts(govLstAddress);

        // Initialize monitoring status
        this.monitorStatus[govLstAddress] = {
          lastCheck: new Date().toISOString(),
          depositCount: 0,
          pendingClaims: 0,
        };
      } catch (error) {
        this.logger.error(`Failed to initialize GovLst contract ${govLstAddress}`, { error });
      }
    }
  }

  private async getContracts(govLstAddress: string): Promise<{
    govLstContract: GovLstContract;
    stakerContract: StakerContract;
    stakerAddress: string;
    payoutAmount: bigint;
  }> {
    // Check cache first
    if (this.contractCache.has(govLstAddress)) {
      const cached = this.contractCache.get(govLstAddress)!;
      return {
        ...cached,
        govLstContract: cached.govLstContract as GovLstContract,
        stakerContract: cached.stakerContract as StakerContract
      };
    }

    try {
      // Create GovLst contract instance
      const govLstContractInstance = new ethers.Contract(
        govLstAddress,
        GOVLST_ABI,
        this.provider
      );

      // Type assertion to access custom methods
      const govLstContract = govLstContractInstance as GovLstContract;

      // Get Staker contract address
      const stakerAddress = await (govLstContract.STAKER ? govLstContract.STAKER() : Promise.reject(new Error('STAKER method not found on contract')));

      // Create Staker contract instance
      const stakerContractInstance = new ethers.Contract(
        stakerAddress,
        STAKER_CLAIM_ABI,
        this.provider
      );

      // Type assertion to access custom methods
      const stakerContract = stakerContractInstance as StakerContract;

      // Get payout amount
      const payoutAmount = await (govLstContract.payoutAmount ? govLstContract.payoutAmount() : Promise.reject(new Error('payoutAmount method not found on contract')));

      // Cache the contracts
      const result = {
        govLstContract,
        stakerContract,
        stakerAddress,
        payoutAmount,
      };

      this.contractCache.set(govLstAddress, result);

      this.logger.info(`Initialized contracts for GovLst ${govLstAddress}`, {
        stakerAddress,
        payoutAmount: payoutAmount.toString(),
      });

      return result;
    } catch (error) {
      this.logger.error(`Error getting contracts for ${govLstAddress}`, { error });
      throw new Error(`Failed to get contracts: ${error}`);
    }
  }
}
