import { DatabaseWrapper } from './database';
import { CONFIG } from './configuration/constants';
import { ConsoleLogger, Logger } from './monitor/logging';
import { StakerMonitor } from './monitor/StakerMonitor';
import { createMonitorConfig } from './monitor/constants';
import { stakerAbi } from './configuration/abis';
import { CalculatorWrapper } from './calculator/CalculatorWrapper';
import { ExecutorWrapper, ExecutorType } from './executor';
import { ProfitabilityEngineWrapper } from './profitability/ProfitabilityEngineWrapper';
import { ethers } from 'ethers';
import {
  createErrorLogger,
  ErrorLogger
} from './configuration/errorLogger';

// Initialize database first to enable error logging
const database = new DatabaseWrapper({
  type: CONFIG.monitor.databaseType as 'json' | 'supabase'
});

// Create component-specific loggers with colors for better visual distinction
const mainLogger = new ConsoleLogger('info');
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
  color: '\x1b[33m', // Yellow
  prefix: '[Executor]',
});

// Initialize error loggers for components
const mainErrorLogger = createErrorLogger({ appName: 'main-service' });
const monitorErrorLogger = createErrorLogger({ appName: 'monitor-service' });
const calculatorErrorLogger = createErrorLogger({ appName: 'calculator-service' });
const profitabilityErrorLogger = createErrorLogger({ appName: 'profitability-service' });
const executorErrorLogger = createErrorLogger({ appName: 'executor-service' });

/**
 * Creates an Ethereum provider using the configured RPC URL
 * @returns {ethers.JsonRpcProvider} The configured providerŔ
 * @throws {Error} If RPC URL is not configured
 */
function createProvider() {
  if (!CONFIG.monitor.rpcUrl) {
    throw new Error(
      'RPC URL is not configured. Please set RPC_URL environment variable.'
    );
  }
  return new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);
}

/**
 * Loads the staker ABI from the configuration
 * @returns {ethers.InterfaceAbi} The staker ABI
 */
function loadStakerAbi(): ethers.InterfaceAbi {
  return stakerAbi
}

/**
 * Ensure checkpoints are properly initialized, either from existing database or from START_BLOCK
 * @param {DatabaseWrapper} database - The database instance
 * @param {Logger} logger - Logger instance
 * @param {ErrorLogger} errorLogger - Error logger instance
 */
async function ensureCheckpointsAtStartBlock(
  database: DatabaseWrapper,
  logger: Logger,
  errorLogger: ErrorLogger,
) {
  logger.info('Checking for existing checkpoints...');

  // List of components to check
  const componentTypes = ['staker-monitor', 'executor', 'profitability-engine', 'calculator'];

  try {
    // First check if we have any existing checkpoints
    const existingCheckpoints = await Promise.all(
      componentTypes.map(async (type) => ({
        type,
        checkpoint: await database.getCheckpoint(type)
      }))
    );

    const hasAnyCheckpoints = existingCheckpoints.some(({ checkpoint }) => checkpoint !== null);
    const allHaveCheckpoints = existingCheckpoints.every(({ checkpoint }) => checkpoint !== null);

    // If we have any checkpoints, validate they are consistent
    if (hasAnyCheckpoints) {
      logger.info('Found existing checkpoints in database');

      if (!allHaveCheckpoints) {
        // Some components have checkpoints but not all - this is an inconsistent state
        logger.warn('Inconsistent checkpoint state detected - some components missing checkpoints');
        
        // Find the lowest checkpoint block to use as reference
        const lowestBlock = Math.min(
          ...existingCheckpoints
            .filter(({ checkpoint }) => checkpoint !== null)
            .map(({ checkpoint }) => checkpoint!.last_block_number)
        );

        logger.info(`Using lowest existing checkpoint block as reference: ${lowestBlock}`);

        // Create missing checkpoints at this block
        for (const { type, checkpoint } of existingCheckpoints) {
          if (!checkpoint) {
            logger.info(`Creating missing checkpoint for ${type} at block ${lowestBlock}`);
            await database.updateCheckpoint({
              component_type: type,
              last_block_number: lowestBlock,
              block_hash: '0x0000000000000000000000000000000000000000000000000000000000000000',
              last_update: new Date().toISOString(),
            });
          }
        }
      } else {
        // All components have checkpoints - validate they are at consistent blocks
        const blocks = existingCheckpoints.map(({ checkpoint }) => checkpoint!.last_block_number);
        const minBlock = Math.min(...blocks);
        const maxBlock = Math.max(...blocks);

        if (maxBlock - minBlock > 1000) { // Allow small differences but not large ones
          logger.warn('Large block number disparity detected between component checkpoints', {
            minBlock,
            maxBlock,
            difference: maxBlock - minBlock,
            checkpoints: existingCheckpoints.map(({ type, checkpoint }) => ({
              type,
              block: checkpoint!.last_block_number
            }))
          });
          
          // Instead of resetting to lowest block, we'll keep each component's progress
          // Just log the disparity as a warning
          logger.info('Maintaining individual component progress to preserve processed data');
        }
      }

      logger.info('Checkpoint validation complete - using existing checkpoints');
      return;
    }

    // No existing checkpoints - initialize from START_BLOCK
    const startBlock = CONFIG.monitor.startBlock;
    if (!startBlock) {
      throw new Error('No START_BLOCK configured and no existing checkpoints found');
    }

    logger.info(`No existing checkpoints found - initializing all components at START_BLOCK: ${startBlock}`);

    // Create initial checkpoints for all components
    for (const componentType of componentTypes) {
      await database.updateCheckpoint({
        component_type: componentType,
        last_block_number: startBlock,
        block_hash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        last_update: new Date().toISOString(),
      });
    }

    logger.info('Initial checkpoint creation complete');
  } catch (error) {
    await errorLogger.error(error as Error, {
      context: 'ensureCheckpointsAtStartBlock',
    });
    throw error;
  }
}

/**
 * Checks if there are any deposits in the database
 * @param {DatabaseWrapper} database - The database instance
 * @returns {Promise<boolean>} True if deposits exist, false otherwise
 */
async function waitForDeposits(database: DatabaseWrapper): Promise<boolean> {
  try {
    const deposits = await database.getAllDeposits();
    return deposits.length > 0;
  } catch (error) {
    await mainErrorLogger.error(error as Error, {
      context: 'waitForDeposits',
    });
    return false;
  }
}

// Keep track of running components for graceful shutdown
const runningComponents: {
  monitor?: StakerMonitor;
  calculator?: CalculatorWrapper;
  profitabilityEngine?: ProfitabilityEngineWrapper;
  executor?: ReturnType<typeof ExecutorWrapper>;
} = {};

/**
 * Gracefully shuts down all running components
 * @param {string} signal - The signal that triggered the shutdown
 */
async function shutdown(signal: string) {
  mainLogger.info(`Received ${signal}. Starting graceful shutdown...`);
  try {
    // Stop components in reverse order of initialization
    if (runningComponents.profitabilityEngine) {
      mainLogger.info('Stopping profitability engine...');
      await runningComponents.profitabilityEngine.stop();
    }

    if (runningComponents.executor) {
      mainLogger.info('Stopping executor...');
      await runningComponents.executor.stop();
    }

    if (runningComponents.calculator) {
      mainLogger.info('Stopping calculator...');
      await runningComponents.calculator.stop();
    }

    if (runningComponents.monitor) {
      mainLogger.info('Stopping monitor...');
      await runningComponents.monitor.stop();
    }

    mainLogger.info('Shutdown completed successfully');
    process.exit(0);
  } catch (error) {
    await mainErrorLogger.error(error as Error, {
      context: 'shutdown',
      signal,
    });
    process.exit(1);
  }
}

/**
 * Initializes and starts the StakerMonitor component
 * @param {DatabaseWrapper} database - The database instance
 * @param {Logger} logger - Logger instance
 * @param {ErrorLogger} errorLogger - Error logger instance
 * @returns {Promise<StakerMonitor>} The initialized monitor
 */
async function initializeMonitor(
  database: DatabaseWrapper,
  logger: Logger,
  errorLogger: ErrorLogger,
): Promise<StakerMonitor> {
  logger.info('Initializing staker monitor...');

  const provider = createProvider();

  // Test provider connection
  try {
    const network = await provider.getNetwork();
    logger.info('Connected to network:', {
      chainId: network.chainId.toString(),
      name: network.name,
    });
  } catch (error) {
    await errorLogger.error(error as Error, { context: 'provider-connection' });
    throw error;
  }

  // Create monitor with config
  const monitorConfig = await createMonitorConfig(provider, database);
  const monitor = new StakerMonitor(monitorConfig);

  // Start monitor
  await monitor.start();
  logger.info('Monitor started successfully');

  // Set up health check interval
  setInterval(async () => {
    try {
      const status = await monitor.getMonitorStatus();
      logger.info('Monitor health check:', {
        isRunning: status.isRunning,
        processingLag: status.processingLag,
        currentBlock: status.currentChainBlock,
        lastProcessedBlock: status.lastProcessedBlock,
      });
    } catch (error) {
      await errorLogger.error(error as Error, {
        context: 'monitor-health-check',
      });
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return monitor;
}

/**
 * Initializes and starts the Calculator component
 * @param {DatabaseWrapper} database - The database instance
 * @param {Logger} logger - Logger instance
 * @param {ErrorLogger} errorLogger - Error logger instance
 * @returns {Promise<CalculatorWrapper>} The initialized calculator
 */
async function initializeCalculator(
  database: DatabaseWrapper,
  logger: Logger,
  errorLogger: ErrorLogger,
): Promise<CalculatorWrapper> {
  logger.info('Initializing calculator...');

  const provider = createProvider();

  // Test provider connection
  try {
    const network = await provider.getNetwork();
    logger.info('Connected to network:', {
      chainId: network.chainId.toString(),
      name: network.name,
    });
  } catch (error) {
    await errorLogger.error(error as Error, { context: 'provider-connection' });
    throw error;
  }

  if (!CONFIG.monitor.rewardCalculatorAddress) {
    throw new Error(
      'Reward calculator address is not configured. Please set REWARD_CALCULATOR_ADDRESS environment variable.'
    );
  }

  logger.info('Creating calculator with configuration:', {
    rewardCalculatorAddress: CONFIG.monitor.rewardCalculatorAddress,
  });

  // Create calculator instance
  const calculator = new CalculatorWrapper(database, provider);
  
  // Start calculator
  await calculator.start();
  logger.info('Calculator started successfully');

  // Process initial events
  const currentBlock = await provider.getBlockNumber();
  const lastCheckpoint = await database.getCheckpoint('calculator');
  const initialFromBlock = lastCheckpoint?.last_block_number
    ? lastCheckpoint.last_block_number + 1
    : CONFIG.monitor.startBlock;

  const initialToBlock = Math.min(
    currentBlock - CONFIG.monitor.confirmations,
    initialFromBlock + CONFIG.monitor.maxBlockRange
  );

  if (initialToBlock > initialFromBlock) {
    logger.info('Processing initial score events...', {
      fromBlock: initialFromBlock,
      toBlock: initialToBlock,
      rewardCalculatorAddress: CONFIG.monitor.rewardCalculatorAddress,
    });

    await calculator.processScoreEvents(initialFromBlock, initialToBlock);
    
    // Update checkpoint
    const block = await provider.getBlock(initialToBlock);
    if (!block) throw new Error(`Block ${initialToBlock} not found`);

    await database.updateCheckpoint({
      component_type: 'calculator',
      last_block_number: initialToBlock,
      block_hash: block.hash!,
      last_update: new Date().toISOString(),
    });
    
    logger.info('Initial score events processed successfully');
  }

  // Set up periodic processing
  const processInterval = setInterval(async () => {
    try {
      const status = await calculator.getStatus();
      if (!status.isRunning) {
        logger.info('Calculator stopped, clearing interval');
        clearInterval(processInterval);
        return;
      }

      const currentBlock = await provider.getBlockNumber();
      const lastCheckpoint = await database.getCheckpoint('calculator');
      if (!lastCheckpoint) {
        logger.error('No checkpoint found for calculator');
        return;
      }

      const fromBlock = lastCheckpoint.last_block_number + 1;
      const toBlock = Math.min(
        currentBlock - CONFIG.monitor.confirmations,
        fromBlock + CONFIG.monitor.maxBlockRange
      );

      if (toBlock > fromBlock) {
        logger.info('Processing new score events...', {
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

        logger.info('Score events processed successfully', {
          fromBlock,
          toBlock,
          processedBlocks: toBlock - fromBlock + 1,
        });
      }
    } catch (error) {
      await errorLogger.error(error as Error, {
        context: 'calculator-process-events',
      });
    }
  }, CONFIG.monitor.pollInterval * 1000);

  // Set up health check interval
  setInterval(async () => {
    try {
      const status = await calculator.getStatus();
      if (!status.isRunning) {
        logger.info('Calculator stopped, clearing health check');
        return;
      }

      const currentBlock = await provider.getBlockNumber();
      const lastCheckpoint = await database.getCheckpoint('calculator');
      
      logger.info('Calculator health check:', {
        isRunning: status.isRunning,
        lastProcessedBlock: lastCheckpoint?.last_block_number ?? status.lastProcessedBlock,
        currentBlock,
        processingLag: currentBlock - (lastCheckpoint?.last_block_number ?? status.lastProcessedBlock),
      });
    } catch (error) {
      await errorLogger.error(error as Error, {
        context: 'calculator-health-check',
      });
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return calculator;
}

/**
 * Initializes and starts the Executor component
 * @param {DatabaseWrapper} database - The database instance
 * @param {ethers.InterfaceAbi} stakerAbi - The staker ABI
 * @param {Logger} logger - Logger instance
 * @param {ErrorLogger} errorLogger - Error logger instance
 * @returns {Promise<ReturnType<typeof ExecutorWrapper>>} The initialized executor
 */
async function initializeExecutor(
  database: DatabaseWrapper,
  stakerAbi: ethers.InterfaceAbi,
  logger: Logger,
  errorLogger: ErrorLogger,
): Promise<ReturnType<typeof ExecutorWrapper>> {
  logger.info('Initializing transaction executor...');

  const provider = createProvider();

  // Test provider connection
  try {
    const network = await provider.getNetwork();
    logger.info('Connected to network:', {
      chainId: network.chainId.toString(),
      name: network.name,
    });
  } catch (error) {
    await errorLogger.error(error as Error, { context: 'provider-connection' });
    throw error;
  }

  // Validate staker address is configured
  if (!CONFIG.monitor.stakerAddress) {
    throw new Error(
      'Staker contract address is not configured. Please set STAKER_CONTRACT_ADDRESS environment variable.'
    );
  }

  // Validate private key is configured
  if (!CONFIG.executor.privateKey) {
    throw new Error(
      'Executor private key is not configured. Please set PRIVATE_KEY environment variable.'
    );
  }

  // Initialize staker contract
  const stakerContract = new ethers.Contract(
    CONFIG.monitor.stakerAddress,
    stakerAbi,
    provider
  );

  logger.info('Creating executor with configuration:', {
    type: 'wallet',
    stakerAddress: CONFIG.monitor.stakerAddress,
    tipReceiver: CONFIG.executor.tipReceiver,
    hasPrivateKey: !!CONFIG.executor.privateKey,
  });

  const executorConfig = {
    wallet: {
      privateKey: CONFIG.executor.privateKey,
      minBalance: CONFIG.executor.minBalance,
      maxPendingTransactions: CONFIG.executor.maxPendingTransactions,
    },
    maxQueueSize: CONFIG.executor.maxQueueSize,
    minConfirmations: CONFIG.monitor.confirmations,
    maxRetries: CONFIG.monitor.maxRetries,
    retryDelayMs: CONFIG.executor.retryDelayMs,
    transferOutThreshold: CONFIG.executor.transferOutThreshold,
    gasBoostPercentage: CONFIG.executor.gasBoostPercentage,
    concurrentTransactions: CONFIG.executor.concurrentTransactions,
    defaultTipReceiver: CONFIG.executor.tipReceiver
  };

  // Create executor using the factory function
  const executor = ExecutorWrapper({
    stakerContract,
    provider,
    type: ExecutorType.WALLET,
    config: executorConfig,
    db: database
  });

  // Start executor
  await executor.start();
  logger.info('Executor started successfully');

  // Set up health check interval
  setInterval(async () => {
    try {
      const status = await executor.getStatus();
      logger.info('Executor health check:', {
        isRunning: status.isRunning,
        walletBalance: ethers.formatEther(status.walletBalance),
        pendingTransactions: status.pendingTransactions,
        queueSize: status.queueSize,
      });
    } catch (error) {
      await errorLogger.error(error as Error, {
        context: 'executor-health-check',
      });
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return executor;
}

/**
 * Initializes and starts the Profitability Engine component
 * @param {DatabaseWrapper} database - The database instance
 * @param {ReturnType<typeof ExecutorWrapper>} executor - The executor instance
 * @param {Logger} logger - Logger instance
 * @param {ErrorLogger} errorLogger - Error logger instance
 * @returns {Promise<ProfitabilityEngineWrapper>} The initialized profitability engine
 */
async function initializeProfitabilityEngine(
  database: DatabaseWrapper,
  executor: ReturnType<typeof ExecutorWrapper>,
  logger: Logger,
  errorLogger: ErrorLogger,
): Promise<ProfitabilityEngineWrapper> {
  logger.info('Initializing profitability engine...');

  const provider = createProvider();

  // Test provider connection
  try {
    const network = await provider.getNetwork();
    logger.info('Connected to network:', {
      chainId: network.chainId.toString(),
      name: network.name,
    });
  } catch (error) {
    await errorLogger.error(error as Error, { context: 'provider-connection' });
    throw error;
  }

  // Validate required addresses
  if (!CONFIG.monitor.stakerAddress) {
    throw new Error(
      'Staker contract address is not configured. Please set STAKER_CONTRACT_ADDRESS environment variable.'
    );
  }

  if (!CONFIG.profitability?.rewardTokenAddress) {
    throw new Error(
      'Reward token address is not configured. Please set REWARD_TOKEN_ADDRESS environment variable.'
    );
  }

  logger.info('Creating profitability engine with configuration:', {
    stakerAddress: CONFIG.monitor.stakerAddress,
    rewardTokenAddress: CONFIG.profitability.rewardTokenAddress,
    minProfitMargin: CONFIG.profitability.minProfitMargin.toString(),
    gasPriceBuffer: CONFIG.profitability.gasPriceBuffer,
    maxBatchSize: CONFIG.profitability.maxBatchSize,
  });

  // Create profitability engine
  const profitabilityEngine = new ProfitabilityEngineWrapper(
    database,
    provider,
    CONFIG.monitor.stakerAddress,
    logger,
    {
      minProfitMargin: CONFIG.profitability.minProfitMargin,
      gasPriceBuffer: CONFIG.profitability.gasPriceBuffer,
      maxBatchSize: CONFIG.profitability.maxBatchSize,
      rewardTokenAddress: CONFIG.profitability.rewardTokenAddress,
      defaultTipReceiver: CONFIG.executor.tipReceiver || ethers.ZeroAddress,
      priceFeed: {
        cacheDuration: CONFIG.profitability.priceFeed.cacheDuration,
      }
    }
  );

  // Connect with executor
  profitabilityEngine.setExecutor(executor.executor);

  // Start profitability engine
  await profitabilityEngine.start();
  logger.info('Profitability engine started successfully');

  // Set up health check interval
  setInterval(async () => {
    try {
      const status = await profitabilityEngine.getStatus();
      const queueStats = await profitabilityEngine.getQueueStats();
      
      logger.info('Profitability engine health check:', {
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
      await errorLogger.error(error as Error, {
        context: 'profitability-engine-health-check',
      });
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return profitabilityEngine;
}

/**
 * Triggers initial queue population for the profitability engine
 * @param {DatabaseWrapper} database - The database instance
 * @param {ProfitabilityEngineWrapper} profitabilityEngine - The profitability engine
 * @param {Logger} logger - Logger instance
 * @param {ErrorLogger} errorLogger - Error logger instance
 */
async function triggerInitialQueuePopulation(
  database: DatabaseWrapper,
  profitabilityEngine: ProfitabilityEngineWrapper,
  logger: Logger,
  errorLogger: ErrorLogger,
) {
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

    logger.info(`Found ${uniqueDelegatees.size} unique delegatees for initial queue population`);

    // Trigger score events for each delegatee
    let processedCount = 0;
    for (const delegatee of uniqueDelegatees) {
      // Get the latest score for this delegatee
      const scoreEvent = await database.getLatestScoreEvent(delegatee);
      const score = scoreEvent ? BigInt(scoreEvent.score) : BigInt(0);

      logger.info(`Triggering initial score event for delegatee ${delegatee} with score ${score}`);
      await profitabilityEngine.onScoreEvent(delegatee, score);
      processedCount++;

      // Add a small delay to avoid overwhelming the system
      if (processedCount % 10 === 0) {
        logger.info(`Processed ${processedCount}/${uniqueDelegatees.size} delegatees, waiting...`);
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
    await errorLogger.error(error as Error, {
      context: 'initial-queue-population',
    });
  }
}

/**
 * Sets up a backup periodic check for deposits that may have been missed
 * @param {DatabaseWrapper} database - The database instance
 * @param {ProfitabilityEngineWrapper} profitabilityEngine - The profitability engine
 * @param {Logger} logger - Logger instance
 * @param {ErrorLogger} errorLogger - Error logger instance
 */
function setupBackupProfitabilityCheck(
  database: DatabaseWrapper,
  profitabilityEngine: ProfitabilityEngineWrapper,
  logger: Logger,
  errorLogger: ErrorLogger,
) {
  setInterval(async () => {
    try {
      // Get all deposits from database to check if any were missed by the queue
      const deposits = await database.getAllDeposits();
      if (deposits.length === 0) {
        logger.debug('No deposits found, skipping backup profitability check');
        return;
      }

      // Check queue stats
      const queueStats = await profitabilityEngine.getQueueStats();

      // If queue is handling a significant portion of deposits, skip backup check
      if (queueStats.totalDeposits > deposits.length * 0.5) {
        logger.debug('Queue is already processing most deposits, skipping backup check', {
          queueSize: queueStats.totalDeposits,
          totalDeposits: deposits.length,
        });
        return;
      }

      logger.info('Running backup profitability check for deposits not in queue', {
        totalDeposits: deposits.length,
        queueSize: queueStats.totalDeposits,
      });

      // For each delegatee, trigger a score event to recheck deposits
      const delegatees = new Set<string>();
      for (const deposit of deposits) {
        if (deposit.delegatee_address) {
          delegatees.add(deposit.delegatee_address);
        }
      }

      for (const delegatee of delegatees) {
        logger.debug(`Triggering backup check for delegatee ${delegatee}`);
        await profitabilityEngine.onScoreEvent(delegatee, BigInt(0));
      }
    } catch (error) {
      await errorLogger.error(error as Error, {
        context: 'backup-profitability-check',
      });
    }
  }, 10 * 60 * 1000); // 10 minutes
}

/**
 * Main entry point for the application
 */
async function main() {
  mainLogger.info('Starting Arbitrum Staker Bot Application...');

  try {
    // Load staker ABI
    const stakerAbi = await loadStakerAbi();

    // Check and update checkpoints if needed
    await ensureCheckpointsAtStartBlock(database, mainLogger, mainErrorLogger);

    // Parse components to run
    const rawComponents = process.env.COMPONENTS?.split(',').map((c) =>
      c.trim().toLowerCase()
    ) || ['all'];
    
    const componentsToRun = rawComponents.includes('all')
      ? ['monitor', 'calculator', 'executor', 'profitability']
      : rawComponents;

    mainLogger.info('Components to run:', { components: componentsToRun });

    // Initialize components in sequence
    // 1. First initialize monitor if enabled
    if (componentsToRun.includes('monitor')) {
      mainLogger.info('Initializing monitor...');
      runningComponents.monitor = await initializeMonitor(
        database,
        monitorLogger,
        monitorErrorLogger
      );
    }

    // 2. Initialize calculator if enabled
    if (componentsToRun.includes('calculator')) {
      mainLogger.info('Initializing calculator...');
      
      // Wait for initial deposits if monitor is running
      if (runningComponents.monitor) {
        mainLogger.info('Waiting for initial deposits...');
        let hasDeposits = false;
        while (!hasDeposits) {
          hasDeposits = await waitForDeposits(database);
          if (!hasDeposits) {
            mainLogger.info('No deposits found, waiting...');
            await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute
          }
        }
        mainLogger.info('Deposits found, proceeding with calculator initialization');
      }
      
      runningComponents.calculator = await initializeCalculator(
        database,
        calculatorLogger,
        calculatorErrorLogger
      );
    }

    // 3. Initialize executor if enabled (required for profitability engine)
    if (componentsToRun.includes('executor') || componentsToRun.includes('profitability')) {
      mainLogger.info('Initializing executor...');
      runningComponents.executor = await initializeExecutor(
        database,
        stakerAbi,
        executorLogger,
        executorErrorLogger
      );
    }

    // 4. Initialize profitability engine if enabled
    if (componentsToRun.includes('profitability')) {
      mainLogger.info('Initializing profitability engine...');
      if (!runningComponents.executor) {
        throw new Error('Executor must be initialized before profitability engine');
      }

      runningComponents.profitabilityEngine = await initializeProfitabilityEngine(
        database,
        runningComponents.executor,
        profitabilityLogger,
        profitabilityErrorLogger
      );
      
      // Connect components if calculator exists
      if (runningComponents.calculator) {
        const calculator = runningComponents.calculator;
        const earningPowerCalculator = calculator.getEarningPowerCalculator();
        
        if (earningPowerCalculator) {
          earningPowerCalculator.setProfitabilityEngine(runningComponents.profitabilityEngine);
          mainLogger.info('Connected calculator to profitability engine');
        }
      }
      
      // Trigger initial queue population
      await triggerInitialQueuePopulation(
        database,
        runningComponents.profitabilityEngine,
        mainLogger,
        mainErrorLogger
      );
      
      // Set up backup profitability check
      setupBackupProfitabilityCheck(
        database,
        runningComponents.profitabilityEngine,
        profitabilityLogger,
        profitabilityErrorLogger
      );
    }

    // Log final status
    mainLogger.info('Application startup complete, components running:', {
      monitor: !!runningComponents.monitor,
      calculator: !!runningComponents.calculator,
      executor: !!runningComponents.executor,
      profitabilityEngine: !!runningComponents.profitabilityEngine,
    });

    mainLogger.info('Application is now running. Press Ctrl+C to stop.');
  } catch (error) {
    await mainErrorLogger.error(error as Error, {
      context: 'application-startup',
    });
    process.exit(1);
  }
}

// Register signal handlers for graceful shutdown
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Run the application
main().catch(async (error) => {
  await mainErrorLogger.error(error as Error, { context: 'main-function' });
  process.exit(1);
});

// Add global error handlers to prevent crashes
process.on('uncaughtException', async (error) => {
  await mainErrorLogger.error(error as Error, {
    context: 'uncaught-exception',
    severity: 'FATAL'
  });
  // Don't exit the process - allow the application to continue running
});

process.on('unhandledRejection', async (reason) => {
  await mainErrorLogger.error(
    reason instanceof Error ? reason : new Error(String(reason)),
    {
      context: 'unhandled-rejection',
      severity: 'FATAL'
    }
  );
});
