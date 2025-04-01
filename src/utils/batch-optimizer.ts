import { PRODUCTION_CONFIG } from "@/config"
import { ConsoleLogger } from '@/monitor/logging'

interface Deposit {
  depositId: string
  delegatee: string
  amount: bigint
  estimatedGas: bigint
}

interface BatchGroup {
  deposits: Deposit[]
  totalGas: bigint
  totalAmount: bigint
}

export class BatchOptimizer {
  private readonly logger: ConsoleLogger

  constructor() {
    this.logger = new ConsoleLogger('info', {
      color: '\x1b[36m', // Cyan
      prefix: '[BatchOptimizer]'
    })
  }

  public createOptimalBatches(deposits: Deposit[]): BatchGroup[] {
    if (!deposits.length) return []

    // Sort deposits by gas efficiency (amount/gas)
    const sortedDeposits = [...deposits].sort((a, b) => {
      const efficiencyA = Number(a.amount) / Number(a.estimatedGas)
      const efficiencyB = Number(b.amount) / Number(b.estimatedGas)
      return efficiencyB - efficiencyA
    })

    const batches: BatchGroup[] = []
    let currentBatch: BatchGroup = {
      deposits: [],
      totalGas: 0n,
      totalAmount: 0n
    }

    for (const deposit of sortedDeposits) {
      // Check if adding this deposit would exceed batch size
      if (currentBatch.deposits.length >= PRODUCTION_CONFIG.profitability.maxBatchSize) {
        if (currentBatch.deposits.length > 0) {
          batches.push(currentBatch)
          currentBatch = {
            deposits: [],
            totalGas: 0n,
            totalAmount: 0n
          }
        }
      }

      // Add deposit to current batch
      currentBatch.deposits.push(deposit)
      currentBatch.totalGas += deposit.estimatedGas
      currentBatch.totalAmount += deposit.amount
    }

    // Add the last batch if it has deposits
    if (currentBatch.deposits.length > 0) {
      batches.push(currentBatch)
    }

    this.logger.info('Created optimal batches', {
      totalBatches: batches.length,
      totalDeposits: deposits.length,
      averageBatchSize: deposits.length / batches.length
    })

    return batches
  }

  public optimizeByDelegatee(deposits: Deposit[]): BatchGroup[] {
    // Group deposits by delegatee
    const delegateeGroups = deposits.reduce((groups, deposit) => {
      const group = groups.get(deposit.delegatee) || []
      group.push(deposit)
      groups.set(deposit.delegatee, group)
      return groups
    }, new Map<string, Deposit[]>())

    const batches: BatchGroup[] = []

    // Process each delegatee group
    for (const [delegatee, delegateeDeposits] of delegateeGroups) {
      const delegateeBatches = this.createOptimalBatches(delegateeDeposits)
      batches.push(...delegateeBatches)

      this.logger.info('Processed delegatee batch', {
        delegatee,
        batchCount: delegateeBatches.length,
        depositCount: delegateeDeposits.length
      })
    }

    return batches
  }

  public estimateBatchGasUsage(batch: BatchGroup): bigint {
    // Base gas cost for the transaction
    const BASE_GAS = 21000n

    // Gas per deposit operation (this should be calibrated based on actual contract)
    const GAS_PER_DEPOSIT = 50000n

    // Calculate total gas including overhead
    const totalGas = BASE_GAS + (GAS_PER_DEPOSIT * BigInt(batch.deposits.length))

    // Add buffer for safety
    return totalGas * BigInt(Math.floor(PRODUCTION_CONFIG.executor.gasLimitBuffer * 100)) / 100n
  }
}
