import { ethers } from 'ethers'
import { ConsoleLogger, Logger } from '@/monitor/logging'
import { IProfitabilityEngine } from '../interfaces/IProfitabilityEngine'
import { IExecutor } from '../../executor/interfaces/IExecutor'
import { IDatabase } from '../../database/interfaces/IDatabase'
import { BaseProfitabilityEngine } from './BaseProfitabilityEngine'
import { Deposit, ProcessingQueueItem } from '../../database/interfaces/types'
import { ProfitabilityQueueBatchResult, ProfitabilityQueueResult } from '../interfaces/types'
import { CONFIG } from '../../configuration'
import { IPriceFeed } from '../../shared/price-feeds/interfaces'
import { ProfitabilityConfig } from '../interfaces/types'
import { BinaryEligibilityOracleEarningPowerCalculator } from '@/calculator'

export class RariClaimDistributeEngine extends BaseProfitabilityEngine implements IProfitabilityEngine {
  private readonly lstToken: ethers.Contract & {
    getUnclaimedRewards(): Promise<bigint>
  }
  protected readonly database: IDatabase
  protected readonly executor: IExecutor
  protected readonly stakerContract: ethers.Contract & {
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

  constructor({
    database,
    executor,
    calculator,
    stakerContract,
    provider,
    config,
    priceFeed,
  }: {
    database: IDatabase
    executor: IExecutor
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
  }) {
    super(calculator, stakerContract, provider, config, priceFeed)
    this.database = database
    this.executor = executor
    this.stakerContract = stakerContract

    // Initialize LST contract
    this.lstToken = new ethers.Contract(
      CONFIG.LST_ADDRESS,
      CONFIG.LST_ABI,
      provider
    ) as ethers.Contract & {
      getUnclaimedRewards(): Promise<bigint>
    }
  }

  async processItem({ item }: { item: ProcessingQueueItem }): Promise<ProfitabilityQueueResult> {
    try {
      const deposit = await this.database.getDeposit(item.deposit_id)

      if (!deposit) {
        throw new Error(`Deposit ${item.deposit_id} not found`)
      }

      this.logger.info('Processing claim and distribute for deposit', {
        depositId: deposit.deposit_id,
        ownerAddress: deposit.owner_address,
      })

      const isClaimProfitable = await this.isClaimProfitable()

      if (!isClaimProfitable.profitable) {
        this.logger.info('Claim not profitable', {
          reason: isClaimProfitable.reason,
        })
        return {
          success: true,
          result: 'not_profitable',
          details: { reason: isClaimProfitable.reason },
        }
      }

      // Queue the transaction
      const tx = {
        to: CONFIG.LST_ADDRESS,
        data: this.lstToken.interface.encodeFunctionData('claimAndDistributeReward', []),
        gasLimit: CONFIG.CLAIM_GAS_LIMIT || '500000',
      }

      this.logger.info('Queueing claim and distribute transaction', {
        to: tx.to,
        rewardAmount: isClaimProfitable.rewardAmount,
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
            payout_amount: isClaimProfitable.rewardAmount!,
            gas_estimate: BigInt(CONFIG.CLAIM_GAS_LIMIT || '500000'),
            gas_cost: BigInt(CONFIG.CLAIM_GAS_LIMIT || '500000'),
            expected_profit: isClaimProfitable.rewardAmount!
          },
          deposit_details: [{
            depositId: BigInt(deposit.deposit_id),
            rewards: isClaimProfitable.rewardAmount!
          }]
        },
        tx.data
      )

      return {
        success: true,
        result: 'queued',
        details: {
          rewardAmount: isClaimProfitable.rewardAmount!.toString(),
        },
      }
    } catch (error) {
      this.logger.error('Error processing claim and distribute', {
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
    this.logger.info(`Processing claim and distribute for ${deposits.length} deposits`)
    
    // For claim and distribute, we only need to check profitability once
    // as it's a global operation, not per-deposit
    const isClaimProfitable = await this.isClaimProfitable()
    
    if (!isClaimProfitable.profitable) {
      return {
        success: true,
        total: deposits.length,
        queued: 0,
        notProfitable: deposits.length,
        errors: 0,
        details: deposits.map(deposit => ({
          depositId: deposit.deposit_id,
          result: 'not_profitable',
          details: { reason: isClaimProfitable.reason },
        })),
      }
    }

    // If profitable, queue one transaction
    const tx = {
      to: CONFIG.LST_ADDRESS,
      data: this.lstToken.interface.encodeFunctionData('claimAndDistributeReward', []),
      gasLimit: CONFIG.CLAIM_GAS_LIMIT || '500000',
    }

    try {
      await this.executor.queueTransaction(
        deposits.map(d => BigInt(d.deposit_id)),
        {
          is_profitable: true,
          constraints: {
            has_enough_shares: true,
            meets_min_reward: true,
            meets_min_profit: true
          },
          estimates: {
            total_shares: deposits.reduce((sum, d) => sum + BigInt(d.amount), 0n),
            payout_amount: isClaimProfitable.rewardAmount!,
            gas_estimate: BigInt(CONFIG.CLAIM_GAS_LIMIT || '500000'),
            gas_cost: BigInt(CONFIG.CLAIM_GAS_LIMIT || '500000'),
            expected_profit: isClaimProfitable.rewardAmount!
          },
          deposit_details: deposits.map(d => ({
            depositId: BigInt(d.deposit_id),
            rewards: isClaimProfitable.rewardAmount!
          }))
        },
        tx.data
      )

      return {
        success: true,
        total: deposits.length,
        queued: 1, // Only one transaction regardless of deposit count
        notProfitable: 0,
        errors: 0,
        details: [{
          depositId: 'global', // Not tied to a specific deposit
          result: 'queued',
          details: { 
            rewardAmount: isClaimProfitable.rewardAmount!.toString(),
          },
        }],
      }
    } catch (error) {
      this.logger.error('Error queueing claim and distribute transaction', {
        error: (error as Error).message,
      })
      return {
        success: false,
        total: deposits.length,
        queued: 0,
        notProfitable: 0,
        errors: deposits.length,
        details: [{
          depositId: 'global',
          result: 'error',
          details: { error: (error as Error).message },
        }],
      }
    }
  }

  private async isClaimProfitable(): Promise<{
    profitable: boolean
    reason?: string
    rewardAmount?: bigint
  }> {
    try {
      // Get unclaimed rewards amount
      const unclaimedRewards = await this.getUnclaimedRewards()
      
      if (unclaimedRewards === 0n) {
        return {
          profitable: false,
          reason: 'No unclaimed rewards',
        }
      }

      // Get current gas price
      const feeData = await this.provider.getFeeData()
      if (!feeData.gasPrice) {
        throw new Error('Failed to get gas price')
      }
      const gasPriceBigInt = BigInt(feeData.gasPrice.toString())
      
      // Estimate gas cost for claim transaction
      const gasLimit = BigInt(CONFIG.CLAIM_GAS_LIMIT || '500000')
      const gasCost = gasPriceBigInt * gasLimit

      // Get token prices for profitability calculation
      const tokenPrice = await this.priceFeed.getTokenPrice(CONFIG.LST_ADDRESS)
      if (!tokenPrice) {
        return {
          profitable: false,
          reason: 'Could not get price data',
        }
      }

      // Convert gas cost to token equivalent for comparison
      const gasCostInToken = await this.priceFeed.getTokenPriceInWei(
        CONFIG.LST_ADDRESS,
        gasCost
      )

      // Check if profitable
      const profit = unclaimedRewards - gasCostInToken

      const profitThreshold = BigInt(CONFIG.CLAIM_PROFIT_THRESHOLD || '0')
      
      if (profit <= profitThreshold) {
        return {
          profitable: false,
          reason: `Profit ${profit.toString()} below threshold ${profitThreshold.toString()}`,
          rewardAmount: unclaimedRewards,
        }
      }

      return {
        profitable: true,
        rewardAmount: unclaimedRewards,
      }
    } catch (error) {
      this.logger.error('Error calculating claim profitability', {
        error: (error as Error).message,
      })
      return {
        profitable: false,
        reason: `Error: ${(error as Error).message}`,
      }
    }
  }

  private async getUnclaimedRewards(): Promise<bigint> {
    try {
      // Check for a view function on the LST contract that shows unclaimed rewards
      const unclaimedRewards = await this.lstToken.getUnclaimedRewards()
      return BigInt(unclaimedRewards.toString())
    } catch (error) {
      this.logger.error('Error getting unclaimed rewards', {
        error: (error as Error).message,
      })
      return 0n
    }
  }
} 