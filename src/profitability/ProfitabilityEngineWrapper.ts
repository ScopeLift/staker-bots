import { ethers } from 'ethers'
import { IDatabase } from '@/database'
import { IGovLstProfitabilityEngine } from './interfaces/IProfitabilityEngine'
import { GovLstProfitabilityEngine } from './strategies/GovLstProfitabilityEngine'
import {
  GovLstDeposit,
  GovLstProfitabilityCheck,
  GovLstBatchAnalysis,
  ProfitabilityConfig,
} from './interfaces/types'
import { Logger } from '@/monitor/logging'
import { ProcessingQueueStatus, Deposit as DatabaseDeposit } from '@/database/interfaces/types'
import { IPriceFeed } from '@/shared/price-feeds/interfaces'
import { QUEUE_CONSTANTS, EVENTS } from './constants'
import {
  DepositNotFoundError,
  InvalidDepositDataError,
  QueueProcessingError,
} from './errors'

interface DepositCache {
  deposit: GovLstDeposit
  timestamp: number
}

/**
 * Wrapper for the GovLst profitability engine that handles caching and analysis
 */
export class GovLstProfitabilityEngineWrapper implements IGovLstProfitabilityEngine {
  private readonly engine: IGovLstProfitabilityEngine
  private readonly processingQueue: Set<string> = new Set()
  private readonly depositCache: Map<string, DepositCache> = new Map()
  private queueProcessorInterval: NodeJS.Timeout | null = null
  private isRunning = false
  private static readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  constructor(
    private readonly db: IDatabase,
    govLstContract: ethers.Contract,
    stakerContract: ethers.Contract,
    provider: ethers.Provider,
    private readonly logger: Logger,
    priceFeed: IPriceFeed,
    config: ProfitabilityConfig,
  ) {
    this.engine = new GovLstProfitabilityEngine(
      govLstContract as ethers.Contract & {
        payoutAmount(): Promise<bigint>
        claimAndDistributeReward(
          recipient: string,
          minExpectedReward: bigint,
          depositIds: bigint[],
        ): Promise<void>
        balanceOf(account: string): Promise<bigint>
        balanceCheckpoint(account: string): Promise<bigint>
        depositIdForHolder(account: string): Promise<bigint>
        earningPowerOf(depositId: bigint): Promise<bigint>
        minQualifyingEarningPowerBips(): Promise<bigint>
      },
      stakerContract as ethers.Contract & {
        balanceOf(account: string): Promise<bigint>
        deposits(depositId: bigint): Promise<[string, bigint, bigint, string, string]>
        unclaimedReward(depositId: bigint): Promise<bigint>
      },
      provider,
      config,
      priceFeed
    )
  }

  async start(): Promise<void> {
    if (this.isRunning) return

    await this.engine.start()
    this.isRunning = true
    this.startQueueProcessor()
    await this.requeuePendingItems()
    this.logger.info(EVENTS.ENGINE_STARTED)
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return

    await this.engine.stop()
    this.isRunning = false
    this.stopQueueProcessor()
    this.logger.info(EVENTS.ENGINE_STOPPED)
  }

  async getStatus(): Promise<{
    isRunning: boolean
    lastGasPrice: bigint
    lastUpdateTimestamp: number
    queueSize: number
    groupCount: number
  }> {
    const baseStatus = await this.engine.getStatus()
    return {
      ...baseStatus,
      queueSize: this.processingQueue.size,
      groupCount: 0,
    }
  }

  async checkGroupProfitability(deposits: GovLstDeposit[]): Promise<GovLstProfitabilityCheck> {
    return this.engine.checkGroupProfitability(deposits)
  }

  async analyzeAndGroupDeposits(deposits: GovLstDeposit[]): Promise<GovLstBatchAnalysis> {
    return this.engine.analyzeAndGroupDeposits(deposits)
  }

  private startQueueProcessor(): void {
    if (this.queueProcessorInterval) return
    this.queueProcessorInterval = setInterval(
      () => this.processQueue(),
      QUEUE_CONSTANTS.PROCESSOR_INTERVAL,
    )
  }

  private stopQueueProcessor(): void {
    if (!this.queueProcessorInterval) return
    clearInterval(this.queueProcessorInterval)
    this.queueProcessorInterval = null
  }

  private async requeuePendingItems(): Promise<void> {
    try {
      const pendingItems = await this.db.getProcessingQueueItemsByStatus(
        ProcessingQueueStatus.PENDING,
      )

      for (const item of pendingItems) {
        if (item.deposit_id) this.processingQueue.add(item.deposit_id)
      }

      this.logger.info(EVENTS.ITEMS_REQUEUED, { count: pendingItems.length })
    } catch (error) {
      throw new QueueProcessingError(error as Error, { operation: 'requeue' })
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processingQueue.size === 0) return

    try {
      const deposits = await this.getDepositsWithCache(
        Array.from(this.processingQueue).map(id => BigInt(id)),
      )

      const analysis = await this.analyzeAndGroupDeposits(deposits)

      this.logger.info(EVENTS.QUEUE_PROCESSED, {
        totalGroups: analysis.deposit_groups.length,
        totalProfit: analysis.total_expected_profit.toString(),
      })
    } catch (error) {
      throw new QueueProcessingError(error as Error, {
        queueSize: this.processingQueue.size,
      })
    }
  }

  private async getDepositsWithCache(depositIds: bigint[]): Promise<GovLstDeposit[]> {
    const now = Date.now()
    const deposits: GovLstDeposit[] = []

    for (const id of depositIds) {
      const idStr = id.toString()
      const cached = this.depositCache.get(idStr)

      if (cached && now - cached.timestamp < GovLstProfitabilityEngineWrapper.CACHE_TTL) {
        deposits.push(cached.deposit)
        continue
      }

      const deposit = await this.db.getDeposit(idStr)
      if (!deposit) throw new DepositNotFoundError(idStr)

      const govLstDeposit = this.convertToGovLstDeposit(deposit)
      this.depositCache.set(idStr, {
        deposit: govLstDeposit,
        timestamp: now,
      })
      deposits.push(govLstDeposit)
    }

    return deposits
  }

  private convertToGovLstDeposit(deposit: DatabaseDeposit): GovLstDeposit {
    if (!deposit.deposit_id || !deposit.owner_address || !deposit.amount) {
      throw new InvalidDepositDataError(deposit)
    }

    return {
      deposit_id: BigInt(deposit.deposit_id),
      owner_address: deposit.owner_address,
      depositor_address: deposit.depositor_address!,
      delegatee_address: deposit.delegatee_address!,
      amount: BigInt(deposit.amount),
      shares_of: BigInt(0),
      payout_amount: BigInt(0),
    }
  }
}
