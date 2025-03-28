import { ethers } from 'ethers'
import { ConsoleLogger, Logger } from '@/monitor/logging'
import { IGovLstProfitabilityEngine } from './interfaces/IProfitabilityEngine'
import { GovLstProfitabilityEngine } from './strategies/GovLstProfitabilityEngine'
import {
  GovLstDeposit,
  GovLstProfitabilityCheck,
  GovLstBatchAnalysis,
  ProfitabilityConfig,
} from './interfaces/types'
import { IPriceFeed } from '@/shared/price-feeds/interfaces'
import { QUEUE_CONSTANTS, EVENTS } from './constants'
import {
  DepositNotFoundError,
  InvalidDepositDataError,
  QueueProcessingError,
} from './errors'
import { TransactionQueueStatus } from '@/database/interfaces/types'
import { IExecutor } from '@/executor/interfaces/IExecutor'
import { DatabaseWrapper } from '@/database'
import { ProcessingQueueStatus } from '@/database/interfaces/types'

interface DatabaseDeposit {
  deposit_id: string
  owner_address: string
  depositor_address: string
  delegatee_address: string | null
  amount: string
  created_at?: string
  updated_at?: string
}

interface DepositCache {
  deposit: GovLstDeposit
  timestamp: number
}

interface ProfitableTransaction {
  deposit_id: bigint
  unclaimed_rewards: bigint
  expected_profit: bigint
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
  private profitableTransactions: ProfitableTransaction[] = []

  constructor(
    private readonly db: DatabaseWrapper,
    govLstContract: ethers.Contract,
    stakerContract: ethers.Contract,
    provider: ethers.Provider,
    private readonly logger: Logger,
    priceFeed: IPriceFeed,
    config: ProfitabilityConfig,
    private readonly executor: IExecutor,
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

  private serializeProfitabilityCheck(check: GovLstProfitabilityCheck): string {
    return JSON.stringify(check, (_, value) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      return value;
    });
  }

  async checkGroupProfitability(deposits: GovLstDeposit[]): Promise<GovLstProfitabilityCheck> {
    const depositIds = deposits.map(d => BigInt(d.deposit_id));
    const profitabilityCheck = await this.engine.checkGroupProfitability(deposits);
    const serializedCheck = this.serializeProfitabilityCheck(profitabilityCheck);

    if (profitabilityCheck.is_profitable && this.executor && this.db) {
      try {
        // Create transaction queue items in database first
        for (const deposit of deposits) {
          const txData = JSON.stringify({
            depositIds,
            profitability: serializedCheck
          });

          await this.db.createTransactionQueueItem({
            deposit_id: deposit.deposit_id.toString(),
            status: TransactionQueueStatus.PENDING,
            tx_data: txData
          });
        }

        // Then queue the transaction in the executor
        await this.executor.queueTransaction(
          depositIds,
          profitabilityCheck,
          JSON.stringify(serializedCheck)
        );
      } catch (error) {
        this.logger.error('Failed to queue profitable transaction', {
          error: error instanceof Error ? error.message : String(error),
          depositIds: deposits.map(d => d.deposit_id.toString()),
          profitability: serializedCheck
        });
        throw error;
      }
    }

    return profitabilityCheck;
  }

  async getProfitableTransactions(): Promise<ProfitableTransaction[]> {
    return this.profitableTransactions
  }

  async clearProfitableTransactions(): Promise<void> {
    this.profitableTransactions = []
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

    // Log profitable transactions before stopping
    if (this.profitableTransactions.length > 0) {
      this.logger.info('Profitable transactions found:', {
        transactions: this.profitableTransactions.map(tx => ({
          deposit_id: tx.deposit_id.toString(),
          unclaimed_rewards: ethers.formatEther(tx.unclaimed_rewards),
          expected_profit: ethers.formatEther(tx.expected_profit)
        }))
      })
    }

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
      throw new InvalidDepositDataError(deposit);
    }

    return {
      deposit_id: BigInt(deposit.deposit_id),
      owner_address: deposit.owner_address,
      depositor_address: deposit.depositor_address,
      delegatee_address: deposit.delegatee_address,
      amount: BigInt(deposit.amount),
      shares_of: BigInt(deposit.amount),
      payout_amount: BigInt(0),
      rewards: BigInt(0),
      created_at: deposit.created_at,
      updated_at: deposit.updated_at
    };
  }
}
