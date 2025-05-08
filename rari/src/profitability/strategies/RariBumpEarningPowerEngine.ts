import { IProfitabilityEngine } from '../interfaces/IProfitabilityEngine'
import { IExecutor } from '../../executor/interfaces/IExecutor'
import { IDatabase } from '../../database/interfaces/IDatabase'
import { BaseProfitabilityEngine } from './BaseProfitabilityEngine'
import { CalculatorWrapper } from '../../calculator/CalculatorWrapper'
import { Deposit, ProcessingQueueItem } from '../../database/interfaces/types'
import { ProfitabilityQueueBatchResult, ProfitabilityQueueResult } from '../interfaces/types'
import { ConsoleLogger } from '../../monitor/logging'
import { CONFIG } from '../../configuration'
import { GasCostEstimator } from '../../prices/GasCostEstimator'
import { ethers } from 'ethers'
import { BinaryEligibilityOracleEarningPowerCalculator } from '../../calculator'
import { IPriceFeed } from '../../shared/price-feeds/interfaces'
import { ProfitabilityConfig } from '../interfaces/types'

const logger = new ConsoleLogger('info', { prefix: 'RariBumpEarningPowerEngine' })

export class RariBumpEarningPowerEngine extends BaseProfitabilityEngine implements IProfitabilityEngine {
  private calculatorWrapper: CalculatorWrapper
  private gasCostEstimator: GasCostEstimator
  protected database: IDatabase
  protected executor: IExecutor
  private periodicCheckInterval: NodeJS.Timeout | null = null
  protected isRunning = false
  private readonly PERIODIC_CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes
  protected lastUpdateTimestamp: number

  constructor({
    database,
    executor,
    calculatorWrapper,
    calculator,
    stakerContract,
    provider,
    config,
    priceFeed,
    logger: loggerInstance = logger,
  }: {
    database: IDatabase
    executor: IExecutor
    calculatorWrapper: CalculatorWrapper
    calculator: BinaryEligibilityOracleEarningPowerCalculator
    stakerContract: ethers.Contract & {
      deposits(depositId: bigint): Promise<{
        owner: string
        balance: bigint
        earningPower: bigint
        delegatee: string
        claimer: string
      }>
      unclaimedReward(depositId: bigint): Promise<bigint>
      maxBumpTip(): Promise<bigint>
      bumpEarningPower(
        depositId: bigint,
        tipReceiver: string,
        tip: bigint,
      ): Promise<bigint>
      REWARD_TOKEN(): Promise<string>
    }
    provider: ethers.Provider
    config: ProfitabilityConfig
    priceFeed: IPriceFeed
    logger?: ConsoleLogger
    gasPriceMultiplier?: number
    maxGasPrice?: string
  }) {
    super(calculator, stakerContract, provider, config, priceFeed)
    this.calculatorWrapper = calculatorWrapper
    this.gasCostEstimator = new GasCostEstimator()
    this.database = database
    this.executor = executor
    this.lastUpdateTimestamp = Date.now()
  }

  async processItem({ item }: { item: ProcessingQueueItem }): Promise<ProfitabilityQueueResult> {
    try {
      const deposit = await this.database.getDeposit(item.deposit_id)

      if (!deposit) {
        throw new Error(`Deposit ${item.deposit_id} not found`)
      }

      logger.info('Processing bump earning power for deposit', {
        depositId: deposit.deposit_id,
        ownerAddress: deposit.owner_address,
        amount: deposit.amount,
      })

      const isBumpProfitable = await this.isBumpProfitable({ deposit })

      if (!isBumpProfitable.profitable) {
        logger.info('Bump not profitable', {
          depositId: deposit.deposit_id,
          reason: isBumpProfitable.reason,
        })
        return {
          success: true,
          result: 'not_profitable',
          details: { reason: isBumpProfitable.reason },
        }
      }

      // Queue the transaction
      // Create transaction data using ethers instead of web3
      const bumpEarningPowerInterface = new ethers.Interface([
        "function bumpEarningPower(uint256 depositId, address tipReceiver, uint256 tip)"
      ]);
      
      const data = bumpEarningPowerInterface.encodeFunctionData("bumpEarningPower", [
        deposit.deposit_id,
        CONFIG.executor.tipReceiver || ethers.ZeroAddress,
        isBumpProfitable.tipAmount!
      ]);

      const tx = {
        to: CONFIG.STAKER_CONTRACT_ADDRESS,
        data,
        gasLimit: CONFIG.BUMP_GAS_LIMIT || '300000',
      }

      logger.info('Queueing bump earning power transaction', {
        depositId: deposit.deposit_id,
        to: tx.to,
        tipAmount: isBumpProfitable.tipAmount,
      })

      await this.executor.queueTransaction(
        [BigInt(deposit.deposit_id)],
        {
          is_profitable: true,
          constraints: {
            has_enough_shares: true,
            meets_min_reward: true,
            meets_min_profit: true
          },
          estimates: {
            total_shares: BigInt(deposit.amount),
            payout_amount: isBumpProfitable.tipAmount!,
            gas_estimate: BigInt(CONFIG.BUMP_GAS_LIMIT || '300000'),
            gas_cost: BigInt(CONFIG.BUMP_GAS_LIMIT || '300000'),
            expected_profit: isBumpProfitable.tipAmount!
          },
          deposit_details: [{
            depositId: BigInt(deposit.deposit_id),
            rewards: isBumpProfitable.tipAmount!
          }]
        },
        tx.data
      )

      return {
        success: true,
        result: 'queued',
        details: {
          depositId: deposit.deposit_id,
          tipAmount: isBumpProfitable.tipAmount!.toString(),
        },
      }
    } catch (error) {
      logger.error('Error processing bump earning power', {
        itemId: item.id,
        depositId: item.deposit_id,
        error: (error as Error).message,
        stack: (error as Error).stack,
      })
      return {
        success: false,
        result: 'error',
        details: { error: (error as Error).message },
      }
    }
  }

  async processDepositsBatch({
    deposits,
  }: {
    deposits: Deposit[]
  }): Promise<ProfitabilityQueueBatchResult> {
    logger.info('Processing deposits batch', {
      count: deposits.length,
      timestamp: Date.now(),
    })
    const results: ProfitabilityQueueBatchResult = {
      success: true,
      total: deposits.length,
      queued: 0,
      notProfitable: 0,
      errors: 0,
      details: [],
    }

    for (const deposit of deposits) {
      try {
        const isBumpProfitable = await this.isBumpProfitable({ deposit })

        if (!isBumpProfitable.profitable) {
          results.notProfitable++
          results.details.push({
            depositId: deposit.deposit_id,
            result: 'not_profitable',
            details: { reason: isBumpProfitable.reason },
          })
          continue
        }

        // Queue the transaction using ethers instead of web3
        const bumpEarningPowerInterface = new ethers.Interface([
          "function bumpEarningPower(uint256 depositId, address tipReceiver, uint256 tip)"
        ]);
        
        const data = bumpEarningPowerInterface.encodeFunctionData("bumpEarningPower", [
          deposit.deposit_id,
          CONFIG.executor.tipReceiver || ethers.ZeroAddress,
          isBumpProfitable.tipAmount!
        ]);

        const tx = {
          to: CONFIG.STAKER_CONTRACT_ADDRESS,
          data,
          gasLimit: CONFIG.BUMP_GAS_LIMIT || '300000',
        }

        await this.executor.queueTransaction(
          [BigInt(deposit.deposit_id)],
          {
            is_profitable: true,
            constraints: {
              has_enough_shares: true,
              meets_min_reward: true,
              meets_min_profit: true
            },
            estimates: {
              total_shares: BigInt(deposit.amount),
              payout_amount: isBumpProfitable.tipAmount!,
              gas_estimate: BigInt(CONFIG.BUMP_GAS_LIMIT || '300000'),
              gas_cost: BigInt(CONFIG.BUMP_GAS_LIMIT || '300000'),
              expected_profit: isBumpProfitable.tipAmount!
            },
            deposit_details: [{
              depositId: BigInt(deposit.deposit_id),
              rewards: isBumpProfitable.tipAmount!
            }]
          },
          tx.data
        )

        results.queued++
        results.details.push({
          depositId: deposit.deposit_id,
          result: 'queued',
          details: { 
            tipAmount: isBumpProfitable.tipAmount!.toString(),
          },
        })
      } catch (error) {
        logger.error('Failed to process deposit', {
          depositId: deposit.deposit_id,
          error: (error as Error).message,
          timestamp: Date.now(),
        })
        results.errors++
        results.details.push({
          depositId: deposit.deposit_id,
          result: 'error',
          details: { error: (error as Error).message },
        })
      }
    }

    return results
  }

  /**
   * Handle score event updates for a delegatee
   * @param delegatee The delegatee address
   * @param score The new score value
   */
  async onScoreEvent(delegatee: string, score: bigint): Promise<void> {
    try {
      logger.info('Processing score event for delegatee', {
        delegatee,
        score: score.toString(),
      })

      // Get all deposits for this delegatee
      const deposits = await this.database.getDepositsByDelegatee(delegatee)
      
      if (deposits.length === 0) {
        logger.info('No deposits found for delegatee', { delegatee })
        return
      }

      logger.info('Found deposits for delegatee', {
        delegatee,
        count: deposits.length,
      })

      // Process the deposits batch
      await this.processDepositsBatch({ deposits })
    } catch (error) {
      logger.error('Error processing score event', {
        delegatee,
        score: score.toString(),
        error: (error as Error).message,
      })
      throw error
    }
  }

  private async isBumpProfitable({
    deposit,
  }: {
    deposit: Deposit
  }): Promise<{
    profitable: boolean
    reason?: string
    tipAmount?: bigint
  }> {
    try {
      // Calculate current earning power
      const currentScore = await this.calculatorWrapper.getEarningPower(
        BigInt(deposit.amount),
        deposit.owner_address,
        deposit.owner_address // Using owner as delegatee since this is a self-bump
      )

      if (!currentScore) {
        return {
          profitable: false,
          reason: 'Could not calculate current earning power',
        }
      }

      // Get MAX_BUMP_TIP value from the contract
      const maxBumpTipValue = await this.stakerContract.maxBumpTip()
      
      // Get unclaimed rewards
      const unclaimedRewards = await this.stakerContract.unclaimedReward(BigInt(deposit.deposit_id))

      // Calculate potential new earning power with a tip
      // Start with minimum tip and increase until profitable or hit max
      let tipAmount = BigInt(CONFIG.MIN_TIP_AMOUNT || '1000000000000000') // 0.001 ETH default
      const maxTipAmount = BigInt(CONFIG.MAX_TIP_AMOUNT || '10000000000000000') // 0.01 ETH default
      const tipIncrement = BigInt(CONFIG.TIP_INCREMENT || '1000000000000000') // 0.001 ETH default
      
      let bestScore = currentScore
      let bestTip = 0n
      let profitable = false

      // Get current gas price using ethers instead of web3
      const provider = this.stakerContract.runner?.provider || this.provider;
      const feeData = await provider.getFeeData();
      const gasPriceBigInt = feeData.gasPrice || BigInt('50000000000'); // 50 gwei default
      
      // Estimate gas cost for bump transaction
      const gasLimit = BigInt(CONFIG.BUMP_GAS_LIMIT || '300000')
      const gasCost = gasPriceBigInt * gasLimit

      while (tipAmount <= maxTipAmount) {
        // Calculate new score with this tip amount
        const [newScore] = await this.calculatorWrapper.getNewEarningPower(
          BigInt(deposit.amount),
          deposit.owner_address,
          deposit.owner_address, // Using owner as delegatee since this is a self-bump
          currentScore
        )

        if (!newScore) {
          tipAmount += tipIncrement
          continue
        }

        // Check if this is a power decrease and if so, ensure there's enough for MAX_BUMP_TIP
        const isEarningPowerDecrease = newScore < currentScore
        
        if (isEarningPowerDecrease) {
          // For power decreases: (unclaimedRewards - tipAmount) must be >= maxBumpTip
          if (unclaimedRewards - tipAmount < maxBumpTipValue) {
            // This tip amount doesn't leave enough for MAX_BUMP_TIP
            tipAmount += tipIncrement
            continue
          }
        }

        // Calculate score increase (could be negative)
        const scoreIncrease = newScore - currentScore
        
        // Calculate expected rewards from score increase
        // Convert score to rewards based on project-specific formula
        const rewardRatePerBlock = BigInt(CONFIG.REWARD_RATE_PER_BLOCK || '1000000000000000') // 0.001 ETH default
        const expectedBlocks = BigInt(CONFIG.EXPECTED_BLOCKS_BEFORE_NEXT_BUMP || '40320') // ~1 week at 15s blocks
        const expectedRewards = (scoreIncrease * rewardRatePerBlock * expectedBlocks) / BigInt(1e18)

        // Calculate total cost (tip + gas)
        const totalCost = tipAmount + gasCost

        // Check if profitable
        if (expectedRewards > totalCost) {
          if (expectedRewards - totalCost > bestScore) {
            bestScore = expectedRewards - totalCost
            bestTip = tipAmount
            profitable = true
          }
        }

        tipAmount += tipIncrement
      }

      if (!profitable) {
        return {
          profitable: false,
          reason: 'No profitable tip amount found',
        }
      }

      return {
        profitable: true,
        tipAmount: bestTip,
      }
    } catch (error) {
      logger.error('Error calculating bump profitability', {
        depositId: deposit.deposit_id,
        error: (error as Error).message,
      })
      return {
        profitable: false,
        reason: `Error: ${(error as Error).message}`,
      }
    }
  }

  /**
   * Start periodic checks for bump opportunities
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.lastUpdateTimestamp = Date.now();
    logger.info('Starting Rari Bump Earning Power Engine');
    
    // Start periodic checks for bump opportunities
    this.startPeriodicChecks();
    
    // Perform initial check for all deposits
    try {
      const deposits = await this.database.getAllDeposits();
      logger.info(`Initial check: Found ${deposits.length} deposits to check for bump opportunities`);
      
      if (deposits.length > 0) {
        await this.processDepositsBatch({ deposits });
      }
    } catch (error) {
      logger.error('Error during initial bump check', {
        error: (error as Error).message
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
    logger.info('Stopped Rari Bump Earning Power Engine');
  }
  
  /**
   * Start periodic checks for bump opportunities
   */
  private startPeriodicChecks(): void {
    if (this.periodicCheckInterval) return;
    
    this.periodicCheckInterval = setInterval(async () => {
      try {
        logger.info('Running periodic check for bump opportunities');
        
        // Get all deposits
        const deposits = await this.database.getAllDeposits();
        logger.info(`Periodic check: Found ${deposits.length} deposits to check for bump opportunities`);
        
        if (deposits.length > 0) {
          await this.processDepositsBatch({ deposits });
        }
      } catch (error) {
        logger.error('Error during periodic bump check', {
          error: (error as Error).message
        });
      }
    }, this.PERIODIC_CHECK_INTERVAL);
    
    logger.info('Started periodic checks for bump opportunities', {
      intervalMs: this.PERIODIC_CHECK_INTERVAL
    });
  }
  
  /**
   * Stop periodic checks
   */
  private stopPeriodicChecks(): void {
    if (!this.periodicCheckInterval) return;
    
    clearInterval(this.periodicCheckInterval);
    this.periodicCheckInterval = null;
    logger.info('Stopped periodic checks for bump opportunities');
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
      delegateeCount: 0 // Not tracking delegatees separately
    };
  }

  protected async updateTimestamp(): Promise<void> {
    this.lastUpdateTimestamp = Date.now();
  }
} 