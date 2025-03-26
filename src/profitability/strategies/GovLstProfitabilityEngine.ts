import { ethers } from 'ethers'
import { ConsoleLogger, Logger } from '@/monitor/logging'
import { IGovLstProfitabilityEngine } from '../interfaces/IProfitabilityEngine'
import { IPriceFeed } from '@/shared/price-feeds/interfaces'
import {
  GovLstDeposit,
  GovLstProfitabilityCheck,
  GovLstBatchAnalysis,
  GovLstDepositGroup,
  ProfitabilityConfig,
} from '../interfaces/types'
import {
  GAS_CONSTANTS,
  CONTRACT_CONSTANTS,
  EVENTS,
} from '../constants'
import {
  GasEstimationError,
  QueueProcessingError,
  ProfitabilityError,
} from '../errors'

export class GovLstProfitabilityEngine implements IGovLstProfitabilityEngine {
  private readonly logger: Logger
  private isRunning: boolean
  private lastGasPrice: bigint
  private lastUpdateTimestamp: number
  private readonly rewardTokenAddress: string
  private gasPriceCache: { price: bigint; timestamp: number } | null = null

  constructor(
    private readonly govLstContract: ethers.Contract & {
      sharesOf(account: string): Promise<bigint>
      payoutAmount(): Promise<bigint>
      claimAndDistributeReward(
        recipient: string,
        minExpectedReward: bigint,
        depositIds: bigint[],
      ): Promise<void>
    },
    private readonly provider: ethers.Provider,
    private readonly config: ProfitabilityConfig,
    private readonly priceFeed: IPriceFeed,
  ) {
    this.logger = new ConsoleLogger('info')
    this.isRunning = false
    this.lastGasPrice = BigInt(0)
    this.lastUpdateTimestamp = 0
    this.rewardTokenAddress = config.rewardTokenAddress
  }

  async start(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    this.logger.info(EVENTS.ENGINE_STARTED)
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return
    this.isRunning = false
    this.logger.info(EVENTS.ENGINE_STOPPED)
  }

  async getStatus(): Promise<{
    isRunning: boolean
    lastGasPrice: bigint
    lastUpdateTimestamp: number
    queueSize: number
    groupCount: number
  }> {
    return {
      isRunning: this.isRunning,
      lastGasPrice: this.lastGasPrice,
      lastUpdateTimestamp: this.lastUpdateTimestamp,
      queueSize: 0,
      groupCount: 0,
    }
  }

  /**
   * Checks if a group of deposits can be profitably claimed
   * @param deposits Array of deposits to check
   * @returns Profitability analysis for the deposit group
   * @throws Error if profitability check fails
   */
  async checkGroupProfitability(deposits: GovLstDeposit[]): Promise<GovLstProfitabilityCheck> {
    if (!deposits.length) return this.createUnprofitableCheck()

    try {
      const [totalShares, payoutAmount, gasEstimate] = await Promise.all([
        this.calculateTotalShares(deposits),
        this.govLstContract.payoutAmount(),
        this.estimateClaimGas(deposits.map(d => d.deposit_id)),
      ])

      if (totalShares <= CONTRACT_CONSTANTS.MIN_SHARES_THRESHOLD)
        return this.createUnprofitableCheck()

      const gasCost = gasEstimate * await this.getGasPriceWithBuffer()
      const gasCostInToken = await this.priceFeed.getTokenPriceInWei(
        this.rewardTokenAddress,
        gasCost,
      )

      const expectedProfit = totalShares > payoutAmount
        ? totalShares - payoutAmount - gasCostInToken
        : BigInt(0)

      return {
        is_profitable: expectedProfit >= this.config.minProfitMargin,
        constraints: {
          has_enough_shares: totalShares > payoutAmount,
          meets_min_reward: expectedProfit >= this.config.minProfitMargin,
          is_profitable: expectedProfit >= this.config.minProfitMargin,
        },
        estimates: {
          total_shares: totalShares,
          payout_amount: payoutAmount,
          gas_estimate: gasEstimate,
          expected_profit: expectedProfit,
        },
      }
    } catch (error) {
      throw new ProfitabilityError(
        'Failed to check group profitability',
        {
          depositCount: deposits.length,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        true
      )
    }
  }

  /**
   * Analyzes and groups deposits into profitable batches
   * @param deposits Array of deposits to analyze
   * @returns Analysis of deposit groups with profitability metrics
   */
  async analyzeAndGroupDeposits(deposits: GovLstDeposit[]): Promise<GovLstBatchAnalysis> {
    if (!deposits.length) return this.createEmptyBatchAnalysis()

    try {
      const sortedDeposits = this.sortDepositsByShares(deposits)
      const payoutAmount = await this.govLstContract.payoutAmount()
      const depositGroups = await this.createProfitableGroups(sortedDeposits, payoutAmount)

      return {
        deposit_groups: depositGroups,
        total_gas_estimate: this.calculateTotalGasEstimate(depositGroups),
        total_expected_profit: this.calculateTotalExpectedProfit(depositGroups),
        total_deposits: deposits.length,
      }
    } catch (error) {
      throw new QueueProcessingError(error as Error, {
        depositCount: deposits.length,
        operation: 'analyze_and_group',
      })
    }
  }

  async queueGroupForExecution(): Promise<boolean> {
    return false
  }

  private async getGasPriceWithBuffer(): Promise<bigint> {
    const now = Date.now()
    if (
      this.gasPriceCache &&
      now - this.gasPriceCache.timestamp < GAS_CONSTANTS.GAS_PRICE_UPDATE_INTERVAL
    ) {
      return this.gasPriceCache.price
    }

    try {
      const feeData = await this.provider.getFeeData()
      const gasPrice = feeData.gasPrice ?? BigInt(0)
      const buffer = BigInt(Math.floor(this.config.gasPriceBuffer))
      const bufferedGasPrice = gasPrice + (gasPrice * buffer) / BigInt(100)

      this.gasPriceCache = {
        price: bufferedGasPrice,
        timestamp: now,
      }
      this.lastGasPrice = bufferedGasPrice
      this.lastUpdateTimestamp = now

      return bufferedGasPrice
    } catch (error) {
      throw new GasEstimationError(error as Error, {
        lastGasPrice: this.lastGasPrice.toString(),
        lastUpdateTimestamp: this.lastUpdateTimestamp,
      })
    }
  }

  private async estimateClaimGas(depositIds: bigint[]): Promise<bigint> {
    try {
      const gasEstimate = await this.provider.estimateGas({
        to: this.govLstContract.target,
        data: this.govLstContract.interface.encodeFunctionData(
          'claimAndDistributeReward',
          [CONTRACT_CONSTANTS.ZERO_ADDRESS, BigInt(0), depositIds],
        ),
      })
      return gasEstimate
    } catch (error) {
      throw new GasEstimationError(error as Error, {
        depositIds: depositIds.map(id => id.toString()),
        operation: 'estimate_claim_gas',
      })
    }
  }

  private async calculateTotalShares(deposits: GovLstDeposit[]): Promise<bigint> {
    return deposits.reduce((sum, deposit) => sum + deposit.shares_of, BigInt(0))
  }

  private sortDepositsByShares(deposits: GovLstDeposit[]): GovLstDeposit[] {
    return [...deposits].sort((a, b) => Number(b.shares_of - a.shares_of))
  }

  private async createProfitableGroups(
    deposits: GovLstDeposit[],
    payoutAmount: bigint,
  ): Promise<GovLstDepositGroup[]> {
    const groups: GovLstDepositGroup[] = []
    let currentGroup: GovLstDeposit[] = []
    let currentTotalShares = BigInt(0)

    try {
      for (const deposit of deposits) {
        currentGroup.push(deposit)
        currentTotalShares += deposit.shares_of

        if (currentTotalShares > payoutAmount) {
          const profitability = await this.checkGroupProfitability(currentGroup)
          if (profitability.is_profitable) {
            groups.push({
              deposit_ids: currentGroup.map(d => d.deposit_id),
              total_shares: profitability.estimates.total_shares,
              total_payout: profitability.estimates.payout_amount,
              expected_profit: profitability.estimates.expected_profit,
              gas_estimate: profitability.estimates.gas_estimate,
            })
          }
          currentGroup = []
          currentTotalShares = BigInt(0)
        }
      }

      return groups
    } catch (error) {
      throw new QueueProcessingError(error as Error, {
        depositCount: deposits.length,
        currentGroupSize: currentGroup.length,
        operation: 'create_profitable_groups',
      })
    }
  }

  private calculateTotalGasEstimate(groups: GovLstDepositGroup[]): bigint {
    return groups.reduce((sum, group) => sum + group.gas_estimate, BigInt(0))
  }

  private calculateTotalExpectedProfit(groups: GovLstDepositGroup[]): bigint {
    return groups.reduce((sum, group) => sum + group.expected_profit, BigInt(0))
  }

  private createUnprofitableCheck(): GovLstProfitabilityCheck {
    return {
      is_profitable: false,
      constraints: {
        has_enough_shares: false,
        meets_min_reward: false,
        is_profitable: false,
      },
      estimates: {
        total_shares: BigInt(0),
        payout_amount: BigInt(0),
        gas_estimate: BigInt(0),
        expected_profit: BigInt(0),
      },
    }
  }

  private createEmptyBatchAnalysis(): GovLstBatchAnalysis {
    return {
      deposit_groups: [],
      total_gas_estimate: BigInt(0),
      total_expected_profit: BigInt(0),
      total_deposits: 0,
    }
  }
}
