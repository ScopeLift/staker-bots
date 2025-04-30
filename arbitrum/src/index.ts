import { DatabaseWrapper } from './database';
import { CONFIG } from './config';
import { ConsoleLogger } from './monitor/logging';
import { StakerMonitor } from './monitor/StakerMonitor';
import { createMonitorConfig } from './monitor/constants';
import { CalculatorWrapper } from './calculator/CalculatorWrapper';
import { ExecutorWrapper, ExecutorType } from './executor';
import { ProfitabilityEngineWrapper } from './profitability/ProfitabilityEngineWrapper';
import { ethers } from 'ethers';
import fs from 'fs/promises';
import path from 'path';

// Create component-specific loggers with colors
const monitorLogger = new ConsoleLogger('info', {
  color: '\x1b[34m', // Blue
  prefix: '[Monitor]',
});
const calculatorLogger = new ConsoleLogger('info', {
  color: '\x1b[35m', // Purple
  prefix: '[Calculator]',
});
const profitabilityLogger = new ConsoleLogger('info', {
  color: '\x1b[31m', // Red
  prefix: '[Profitability]',
});
const executorLogger = new ConsoleLogger('info', {
  color: '\x1b[31m', // Red
  prefix: '[Executor]',
});
const logger = new ConsoleLogger('info');

const ERROR_LOG_PATH = path.join(process.cwd(), 'error.logs');

// Load full staker ABI from tests
const STAKER_ABI = JSON.parse(
  await fs.readFile('./src/tests/abis/staker.json', 'utf8'),
);

// Create provider helper function
function createProvider() {
  return new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);
}

// Function removed because it's unused: convertDeposit

async function logError(error: unknown, context: string) {
  const timestamp = new Date().toISOString();
  const errorMessage = `[${timestamp}] ${context}: ${error instanceof Error ? error.message : String(error)}\n${error instanceof Error ? error.stack : ''}\n\n`;
  await fs.appendFile(ERROR_LOG_PATH, errorMessage);
  logger.error(context, { error });
}

async function waitForDeposits(database: DatabaseWrapper): Promise<boolean> {
  try {
    const deposits = await database.getAllDeposits();
    return deposits.length > 0;
  } catch (error) {
    await logError(error, 'Error checking deposits');
    return false;
  }
}

const runningComponents: {
  monitor?: StakerMonitor;
  calculator?: CalculatorWrapper;
  profitabilityEngine?: ProfitabilityEngineWrapper;
  transactionExecutor?: ExecutorWrapper;
} = {};

async function shutdown(signal: string) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);
  try {
    if (runningComponents.monitor) {
      await runningComponents.monitor.stop();
    }
    if (runningComponents.calculator) {
      await runningComponents.calculator.stop();
    }
    if (runningComponents.profitabilityEngine) {
      await runningComponents.profitabilityEngine.stop();
    }
    if (runningComponents.transactionExecutor) {
      await runningComponents.transactionExecutor.stop();
    }
    logger.info('Shutdown completed successfully');
    process.exit(0);
  } catch (error) {
    await logError(error, 'Error during shutdown');
    process.exit(1);
  }
}

async function runMonitor(database: DatabaseWrapper) {
  const provider = createProvider();

  // Test provider connection
  try {
    await provider.getNetwork();
  } catch (error) {
    monitorLogger.error('Failed to connect to provider:', { error });
    throw error;
  }

  const monitor = new StakerMonitor(createMonitorConfig(provider, database));

  // Start monitor
  await monitor.start();

  // Health check logging
  setInterval(async () => {
    try {
      const status = await monitor.getMonitorStatus();
      monitorLogger.info('Monitor Status:', {
        isRunning: status.isRunning,
        processingLag: status.processingLag,
        currentBlock: status.currentChainBlock,
        lastProcessedBlock: status.lastProcessedBlock,
      });
    } catch (error) {
      monitorLogger.error('Health check failed:', { error });
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return monitor;
}

async function runCalculator(database: DatabaseWrapper) {
  const provider = createProvider();

  // Test provider connection
  try {
    await provider.getNetwork();
  } catch (error) {
    calculatorLogger.error('Failed to connect to provider:', { error });
    throw error;
  }

  calculatorLogger.info(
    'Initializing calculator with reward calculator contract:',
    {
      address: CONFIG.monitor.rewardCalculatorAddress,
    },
  );

  const calculator = new CalculatorWrapper(database, provider);
  await calculator.start();

  // Get initial block range
  const currentBlock = await provider.getBlockNumber();
  const lastCheckpoint = await database.getCheckpoint('calculator');
  const initialFromBlock = lastCheckpoint?.last_block_number
    ? lastCheckpoint.last_block_number + 1
    : CONFIG.monitor.startBlock;

  const initialToBlock = Math.min(
    currentBlock - CONFIG.monitor.confirmations,
    initialFromBlock + CONFIG.monitor.maxBlockRange,
  );

  if (initialToBlock > initialFromBlock) {
    calculatorLogger.info('Processing initial score events...', {
      fromBlock: initialFromBlock,
      toBlock: initialToBlock,
      rewardCalculatorAddress: CONFIG.monitor.rewardCalculatorAddress,
    });

    await calculator.processScoreEvents(initialFromBlock, initialToBlock);
    calculatorLogger.info('Initial score events processed successfully');
  }

  // Set up periodic score event processing
  const processInterval = setInterval(async () => {
    try {
      const status = await calculator.getStatus();
      if (!status.isRunning) {
        calculatorLogger.info('Calculator stopped, clearing interval');
        clearInterval(processInterval);
        return;
      }

      const currentBlock = await provider.getBlockNumber();
      const lastCheckpoint = await database.getCheckpoint('calculator');
      if (!lastCheckpoint) {
        calculatorLogger.error('No checkpoint found for calculator');
        return;
      }

      const fromBlock = lastCheckpoint.last_block_number + 1;
      const toBlock = Math.min(
        currentBlock - CONFIG.monitor.confirmations,
        fromBlock + CONFIG.monitor.maxBlockRange,
      );

      if (toBlock > fromBlock) {
        calculatorLogger.info('Processing new score events...', {
          fromBlock,
          toBlock,
          rewardCalculatorAddress: CONFIG.monitor.rewardCalculatorAddress,
          lastProcessedBlock: lastCheckpoint.last_block_number,
        });
        await calculator.processScoreEvents(fromBlock, toBlock);

        // Update checkpoint
        const block = await provider.getBlock(toBlock);
        if (!block) throw new Error(`Block ${toBlock} not found`);

        await database.updateCheckpoint({
          component_type: 'calculator',
          last_block_number: toBlock,
          block_hash: block.hash!,
          last_update: new Date().toISOString(),
        });

        calculatorLogger.info('Score events processed successfully', {
          fromBlock,
          toBlock,
          processedBlocks: toBlock - fromBlock + 1,
        });
      } else {
        calculatorLogger.debug('No new blocks to process', {
          currentBlock,
          lastProcessedBlock: lastCheckpoint.last_block_number,
          confirmations: CONFIG.monitor.confirmations,
        });
      }
    } catch (error) {
      await logError(error, 'Error processing score events');
    }
  }, CONFIG.monitor.pollInterval * 1000);

  // Set up health check logging
  const healthCheckInterval = setInterval(async () => {
    try {
      const status = await calculator.getStatus();
      if (!status.isRunning) {
        calculatorLogger.info(
          'Calculator stopped, clearing health check interval',
        );
        clearInterval(healthCheckInterval);
        return;
      }

      const currentBlock = await provider.getBlockNumber();
      const lastCheckpoint = await database.getCheckpoint('calculator');
      calculatorLogger.info('Calculator Status:', {
        isRunning: status.isRunning,
        lastProcessedBlock:
          lastCheckpoint?.last_block_number ?? status.lastProcessedBlock,
        currentBlock,
        processingLag:
          currentBlock -
          (lastCheckpoint?.last_block_number ?? status.lastProcessedBlock),
      });
    } catch (error) {
      await logError(error, 'Calculator health check failed');
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return calculator;
}

async function runProfitabilityEngine(database: DatabaseWrapper) {
  const provider = createProvider();

  // Test provider connection
  try {
    await provider.getNetwork();
  } catch (error) {
    profitabilityLogger.error('Failed to connect to provider:', { error });
    throw error;
  }

  profitabilityLogger.info(
    'Initializing profitability engine with staker contract:',
    {
      address: CONFIG.monitor.stakerAddress,
    },
  );

  if (!CONFIG.profitability?.rewardTokenAddress) {
    throw new Error('Reward token address not configured');
  }

  const engine = new ProfitabilityEngineWrapper(
    database,
    provider,
    CONFIG.monitor.stakerAddress,
    profitabilityLogger,
    {
      minProfitMargin: BigInt(0), // 0 ETH
      gasPriceBuffer: 20, // 20%
      maxBatchSize: 10,
      rewardTokenAddress: CONFIG.profitability.rewardTokenAddress,
      defaultTipReceiver: CONFIG.executor?.tipReceiver || ethers.ZeroAddress,
      priceFeed: {
        cacheDuration: 10 * 60 * 1000, // 10 minutes
      },
    },
  );

  await engine.start();

  // Set up health check logging
  setInterval(async () => {
    try {
      const status = await engine.getStatus();
      const queueStats = await engine.getQueueStats();

      profitabilityLogger.info('Profitability Engine Status:', {
        isRunning: status.isRunning,
        lastGasPrice: status.lastGasPrice.toString(),
        lastUpdateTimestamp: new Date(status.lastUpdateTimestamp).toISOString(),
        queueSize: status.queueSize,
        delegateeCount: status.delegateeCount,
        pendingItems: queueStats.pendingCount,
        processingItems: queueStats.processingCount,
        completedItems: queueStats.completedCount,
        failedItems: queueStats.failedCount,
      });
    } catch (error) {
      await logError(error, 'Profitability engine health check failed');
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return engine;
}

async function runExecutor(database: DatabaseWrapper) {
  const provider = createProvider();

  // Test provider connection
  try {
    await provider.getNetwork();
  } catch (error) {
    executorLogger.error('Failed to connect to provider:', { error });
    throw error;
  }

  // Initialize staker contract
  const stakerContract = new ethers.Contract(
    CONFIG.monitor.stakerAddress,
    STAKER_ABI,
    provider,
  );

  executorLogger.info('Initializing executor with staker contract:', {
    address: CONFIG.monitor.stakerAddress,
  });

  if (!CONFIG.executor?.privateKey) {
    throw new Error('Executor private key not configured');
  }

  const executor = new ExecutorWrapper(
    stakerContract,
    provider,
    ExecutorType.WALLET,
    {
      wallet: {
        privateKey: CONFIG.executor.privateKey,
        minBalance: ethers.parseEther('0.0000001'), // very small for testing
        maxPendingTransactions: 5,
      },
      maxQueueSize: 100,
      minConfirmations: CONFIG.monitor.confirmations,
      maxRetries: CONFIG.monitor.maxRetries,
      retryDelayMs: 5000,
      transferOutThreshold: ethers.parseEther('0.001'), // 0.001 ETH
      gasBoostPercentage: 10, // 10%
      concurrentTransactions: 3,
    },
    database,
  );

  await executor.start();

  // Set up health check logging
  setInterval(async () => {
    try {
      const status = await executor.getStatus();
      executorLogger.info('Executor Status:', {
        isRunning: status.isRunning,
        walletBalance: ethers.formatEther(status.walletBalance),
        pendingTransactions: status.pendingTransactions,
        queueSize: status.queueSize,
      });
    } catch (error) {
      await logError(error, 'Executor health check failed');
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return executor;
}

async function main() {
  try {
    // Initialize database
    const database = new DatabaseWrapper({
      type: CONFIG.monitor.databaseType,
    });

    // Start monitor first
    logger.info('Starting monitor...');
    runningComponents.monitor = await runMonitor(database);

    // Wait for initial deposits before starting calculator
    logger.info('Waiting for initial deposits...');
    while (!(await waitForDeposits(database))) {
      await new Promise((resolve) => setTimeout(resolve, 60000)); // Check every minute
    }

    // Start calculator with deposit-dependent scheduling
    logger.info('Starting calculator...');
    runningComponents.calculator = await runCalculator(database);

    // Start profitability engine
    logger.info('Starting profitability engine...');
    runningComponents.profitabilityEngine =
      await runProfitabilityEngine(database);

    // Start executor with profitability verification
    logger.info('Starting transaction executor...');
    runningComponents.transactionExecutor = await runExecutor(database);

    // Connect components
    logger.info('Connecting components...');

    // 1. Connect calculator and profitability engine
    const calculatorComponent = runningComponents.calculator;
    const profitabilityEngine = runningComponents.profitabilityEngine;

    if (calculatorComponent && profitabilityEngine) {
      // Get the earning power calculator from the wrapper
      const earningPowerCalculator =
        calculatorComponent.getEarningPowerCalculator();

      if (earningPowerCalculator) {
        // Set bidirectional references
        earningPowerCalculator.setProfitabilityEngine(profitabilityEngine);
        logger.info('Connected calculator to profitability engine');

        // Verify the connection status
        logger.info('Component connection status:', {
          calculatorHasProfitabilityEngine: true,
          engineHasCalculator: true,
        });
      } else {
        logger.warn('Could not get earning power calculator instance');
      }
    }

    // 2. Connect profitability engine and executor
    if (profitabilityEngine && runningComponents.transactionExecutor) {
      profitabilityEngine.setExecutor(runningComponents.transactionExecutor);
      logger.info('Connected profitability engine to executor');

      // Verify executor status
      const executorStatus =
        await runningComponents.transactionExecutor.getStatus();
      logger.info('Executor connected with status:', {
        isRunning: executorStatus.isRunning,
        walletBalance: ethers.formatEther(executorStatus.walletBalance),
      });
    }

    // 3. Log the current state of components and queues
    const engineStatus = await profitabilityEngine.getStatus();
    const queueStats = await profitabilityEngine.getQueueStats();
    logger.info('Initial profitability engine queue state:', {
      queueSize: engineStatus.queueSize,
      delegateeCount: engineStatus.delegateeCount,
      pendingCount: queueStats.pendingCount,
      processingCount: queueStats.processingCount,
    });

    // 4. Force initial population of the queue at startup
    logger.info('Triggering initial queue population...');
    try {
      // Get unique delegatees from deposits
      const deposits = await database.getAllDeposits();
      const uniqueDelegatees = new Set<string>();

      for (const deposit of deposits) {
        if (deposit.delegatee_address) {
          uniqueDelegatees.add(deposit.delegatee_address);
        }
      }

      logger.info(
        `Found ${uniqueDelegatees.size} unique delegatees for initial queue population`,
      );

      // Trigger score events for each delegatee
      let processedCount = 0;
      for (const delegatee of uniqueDelegatees) {
        // Get the latest score for this delegatee
        const scoreEvent = await database.getLatestScoreEvent(delegatee);
        const score = scoreEvent ? BigInt(scoreEvent.score) : BigInt(0);

        logger.info(
          `Triggering initial score event for delegatee ${delegatee} with score ${score}`,
        );
        await profitabilityEngine.onScoreEvent(delegatee, score);
        processedCount++;

        // Add a small delay to avoid overwhelming the system
        if (processedCount % 10 === 0) {
          logger.info(
            `Processed ${processedCount}/${uniqueDelegatees.size} delegatees, waiting...`,
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      logger.info('Initial queue population complete', {
        processedDelegatees: processedCount,
        totalDelegatees: uniqueDelegatees.size,
      });

      // Check queue state after population
      const afterStatus = await profitabilityEngine.getStatus();
      const afterQueueStats = await profitabilityEngine.getQueueStats();
      logger.info('Queue state after initial population:', {
        queueSize: afterStatus.queueSize,
        delegateeCount: afterStatus.delegateeCount,
        pendingCount: afterQueueStats.pendingCount,
        processingCount: afterQueueStats.processingCount,
      });
    } catch (error) {
      logger.error('Error during initial queue population:', { error });
    }

    // Set up a backup periodic check for deposits not caught by the score events
    setInterval(
      async () => {
        try {
          const profitabilityEngine = runningComponents.profitabilityEngine;
          if (!profitabilityEngine) return;

          // Get all deposits from database to check if any were missed by the queue
          const deposits = await database.getAllDeposits();
          if (deposits.length === 0) {
            profitabilityLogger.debug(
              'No deposits found, skipping backup profitability check',
            );
            return;
          }

          // Check queue stats
          const queueStats = await profitabilityEngine.getQueueStats();

          // If queue is handling a significant portion of deposits, skip backup check
          if (queueStats.totalDeposits > deposits.length * 0.5) {
            profitabilityLogger.debug(
              'Queue is already processing most deposits, skipping backup check',
              {
                queueSize: queueStats.totalDeposits,
                totalDeposits: deposits.length,
              },
            );
            return;
          }

          profitabilityLogger.info(
            'Running backup profitability check for deposits not in queue',
            {
              totalDeposits: deposits.length,
              queueSize: queueStats.totalDeposits,
            },
          );

          // For each delegatee, trigger a score event to recheck deposits
          const delegatees = new Set<string>();
          for (const deposit of deposits) {
            if (deposit.delegatee_address) {
              delegatees.add(deposit.delegatee_address);
            }
          }

          for (const delegatee of delegatees) {
            profitabilityLogger.debug(
              `Triggering backup check for delegatee ${delegatee}`,
            );
            await profitabilityEngine.onScoreEvent(delegatee, BigInt(0));
          }
        } catch (error) {
          profitabilityLogger.error('Error in backup profitability check', {
            error,
          });
        }
      },
      10 * 60 * 1000, // 10 minutes
    );

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    await logError(error, 'Fatal error in main');
    // Don't exit - let the process continue
    logger.info('Recovering from error and continuing...');
  }
}

// Handle uncaught errors without exiting
process.on('uncaughtException', async (error) => {
  await logError(error, 'Uncaught exception');
  // Don't exit - let the process continue
});

process.on('unhandledRejection', async (reason) => {
  await logError(reason, 'Unhandled rejection');
  // Don't exit - let the process continue
});

// Run the application
main().catch(async (error) => {
  await logError(error, 'Fatal error in main');
  // Don't exit - let the process continue
  logger.info('Recovering from error and continuing...');
});
