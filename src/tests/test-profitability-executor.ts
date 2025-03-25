import { ethers } from 'ethers';
import { BinaryEligibilityOracleEarningPowerCalculator } from '../calculator';
import { BaseProfitabilityEngine } from '../profitability/strategies/BaseProfitabilityEngine';
import {
  ProfitabilityConfig,
  Deposit as ProfitabilityDeposit,
  ProfitabilityCheck,
  BatchAnalysis,
} from '../profitability/interfaces/types';
import { DatabaseWrapper } from '../database';
import { ConsoleLogger, Logger } from '../monitor/logging';
import fs from 'fs';
import { Deposit } from '../database/interfaces/types';
import { CoinMarketCapFeed } from '../shared/price-feeds/coinmarketcap/CoinMarketCapFeed';
import { CONFIG } from '../config';
import { ExecutorWrapper, ExecutorType } from '../executor';
import { TransactionStatus } from '../executor/interfaces/types';
import { ProfitabilityEngineWrapper } from '../profitability/ProfitabilityEngineWrapper';
import path from 'path';

// Define database deposit type
interface DatabaseDeposit {
  deposit_id: string;
  amount: string;
  earning_power?: string;
  owner_address: string;
  delegatee_address: string;
}

interface DatabaseContent {
  deposits: Record<string, DatabaseDeposit>;
  score_events?: Record<string, Record<number, ScoreEvent>>;
  checkpoints?: Record<string, CheckpointData>;
}

// Define types for score events and checkpoints
interface ScoreEvent {
  score: string;
  created_at?: string;
  updated_at?: string;
}

interface CheckpointData {
  last_block_number: number;
  block_hash: string;
  last_update: string;
}

// Create logger instance
const logger: Logger = new ConsoleLogger('info');

// Helper function to convert from database deposits to profitability deposits
function convertDeposit(deposit: Deposit): ProfitabilityDeposit {
  return {
    deposit_id: BigInt(deposit.deposit_id),
    owner_address: deposit.owner_address,
    delegatee_address: deposit.delegatee_address || '',
    amount: BigInt(deposit.amount),
    created_at: deposit.created_at,
    updated_at: deposit.updated_at,
  };
}

async function main() {
  logger.info('Starting profitability-executor integrated test...');

  // Initialize database with JSON implementation
  const dbPath = path.join(process.cwd(), 'test-staker-monitor-db.json');
  logger.info(`Using database at ${dbPath}`);
  const database = new DatabaseWrapper({
    type: 'json',
    jsonDbPath: 'test-staker-monitor-db.json',
  });

  // Load database content for testing
  let dbContent: DatabaseContent;
  try {
    logger.info('Loading staker-monitor database from file...');
    dbContent = JSON.parse(
      fs.readFileSync('./staker-monitor-db.json', 'utf-8'),
    ) as DatabaseContent;
    logger.info(
      `Found ${Object.keys(dbContent.deposits).length} deposits in file`,
    );

    // Import deposits into our test database
    for (const deposit of Object.values(dbContent.deposits)) {
      logger.info(`Importing deposit ${deposit.deposit_id}:`, {
        amount: deposit.amount,
        owner: deposit.owner_address,
        delegatee: deposit.delegatee_address,
      });
      await database.createDeposit({
        deposit_id: deposit.deposit_id,
        owner_address: deposit.owner_address,
        amount: deposit.amount,
        delegatee_address: deposit.delegatee_address,
      });
    }

    // Import score events if available
    if (dbContent.score_events) {
      logger.info(`Found score events in database file`);
      let scoreEventCount = 0;
      const delegateeScores = new Map<string, bigint>();

      // For each delegatee, import ALL score events across blocks
      for (const [delegatee, blockEvents] of Object.entries(
        dbContent.score_events,
      )) {
        try {
          // Get all block numbers and sort them chronologically (oldest first)
          const blockNumbers = Object.keys(blockEvents)
            .map(Number)
            .filter((num) => !isNaN(num))
            .sort((a, b) => a - b); // Sort ascending to preserve chronological order

          logger.info(
            `Processing ${blockNumbers.length} score events for delegatee ${delegatee}`,
          );

          // Import all score events for this delegatee
          for (const blockNumber of blockNumbers) {
            const blockKey = blockNumber.toString();
            const scoreEvent = blockEvents[blockKey as unknown as number];

            if (scoreEvent && typeof scoreEvent.score === 'string') {
              // Store the latest score in our cache
              delegateeScores.set(delegatee, BigInt(scoreEvent.score));

              // Import into database
              await database.createScoreEvent({
                delegatee,
                score: scoreEvent.score,
                block_number: blockNumber,
                created_at: scoreEvent.created_at || new Date().toISOString(),
                updated_at: scoreEvent.updated_at || new Date().toISOString(),
              });

              scoreEventCount++;
              logger.debug(
                `Imported score event for delegatee ${delegatee} at block ${blockNumber}:`,
                {
                  score: scoreEvent.score,
                },
              );
            }
          }

          // Log the latest score for this delegatee
          const latestScore = delegateeScores.get(delegatee);
          if (latestScore !== undefined) {
            logger.info(
              `Latest score for delegatee ${delegatee}: ${latestScore.toString()}`,
            );
          }
        } catch (error) {
          logger.error(
            `Error importing score events for delegatee ${delegatee}:`,
            { error },
          );
        }
      }

      logger.info(
        `Imported ${scoreEventCount} score events for ${delegateeScores.size} delegatees`,
      );
    } else {
      logger.warn('No score events found in database file');
    }

    // Import checkpoints if available
    if (dbContent.checkpoints && dbContent.checkpoints.calculator) {
      logger.info('Importing calculator checkpoint');
      await database.updateCheckpoint({
        component_type: 'calculator',
        last_block_number: dbContent.checkpoints.calculator.last_block_number,
        block_hash: dbContent.checkpoints.calculator.block_hash,
        last_update: dbContent.checkpoints.calculator.last_update,
      });
    }
  } catch (error) {
    logger.warn(
      'Could not load external database file, will use empty database:',
      { error },
    );
    dbContent = { deposits: {} };
  }

  // Get all deposits from database
  const deposits = await database.getAllDeposits();
  logger.info(`Working with ${deposits.length} deposits in test database`);

  // Initialize provider
  logger.info('Initializing provider...');
  const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);
  const network = await provider.getNetwork();
  logger.info('Connected to network:', {
    chainId: network.chainId,
    name: network.name,
  });

  // Initialize staker contract
  logger.info('Initializing staker contract...');
  const stakerAddress = CONFIG.monitor.stakerAddress;
  const stakerAbi = JSON.parse(
    fs.readFileSync('./src/tests/abis/staker.json', 'utf-8'),
  );
  const stakerContract = new ethers.Contract(
    stakerAddress!,
    stakerAbi,
    provider,
  );
  logger.info('Staker contract initialized at:', { address: stakerAddress });

  // Define typed contract for better type safety
  const typedContract = stakerContract as ethers.Contract & {
    deposits(depositId: bigint): Promise<{
      owner: string;
      balance: bigint;
      earningPower: bigint;
      delegatee: string;
      claimer: string;
    }>;
    unclaimedReward(depositId: bigint): Promise<bigint>;
    maxBumpTip(): Promise<bigint>;
    bumpEarningPower(
      depositId: bigint,
      tipReceiver: string,
      tip: bigint,
    ): Promise<bigint>;
    REWARD_TOKEN(): Promise<string>;
  };

  // Initialize calculator
  logger.info('Initializing calculator...');
  const calculator = new BinaryEligibilityOracleEarningPowerCalculator(
    database,
    provider,
  );

  // Get all delegatees from score events to validate calculator initialization
  const delegatees = new Set<string>();
  for (const deposit of deposits) {
    if (deposit.delegatee_address) {
      delegatees.add(deposit.delegatee_address);
    }
  }

  // Verify score events are loaded by checking each delegatee's score
  logger.info('Verifying score events are loaded in calculator...');
  let validatedScores = 0;
  let scoreDiscrepancies = 0;

  for (const delegatee of delegatees) {
    try {
      // Get the latest score event from database
      const scoreEvent = await database.getLatestScoreEvent(delegatee);

      if (scoreEvent) {
        const databaseScore = BigInt(scoreEvent.score);

        // Use the calculator's method to get the score (internally uses the cache)
        // We need to call a method that will use the delegatee score
        const amount = BigInt(1000000); // Dummy value
        const owner = '0x0000000000000000000000000000000000000000'; // Dummy value
        const oldEarningPower = BigInt(0); // Dummy value

        // This method internally uses delegatee scores
        const [newEarningPower, isEligible] =
          await calculator.getNewEarningPower(
            amount,
            owner,
            delegatee,
            oldEarningPower,
          );

        // Log the result for debugging
        logger.info(`Validated score for delegatee ${delegatee}:`, {
          databaseScore: databaseScore.toString(),
          blockNumber: scoreEvent.block_number,
          earningPowerResult: {
            newEarningPower: newEarningPower.toString(),
            isEligible,
          },
        });

        validatedScores++;

        // Since we don't have direct access to the calculator's score value,
        // we can only check that the calculation completes without error
      } else {
        logger.warn(`No score found for delegatee ${delegatee}`);
      }
    } catch (error) {
      logger.error(`Error checking score for delegatee ${delegatee}:`, {
        error,
      });
      scoreDiscrepancies++;
    }
  }

  logger.info(`Score validation summary:`, {
    totalDelegatees: delegatees.size,
    validatedScores,
    scoreDiscrepancies,
  });

  // Configure profitability engine
  logger.info('Configuring profitability engine...');
  const config: ProfitabilityConfig = {
    minProfitMargin: BigInt(0), // 0 ETH for testing
    gasPriceBuffer: 20, // 20%
    maxBatchSize: 10,
    rewardTokenAddress: CONFIG.profitability.rewardTokenAddress,
    defaultTipReceiver: CONFIG.executor.tipReceiver || ethers.ZeroAddress,
    priceFeed: {
      cacheDuration: 10 * 60 * 1000, // 10 minutes
    },
  };

  logger.info('Profitability config:', {
    minProfitMargin: ethers.formatEther(config.minProfitMargin),
    gasPriceBuffer: config.gasPriceBuffer,
    maxBatchSize: config.maxBatchSize,
    tipReceiver: config.defaultTipReceiver,
  });

  // Initialize price feed
  const priceFeed = new CoinMarketCapFeed(
    {
      ...CONFIG.priceFeed.coinmarketcap,
      arbTestTokenAddress: CONFIG.monitor.arbTestTokenAddress,
      arbRealTokenAddress: CONFIG.monitor.arbRealTokenAddress,
    },
    logger,
  );

  // Initialize profitability engine directly
  logger.info('Initializing direct profitability engine...');
  const directProfitabilityEngine = new BaseProfitabilityEngine(
    calculator,
    typedContract,
    provider,
    config,
    priceFeed,
  );

  // Start the direct profitability engine
  await directProfitabilityEngine.start();
  logger.info('Direct profitability engine started');

  // Also initialize our wrapper profitability engine with queue processing
  logger.info('Initializing queue-based profitability engine wrapper...');
  const profitabilityEngine = new ProfitabilityEngineWrapper(
    database,
    provider,
    stakerAddress!,
    logger,
    config,
  );

  // Start the profitability engine wrapper
  await profitabilityEngine.start();
  logger.info('Queue-based profitability engine started');

  // Connect calculator to profitability engine for score event processing
  calculator.setProfitabilityEngine(profitabilityEngine);
  logger.info('Connected calculator to profitability engine for score events');

  // PART 1: PROFITABILITY ANALYSIS
  logger.info(`\nAnalyzing ${deposits.length} deposits for profitability...`);

  // Initialize executor
  logger.info('Initializing executor...');
  const executor = new ExecutorWrapper(
    stakerContract,
    provider,
    ExecutorType.WALLET,
    {
      wallet: {
        privateKey: CONFIG.executor.privateKey,
        minBalance: ethers.parseEther('0.0000001'), // Very small value for testing
        maxPendingTransactions: 5,
      },
      maxQueueSize: 10,
      minConfirmations: 1,
      maxRetries: 2,
      retryDelayMs: 2000,
      transferOutThreshold: ethers.parseEther('0.5'),
      gasBoostPercentage: 5,
      concurrentTransactions: 2,
    },
  );

  // Start executor
  await executor.start();
  logger.info('Executor started');

  // Connect executor to profitability engine
  profitabilityEngine.setExecutor(executor);
  logger.info('Connected executor to profitability engine');

  try {
    // Create an array to store the successfully analyzed deposits
    const results: { depositId: bigint; profitability: ProfitabilityCheck }[] =
      [];
    let totalGasEstimate = BigInt(0);
    let totalExpectedProfit = BigInt(0);
    let profitableDeposits = 0;

    // Process each deposit individually to avoid failing the entire batch
    for (const deposit of deposits) {
      try {
        // Convert to ProfitabilityDeposit format
        const profitabilityDeposit = convertDeposit(deposit);

        // Use actual profitability engine instead of mocks
        const profitability =
          await directProfitabilityEngine.checkProfitability(
            profitabilityDeposit,
          );

        // Let's log detailed information about each deposit using database values
        try {
          // Get the delegatee's score from our database
          let delegateeScore = '0';
          if (deposit.delegatee_address) {
            const latestScoreEvent = await database.getLatestScoreEvent(
              deposit.delegatee_address,
            );
            if (latestScoreEvent) {
              delegateeScore = latestScoreEvent.score;
            }
          }

          logger.info(
            `Detailed deposit ${deposit.deposit_id} information from database:`,
            {
              depositId: deposit.deposit_id,
              owner: deposit.owner_address,
              delegatee: deposit.delegatee_address,
              amount: deposit.amount,
              delegateeScore,
            },
          );

          // FORCE ONE DEPOSIT TO BE ELIGIBLE
          // For deposit #15 which has reasonable unclaimed rewards, manually make it eligible
          if (deposit.deposit_id === '15') {
            logger.info(`MAKING DEPOSIT #15 ELIGIBLE FOR TESTING`);

            // Create an adjusted profitability result with force-enabled bumping
            const adjustedProfitability = {
              canBump: true,
              constraints: {
                calculatorEligible: true,
                hasEnoughRewards: true,
                isProfitable: true,
              },
              estimates: {
                // Use a very small tip that's covered by the unclaimed rewards
                optimalTip: ethers.parseEther('0'),
                // Small gas estimate to make it profitable
                gasEstimate: ethers.parseEther('0'),
                // Make sure there's some profit
                expectedProfit: ethers.parseEther('0'),
                tipReceiver:
                  profitability.estimates.tipReceiver ||
                  config.defaultTipReceiver,
              },
            };

            results.push({
              depositId: BigInt(deposit.deposit_id),
              profitability: adjustedProfitability,
            });
            totalGasEstimate += adjustedProfitability.estimates.gasEstimate;
            totalExpectedProfit +=
              adjustedProfitability.estimates.expectedProfit;
            profitableDeposits++;

            logger.info(
              `Deposit ${deposit.deposit_id} is FULLY ELIGIBLE for bumping (forced for testing)`,
            );
            continue;
          }

          // For all other deposits, use the profitability engine result
          results.push({
            depositId: BigInt(deposit.deposit_id),
            profitability: profitability,
          });

          if (profitability.canBump) {
            totalGasEstimate += profitability.estimates.gasEstimate;
            totalExpectedProfit += profitability.estimates.expectedProfit;
            profitableDeposits++;

            logger.info(
              `Deposit ${deposit.deposit_id} is FULLY ELIGIBLE for bumping`,
            );
          } else {
            // Log the reason it's not eligible
            logger.info(
              `Deposit ${deposit.deposit_id} is NOT eligible for bumping:`,
              {
                calculatorEligible:
                  profitability.constraints.calculatorEligible,
                hasEnoughRewards: profitability.constraints.hasEnoughRewards,
                isProfitable: profitability.constraints.isProfitable,
              },
            );
          }
        } catch (error) {
          logger.warn(
            `Error getting detailed information for deposit ${deposit.deposit_id}:`,
            {
              error: error instanceof Error ? error.message : String(error),
            },
          );

          results.push({
            depositId: BigInt(deposit.deposit_id),
            profitability: {
              canBump: false,
              constraints: {
                calculatorEligible: false,
                hasEnoughRewards: false,
                isProfitable: false,
              },
              estimates: {
                optimalTip: BigInt(0),
                gasEstimate: BigInt(0),
                expectedProfit: BigInt(0),
                tipReceiver: config.defaultTipReceiver,
              },
            },
          });
        }
      } catch (error) {
        logger.warn(`Error analyzing deposit ${deposit.deposit_id}:`, {
          error: error instanceof Error ? error.message : String(error),
        });

        // Add a failed result to keep track of all deposits
        results.push({
          depositId: BigInt(deposit.deposit_id),
          profitability: {
            canBump: false,
            constraints: {
              calculatorEligible: false,
              hasEnoughRewards: false,
              isProfitable: false,
            },
            estimates: {
              optimalTip: BigInt(0),
              gasEstimate: BigInt(0),
              expectedProfit: BigInt(0),
              tipReceiver: config.defaultTipReceiver,
            },
          },
        });
      }
    }

    // Create a batch analysis result manually
    const batchAnalysis: BatchAnalysis = {
      deposits: results,
      totalGasEstimate,
      totalExpectedProfit,
      recommendedBatchSize: Math.min(
        results.filter((r) => r.profitability.canBump).length,
        config.maxBatchSize,
      ),
    };

    // Print results
    logger.info('\nBatch Analysis Results:');
    logger.info('------------------------');
    logger.info(
      `Total Gas Estimate: ${ethers.formatEther(batchAnalysis.totalGasEstimate)} ETH`,
    );
    logger.info(
      `Total Expected Profit: ${ethers.formatEther(batchAnalysis.totalExpectedProfit)} ETH`,
    );
    logger.info(
      `Recommended Batch Size: ${batchAnalysis.recommendedBatchSize}`,
    );
    logger.info(
      `Profitable Deposits: ${profitableDeposits} of ${deposits.length}`,
    );

    // PART 2: TEST SCORE EVENTS AND QUEUE PROCESSING
    logger.info('\nPART 2: Testing score events and queue processing...');

    // Simulate score events for some delegatees
    logger.info('Simulating score events for delegatees...');
    const delegatees = new Set<string>();
    for (const deposit of deposits) {
      if (deposit.delegatee_address) {
        delegatees.add(deposit.delegatee_address);
      }
    }

    logger.info(`Found ${delegatees.size} unique delegatees`);
    let count = 0;
    for (const delegatee of delegatees) {
      // Only process the first 3 delegatees to avoid overloading
      if (count++ >= 3) break;

      logger.info(`Triggering score event for delegatee ${delegatee}`);
      try {
        // Use onScoreEvent method directly on the profitability engine
        await profitabilityEngine.onScoreEvent(delegatee, BigInt(100));
        logger.info(`Score event processed for delegatee ${delegatee}`);
      } catch (error) {
        logger.error(
          `Error processing score event for delegatee ${delegatee}:`,
          {
            error,
          },
        );
      }
    }

    // Wait for queue processing to complete
    logger.info('Waiting for queue processing...');
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Check queue stats
    const queueStats = await profitabilityEngine.getQueueStats();
    logger.info('Queue stats after processing:', {
      totalDelegatees: queueStats.totalDelegatees,
      totalDeposits: queueStats.totalDeposits,
      pendingCount: queueStats.pendingCount,
      processingCount: queueStats.processingCount,
      completedCount: queueStats.completedCount,
      failedCount: queueStats.failedCount,
    });

    // PART 3: EXECUTOR TEST
    logger.info('\nPART 3: Testing executor with profitable deposits...');

    // Get initial status
    logger.info('Checking initial executor status...');
    const initialStatus = await executor.getStatus();
    logger.info('Initial status:', {
      isRunning: initialStatus.isRunning,
      walletBalance: ethers.formatEther(initialStatus.walletBalance),
      pendingTransactions: initialStatus.pendingTransactions,
      queueSize: initialStatus.queueSize,
    });

    // Queue transactions for profitable deposits
    logger.info('Queueing transactions for profitable deposits...');
    const queuedTransactions = [];
    const maxToQueue = Math.min(profitableDeposits, 3); // Limit to 3 transactions max for testing
    let queuedCount = 0;

    for (const result of batchAnalysis.deposits) {
      if (result.profitability.canBump && queuedCount < maxToQueue) {
        try {
          // For deposit #15, make sure we log detailed information
          if (result.depositId === BigInt(15)) {
            logger.info('Queueing special forced eligible deposit #15:', {
              depositId: result.depositId.toString(),
              optimalTip: ethers.formatEther(
                result.profitability.estimates.optimalTip,
              ),
              gasEstimate: ethers.formatEther(
                result.profitability.estimates.gasEstimate,
              ),
              expectedProfit: ethers.formatEther(
                result.profitability.estimates.expectedProfit,
              ),
              tipReceiver: result.profitability.estimates.tipReceiver,
            });
          }

          const queuedTx = await executor.queueTransaction(
            result.depositId,
            result.profitability,
          );

          logger.info('Transaction queued:', {
            id: queuedTx.id,
            depositId: result.depositId.toString(),
            status: queuedTx.status,
          });

          queuedTransactions.push(queuedTx);
          queuedCount++;
        } catch (error) {
          logger.error(
            `Error queueing transaction for deposit ${result.depositId}:`,
            {
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
    }

    // Check queue stats
    logger.info('Checking queue stats after manual queueing...');
    const executorQueueStats = await executor.getQueueStats();
    logger.info('Executor queue stats:', {
      totalQueued: executorQueueStats.totalQueued,
      totalPending: executorQueueStats.totalPending,
      totalConfirmed: executorQueueStats.totalConfirmed,
      totalFailed: executorQueueStats.totalFailed,
    });

    // Wait for transactions to process
    logger.info('Waiting for transactions to process...');
    const maxWaitTime = 60000; // 60 seconds
    const startTime = Date.now();

    // Monitor transactions until they're all complete or we time out
    while (Date.now() - startTime < maxWaitTime) {
      let allComplete = true;

      for (const queuedTx of queuedTransactions) {
        const tx = await executor.getTransaction(queuedTx.id);
        if (!tx) continue;

        logger.info('Transaction status:', {
          id: tx.id,
          depositId: queuedTx.depositId?.toString(),
          status: tx.status,
          hash: tx.hash,
          error: tx.error?.message,
        });

        // If any transaction is still in progress, we're not done yet
        if (
          tx.status !== TransactionStatus.CONFIRMED &&
          tx.status !== TransactionStatus.FAILED
        ) {
          allComplete = false;
        }
      }

      if (allComplete && queuedTransactions.length > 0) {
        logger.info('All transactions completed');
        break;
      }

      // Wait 5 seconds before checking again
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Final queue stats
    logger.info('\nFinal queue stats:');
    const finalStats = await executor.getQueueStats();
    logger.info('Queue stats:', {
      totalQueued: finalStats.totalQueued,
      totalPending: finalStats.totalPending,
      totalConfirmed: finalStats.totalConfirmed,
      totalFailed: finalStats.totalFailed,
    });

    // Stop components
    await profitabilityEngine.stop();
    logger.info('Profitability engine stopped');

    await executor.stop();
    logger.info('Executor stopped');

    await directProfitabilityEngine.stop();
    logger.info('Direct profitability engine stopped');
  } catch (error) {
    logger.error('Error during test:', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Make sure to stop the engines even if there's an error
    try {
      await executor.stop();
      await profitabilityEngine.stop();
      await directProfitabilityEngine.stop();
    } catch (stopError) {
      logger.error('Error stopping components:', { stopError });
    }
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Error:', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
