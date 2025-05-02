import { IProfitabilityEngine } from '../interfaces/IProfitabilityEngine'
import { IExecutor } from '../../executor/interfaces/IExecutor'
import { IDatabase } from '../../database/interfaces/IDatabase'
import { BaseProfitabilityEngine } from './BaseProfitabilityEngine'
import { Deposit, ProcessingQueueItem } from '../../database/interfaces/types'
import { ProfitabilityQueueBatchResult, ProfitabilityQueueResult } from '../interfaces/types'
import { CONFIG } from '../../configuration'
import Web3 from 'web3'
import { GasCostEstimator } from '../../prices/GasCostEstimator'
import { CoinmarketcapFeed } from '../../prices/CoinmarketcapFeed'
import { Contract } from 'web3-eth-contract'

export class RariClaimDistributeEngine extends BaseProfitabilityEngine implements IProfitabilityEngine {
  private web3: Web3
  private lstToken: Contract
  private stakerContract: Contract
  private gasCostEstimator: GasCostEstimator
  private priceFeed: CoinmarketcapFeed
  private logger: any

  constructor({
    database,
    executor,
    web3,
    priceFeed,
    logger,
  }: {
    database: IDatabase
    executor: IExecutor
    web3: Web3
    priceFeed: CoinmarketcapFeed
    logger: any
  }) {
    super({ database, executor })
    this.web3 = web3
    this.priceFeed = priceFeed
    this.logger = logger
    this.gasCostEstimator = new GasCostEstimator({ web3: this.web3 })

    // Initialize contracts
    this.lstToken = new this.web3.eth.Contract(
      JSON.parse(CONFIG.LST_ABI),
      CONFIG.LST_ADDRESS
    )

    this.stakerContract = new this.web3.eth.Contract(
      JSON.parse(CONFIG.STAKER_CONTRACT_ABI),
      CONFIG.STAKER_CONTRACT_ADDRESS
    )
  }

  async processItem({ item }: { item: ProcessingQueueItem }): Promise<ProfitabilityQueueResult> {
    try {
      const deposit = await this.database.getDeposit({
        depositId: item.depositId,
      })

      if (!deposit) {
        throw new Error(`Deposit ${item.depositId} not found`)
      }

      this.logger.info('Processing claim and distribute for deposit', {
        depositId: deposit.depositId,
        ownerAddress: deposit.ownerAddress,
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
        data: this.web3.eth.abi.encodeFunctionCall(
          {
            name: 'claimAndDistributeReward',
            type: 'function',
            inputs: [],
          },
          []
        ),
        gasLimit: CONFIG.CLAIM_GAS_LIMIT || '500000',
      }

      this.logger.info('Queueing claim and distribute transaction', {
        to: tx.to,
        rewardAmount: isClaimProfitable.rewardAmount,
      })

      await this.executor.queueTransaction({
        tx,
        metadata: {
          type: 'claim_and_distribute',
          rewardAmount: isClaimProfitable.rewardAmount!.toString(),
        },
      })

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
        depositId: item.depositId,
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
          depositId: deposit.depositId,
          result: 'not_profitable',
          details: { reason: isClaimProfitable.reason },
        })),
      }
    }

    // If profitable, queue one transaction
    const tx = {
      to: CONFIG.LST_ADDRESS,
      data: this.web3.eth.abi.encodeFunctionCall(
        {
          name: 'claimAndDistributeReward',
          type: 'function',
          inputs: [],
        },
        []
      ),
      gasLimit: CONFIG.CLAIM_GAS_LIMIT || '500000',
    }

    try {
      await this.executor.queueTransaction({
        tx,
        metadata: {
          type: 'claim_and_distribute',
          rewardAmount: isClaimProfitable.rewardAmount!.toString(),
        },
      })

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
      const gasPrice = await this.web3.eth.getGasPrice()
      const gasPriceBigInt = BigInt(gasPrice)
      
      // Estimate gas cost for claim transaction
      const gasLimit = BigInt(CONFIG.CLAIM_GAS_LIMIT || '500000')
      const gasCost = gasPriceBigInt * gasLimit

      // Get token prices for profitability calculation
      const ethUsdPrice = await this.priceFeed.getEthPrice()
      const tokenUsdPrice = await this.priceFeed.getTokenPrice({
        tokenAddress: CONFIG.LST_ADDRESS,
      })

      if (!ethUsdPrice || !tokenUsdPrice) {
        return {
          profitable: false,
          reason: 'Could not get price data',
        }
      }

      // Convert gas cost to token equivalent for comparison
      const ethValueInUsd = Number(gasCost) * ethUsdPrice / 1e18
      const gasCostInToken = BigInt(Math.ceil(ethValueInUsd / tokenUsdPrice * 1e18))

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
      // This will vary based on the specific contract implementation
      const unclaimedRewards = await this.lstToken.methods.getUnclaimedRewards().call()
      return BigInt(unclaimedRewards)
    } catch (error) {
      this.logger.error('Error getting unclaimed rewards', {
        error: (error as Error).message,
      })
      return 0n
    }
  }
} 