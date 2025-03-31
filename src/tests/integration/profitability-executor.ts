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
  const govLstAddress = CONFIG.govlst.addresses[0] // Use first address from config
  if (!govLstAddress) {
    throw new Error('No GovLst contract address configured')
  }
  const govLstAbi = JSON.parse(
    fs.readFileSync('./src/tests/abis/govlst.json', 'utf-8')
  )
  const stakerAbi = JSON.parse(
    fs.readFileSync('./src/tests/abis/staker.json', 'utf-8')
  )
  const govLstContract = new ethers.Contract(
    govLstAddress,
    govLstAbi,
    provider
  ) as ethers.Contract & {
    STAKER(): Promise<string>
    depositIdForHolder(account: string): Promise<bigint>
    fetchOrInitializeDepositForDelegatee(delegatee: string): Promise<bigint>
  }

  // Get staker address
  const stakerAddress = await govLstContract.STAKER()
  if (!stakerAddress) {
    throw new Error('Failed to get staker address from GovLst contract')
  }

  const stakerContract = new ethers.Contract(
    stakerAddress,
    stakerAbi,
    provider
  ) as ethers.Contract & {
    balanceOf(account: string): Promise<bigint>
    deposits(depositId: bigint): Promise<[string, bigint, bigint, string, string]>
    unclaimedReward(depositId: bigint): Promise<bigint>
  }
  logger.info('GovLst contract initialized at:', { address: govLstAddress })
  logger.info('Staker contract initialized at:', { address: stakerAddress })

  // Initialize price feed
  const priceFeed = new CoinMarketCapFeed(
    {
      apiKey: CONFIG.priceFeed.coinmarketcap.apiKey,
      baseUrl: CONFIG.priceFeed.coinmarketcap.baseUrl,
      timeout: CONFIG.priceFeed.coinmarketcap.timeout
    },
    logger
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
        minBalance: ethers.parseEther('0.005'),
        maxPendingTransactions: 5
      },
      maxQueueSize: 100,
      minConfirmations: CONFIG.monitor.confirmations,
      maxRetries: CONFIG.monitor.maxRetries,
      retryDelayMs: 5000,
      transferOutThreshold: ethers.parseEther('0.5'),
      gasBoostPercentage: CONFIG.govlst.gasPriceBuffer,
      concurrentTransactions: 3,
      defaultTipReceiver: CONFIG.executor.tipReceiver
    },
    database
  )

  // Initialize profitability engine
  logger.info('Initializing profitability engine...')
  const profitabilityEngine = new GovLstProfitabilityEngineWrapper(
    database,
    govLstContract,
    stakerContract,
    provider,
    logger,
    priceFeed,
    {
      minProfitMargin: CONFIG.govlst.minProfitMargin,
      maxBatchSize: CONFIG.govlst.maxBatchSize,
      gasPriceBuffer: CONFIG.govlst.gasPriceBuffer,
      rewardTokenAddress: govLstAddress,
      defaultTipReceiver: CONFIG.executor.tipReceiver,
      priceFeed: {
        cacheDuration: 10 * 60 * 1000 // 10 minutes
      }
    },
    executor
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

    // Process deposits in batches
    const batchSize = 5;
    const depositBatches = [];
    const currentBatch = [];

    for (const deposit of deposits) {
      try {
        // Skip deposits with amount = 0
        if (BigInt(deposit.amount) === BigInt(0)) {
          logger.info(`Skipping deposit ${deposit.deposit_id} with amount 0`)
          continue
        }

        logger.info(`Processing deposit ${deposit.deposit_id}`, {
          owner: deposit.owner_address,
          depositor: deposit.depositor_address,
          delegatee: deposit.delegatee_address,
          amount: deposit.amount
        })

        // Use deposit ID from our database
        const depositId = BigInt(deposit.deposit_id)

        // Get unclaimed rewards
        const unclaimedRewards = await stakerContract.unclaimedReward(depositId)

        // Skip if no unclaimed rewards
        if (unclaimedRewards === BigInt(0)) {
          logger.info(`Skipping deposit ${deposit.deposit_id} with no unclaimed rewards`)
          continue
        }

        logger.info(`Unclaimed rewards for deposit ${deposit.deposit_id}:`, {
          depositId: depositId.toString(),
          rewards: ethers.formatEther(unclaimedRewards),
          owner: deposit.owner_address,
          depositor: deposit.depositor_address
        })

        // Add to current batch
        currentBatch.push({
          deposit_id: BigInt(deposit.deposit_id),
          owner_address: deposit.owner_address,
          depositor_address: deposit.depositor_address,
          delegatee_address: deposit.delegatee_address || '',
          amount: BigInt(deposit.amount),
          shares_of: BigInt(0), // Will be fetched by the engine
          payout_amount: BigInt(0), // Will be fetched by the engine
          rewards: unclaimedRewards // Use the unclaimed rewards we fetched earlier
        });

        // If batch is full or this is the last deposit, process the batch
        if (currentBatch.length >= batchSize || deposit === deposits[deposits.length - 1]) {
          if (currentBatch.length >= 1) {  // Only process if we have at least one deposit
            depositBatches.push([...currentBatch]);
            currentBatch.length = 0;  // Clear the current batch
          }
        }
      } catch (error) {
        logger.error(`Error processing deposit ${deposit.deposit_id}:`, {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    // Process each batch
    for (const batch of depositBatches) {
      try {
        logger.info(`Processing batch of ${batch.length} deposits`)

        // Check profitability
        const profitability = await profitabilityEngine.checkGroupProfitability(batch)

        if (profitability.is_profitable) {
          logger.info(`Batch is profitable:`, {
            expectedProfit: profitability.estimates.expected_profit.toString(),
            gasEstimate: profitability.estimates.gas_estimate.toString(),
            depositCount: batch.length
          })

          // Queue transaction with proper serialization
          const tx = await executor.queueTransaction(
            batch.map(d => d.deposit_id),
            profitability,
            JSON.stringify({
              depositIds: batch.map(d => d.deposit_id.toString()),
              profitability: {
                ...profitability,
                estimates: {
                  expected_profit: profitability.estimates.expected_profit.toString(),
                  gas_estimate: profitability.estimates.gas_estimate.toString(),
                  total_shares: profitability.estimates.total_shares.toString(),
                  payout_amount: profitability.estimates.payout_amount.toString()
                },
                deposit_details: profitability.deposit_details.map(detail => ({
                  ...detail,
                  depositId: detail.depositId.toString(),
                  rewards: detail.rewards.toString()
                }))
              }
            })
          )

          logger.info(`Transaction queued for batch:`, {
            id: tx.id,
            status: tx.status,
            depositIds: batch.map(d => d.deposit_id.toString())
          })
        } else {
          logger.info(`Batch is not profitable:`, {
            constraints: profitability.constraints,
            depositIds: batch.map(d => d.deposit_id.toString())
          })
        }
      } catch (error) {
        logger.error(`Error processing batch:`, {
          error: error instanceof Error ? error.message : String(error),
          depositIds: batch.map(d => d.deposit_id.toString())
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
