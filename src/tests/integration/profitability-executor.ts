import { ethers } from 'ethers'
import { DatabaseWrapper } from '@/database'
import { ConsoleLogger, Logger } from '@/monitor/logging'
import { GovLstProfitabilityEngineWrapper } from '@/profitability/ProfitabilityEngineWrapper'
import { ExecutorWrapper, ExecutorType } from '@/executor/ExecutorWrapper'
import { CONFIG } from '@/config'
import { CoinMarketCapFeed } from '@/shared/price-feeds/coinmarketcap/CoinMarketCapFeed'
import path from 'path'
import fs from 'fs'

// Create logger instance
const logger: Logger = new ConsoleLogger('info')

interface DatabaseDeposit {
  deposit_id: string
  owner_address: string
  depositor_address: string
  delegatee_address?: string
  amount: string
  created_at: string
  updated_at: string
}

interface DatabaseContent {
  deposits: Record<string, DatabaseDeposit>
  checkpoints: Record<string, any>
  processing_queue: Record<string, any>
  transaction_queue: Record<string, any>
  govlst_deposits: Record<string, any>
  govlst_claim_history: Record<string, any>
}

async function main() {
  logger.info('Starting profitability-executor integration test...')

  // Initialize database with staker-monitor-db.json
  const dbPath = path.join(process.cwd(), 'staker-monitor-db.json')
  logger.info(`Using database at ${dbPath}`)
  const database = new DatabaseWrapper({
    type: 'json',
    jsonDbPath: 'staker-monitor-db.json'
  })

  // Initialize provider
  logger.info('Initializing provider...')
  const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl)
  const network = await provider.getNetwork()
  logger.info('Connected to network:', {
    chainId: network.chainId,
    name: network.name
  })

  // Initialize GovLst contract
  logger.info('Initializing GovLst contract...')
  const govLstAddress = CONFIG.profitability.rewardTokenAddress
  const govLstAbi = JSON.parse(
    fs.readFileSync('./src/tests/abis/govlst.json', 'utf-8')
  )
  const govLstContract = new ethers.Contract(
    govLstAddress!,
    govLstAbi,
    provider
  )
  logger.info('GovLst contract initialized at:', { address: govLstAddress })

  // Initialize price feed
  const priceFeed = new CoinMarketCapFeed(
    {
      apiKey: CONFIG.priceFeed.coinmarketcap.apiKey,
      baseUrl: CONFIG.priceFeed.coinmarketcap.baseUrl,
      timeout: CONFIG.priceFeed.coinmarketcap.timeout
    },
    logger
  )

  // Initialize profitability engine
  logger.info('Initializing profitability engine...')
  const profitabilityEngine = new GovLstProfitabilityEngineWrapper(
    database,
    govLstContract,
    provider,
    logger,
    priceFeed,
    {
      minProfitMargin: ethers.parseEther('0.01'), // 0.01 ETH min profit
      maxBatchSize: 10,
      rewardTokenAddress: CONFIG.profitability.rewardTokenAddress,
      defaultTipReceiver: CONFIG.executor.tipReceiver || ethers.ZeroAddress,
      gasPriceBuffer: 20, // 20% buffer for gas price fluctuations
      priceFeed: {
        cacheDuration: 10 * 60 * 1000 // 10 minutes
      }
    }
  )

  // Initialize executor
  logger.info('Initializing executor...')
  const executor = new ExecutorWrapper(
    govLstContract,
    provider,
    ExecutorType.WALLET,
    {
      wallet: {
        privateKey: CONFIG.executor.privateKey,
        minBalance: ethers.parseEther('0.1'),
        maxPendingTransactions: 5
      },
      maxQueueSize: 10,
      minConfirmations: 1,
      maxRetries: 2,
      retryDelayMs: 2000,
      transferOutThreshold: ethers.parseEther('0.5'),
      gasBoostPercentage: 5,
      concurrentTransactions: 2
    }
  )

  try {
    // Start components
    await profitabilityEngine.start()
    logger.info('Profitability engine started')

    await executor.start()
    logger.info('Executor started')

    // Read deposits directly from staker-monitor-db.json
    const dbContent = JSON.parse(fs.readFileSync(dbPath, 'utf-8')) as DatabaseContent
    const deposits = Object.values(dbContent.deposits)
    logger.info(`Found ${deposits.length} deposits to analyze`)

    // Process deposits
    for (const deposit of deposits) {
      try {
        logger.info(`Processing deposit ${deposit.deposit_id}`, {
          owner: deposit.owner_address,
          delegatee: deposit.delegatee_address,
          amount: deposit.amount
        })

        // Check profitability
        const profitability = await profitabilityEngine.checkGroupProfitability([{
          deposit_id: BigInt(deposit.deposit_id),
          owner_address: deposit.owner_address,
          delegatee_address: deposit.delegatee_address || '',
          amount: BigInt(deposit.amount),
          shares_of: BigInt(0), // Will be fetched by the engine
          payout_amount: BigInt(0) // Will be fetched by the engine
        }])

        if (profitability.is_profitable) {
          logger.info(`Deposit ${deposit.deposit_id} is profitable:`, {
            expectedProfit: profitability.estimates.expected_profit.toString(),
            gasEstimate: profitability.estimates.gas_estimate.toString()
          })

          // Queue transaction
          const tx = await executor.queueTransaction(
            [BigInt(deposit.deposit_id)],
            profitability
          )

          logger.info(`Transaction queued:`, {
            id: tx.id,
            status: tx.status
          })
        } else {
          logger.info(`Deposit ${deposit.deposit_id} is not profitable:`, {
            constraints: profitability.constraints
          })
        }
      } catch (error) {
        logger.error(`Error processing deposit ${deposit.deposit_id}:`, {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    // Wait for transactions to process
    logger.info('Waiting for transactions to complete...')
    await new Promise(resolve => setTimeout(resolve, 30000))

    // Get final stats
    const stats = await executor.getQueueStats()
    logger.info('Final queue stats:', {
      totalConfirmed: stats.totalConfirmed,
      totalFailed: stats.totalFailed,
      totalPending: stats.totalPending,
      totalQueued: stats.totalQueued,
      averageGasPrice: stats.averageGasPrice.toString(),
      totalProfits: stats.totalProfits.toString()
    })

  } catch (error) {
    logger.error('Error during test:', {
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  } finally {
    // Stop components
    await profitabilityEngine.stop()
    logger.info('Profitability engine stopped')

    await executor.stop()
    logger.info('Executor stopped')
  }
}

// Run the test
main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Fatal error:', {
      error: error instanceof Error ? error.message : String(error)
    })
    process.exit(1)
  })
