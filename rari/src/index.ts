import { DatabaseWrapper } from './database';
import { CONFIG } from './configuration';
import { ConsoleLogger, Logger } from './monitor/logging';
import { StakerMonitor } from './monitor/StakerMonitor';
import { createMonitorConfig } from './monitor/constants';
import { stakerAbi } from './configuration/abis';
import { ExecutorWrapper, ExecutorType } from './executor';
import { IExecutor } from './executor/interfaces/IExecutor';
import { GovLstProfitabilityEngineWrapper } from './profitability';
import { ethers } from 'ethers';
import { govlstAbi } from './configuration/abis';
import {
  createErrorLogger,
  ErrorLogger,
  ErrorSeverity,
} from './configuration/errorLogger';
import { RariBumpEarningPowerEngine } from './profitability/strategies/RariBumpEarningPowerEngine';
import { RariClaimDistributeEngine } from './profitability/strategies/RariClaimDistributeEngine';
import { CalculatorWrapper } from './calculator/CalculatorWrapper';
import { CoinMarketCapFeed } from './prices/CoinmarketcapFeed';
import { BinaryEligibilityOracleEarningPowerCalculator } from './calculator';
import path from 'path';
import fs from 'fs/promises';

// Ensure data directory exists
const dataDir = path.resolve(process.cwd(), 'data');
await fs.mkdir(dataDir, { recursive: true }).catch((error) => {
  mainLogger.error('Failed to create data directory:', {
    error: error instanceof Error ? error.message : String(error),
    path: dataDir,
  });
});

// Initialize database first to enable error logging
const database = new DatabaseWrapper({
  type: CONFIG.monitor.databaseType as 'json' | 'supabase',
  fallbackToJson: true,
  jsonDbPath: path.resolve(process.cwd(), 'data', 'rari-staker-monitor-db.json'),
});

// Initialize component-specific loggers with colors for better visual distinction
const mainLogger = new ConsoleLogger('info');
const monitorLogger = new ConsoleLogger('info', {
  color: '\x1b[34m', // Blue
  prefix: '[Monitor]',
});
const profitabilityLogger = new ConsoleLogger('info', {
  color: '\x1b[32m', // Green
  prefix: '[Profitability]',
});
const executorLogger = new ConsoleLogger('info', {
  color: '\x1b[33m', // Yellow
  prefix: '[Executor]',
});

// Initialize error loggers for components
const mainErrorLogger = createErrorLogger('main-service', database);
const monitorErrorLogger = createErrorLogger('monitor-service', database);
const profitabilityErrorLogger = createErrorLogger(
  'profitability-service',
  database,
);
const executorErrorLogger = createErrorLogger('executor-service', database);

// Load staker ABI from configuration
const loadStakerAbi = async (): Promise<typeof stakerAbi> => {
  try {
    return stakerAbi;
  } catch (error) {
    await mainErrorLogger.error(error as Error, { component: 'loadStakerAbi' });
    throw error;
  }
};

// Create provider helper function
function createProvider() {
  if (!CONFIG.monitor.rpcUrl) {
    throw new Error(
      'RPC URL is not configured. Please set RPC_URL environment variable.',
    );
  }
  return new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);
}

// Ensure checkpoints are not lower than START_BLOCK
async function ensureCheckpointsAtStartBlock(
  database: DatabaseWrapper,
  logger: Logger,
  errorLogger: ErrorLogger,
) {
  logger.info('Checking checkpoint blocks against configured START_BLOCK...');

  // Get START_BLOCK from config
  const startBlock = CONFIG.monitor.startBlock;
  if (!startBlock) {
    logger.info('No START_BLOCK configured, skipping checkpoint check');
    return;
  }

  logger.info(`Using START_BLOCK: ${startBlock}`);

  // List of components to check
  const componentTypes = ['staker-monitor', 'executor', 'profitability-engine'];

  try {
    for (const componentType of componentTypes) {
      const checkpoint = await database.getCheckpoint(componentType);

      if (!checkpoint) {
        logger.info(
          `No checkpoint found for ${componentType}, creating with START_BLOCK`,
        );
        await database.updateCheckpoint({
          component_type: componentType,
          last_block_number: startBlock,
          block_hash:
            '0x0000000000000000000000000000000000000000000000000000000000000000',
          last_update: new Date().toISOString(),
        });
        continue;
      }

      if (checkpoint.last_block_number < startBlock) {
        logger.info(
          `Updating ${componentType} checkpoint from block ${checkpoint.last_block_number} to START_BLOCK ${startBlock}`,
        );
        await database.updateCheckpoint({
          component_type: componentType,
          last_block_number: startBlock,
          block_hash: checkpoint.block_hash,
          last_update: new Date().toISOString(),
        });
      } else {
        logger.info(
          `Checkpoint for ${componentType} (${checkpoint.last_block_number}) is already >= START_BLOCK (${startBlock})`,
        );
      }
    }

    logger.info('Checkpoint verification completed');
  } catch (error) {
    await errorLogger.error(error as Error, {
      context: 'ensureCheckpointsAtStartBlock',
    });
    throw error;
  }
}

// Keep track of running components for graceful shutdown
const runningComponents: {
  monitor?: StakerMonitor;
  profitabilityEngine?: GovLstProfitabilityEngineWrapper;
  bumpEarningPowerEngine?: RariBumpEarningPowerEngine;
  claimDistributeEngine?: RariClaimDistributeEngine;
  executor?: ExecutorWrapper;
  calculatorWrapper?: CalculatorWrapper;
} = {};

// Graceful shutdown handler
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

// Initialize and start the StakerMonitor
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
  const monitor = new StakerMonitor(createMonitorConfig(provider, database));

  // Start monitor with coordinated block processing
  await monitor.start();
  logger.info('Monitor started successfully');

  // Set up health check interval - ONLY for status reporting, not for block processing
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

// Initialize and start the Executor
async function initializeExecutor(
  database: DatabaseWrapper,
  logger: Logger,
  errorLogger: ErrorLogger,
): Promise<ExecutorWrapper> {
  logger.info('Initializing transaction executor...');

  const provider = createProvider();

  // Validate staker address is configured
  if (!CONFIG.monitor.stakerAddress) {
    throw new Error(
      'Staker contract address is not configured. Please set STAKER_CONTRACT_ADDRESS environment variable.',
    );
  }

  // Validate LST address is configured
  if (!CONFIG.monitor.lstAddress) {
    throw new Error(
      'LST contract address is not configured. Please set LST_ADDRESS environment variable.',
    );
  }

  // Determine executor type from environment or configuration
  const executorType = CONFIG.executor.executorType || 'wallet';

  // Validate executor type
  if (!['wallet', 'defender', 'relayer'].includes(executorType)) {
    throw new Error(
      `Invalid executor type: ${executorType}. Must be 'wallet', 'defender', or 'relayer'`,
    );
  }

  // Create LST contract instance - important to use this for the executor
  const lstContract = new ethers.Contract(
    CONFIG.monitor.lstAddress,
    govlstAbi,
    provider,
  );

  logger.info('Creating executor with configuration:', {
    type: executorType,
    lstAddress: CONFIG.monitor.lstAddress,
    tipReceiver: CONFIG.executor.tipReceiver,
    hasPrivateKey: !!CONFIG.executor.privateKey,
    hasDefenderCredentials:
      !!CONFIG.defender.apiKey && !!CONFIG.defender.secretKey,
  });

  const executorConfig =
    executorType === 'defender' || executorType === 'relayer'
      ? {
          apiKey: CONFIG.defender.apiKey,
          apiSecret: CONFIG.defender.secretKey,
          address: process.env.PUBLIC_ADDRESS_DEFENDER || '',
          minBalance: CONFIG.defender.relayer.minBalance,
          maxPendingTransactions:
            CONFIG.defender.relayer.maxPendingTransactions,
          maxQueueSize: 100,
          minConfirmations: CONFIG.monitor.confirmations,
          maxRetries: CONFIG.monitor.maxRetries,
          retryDelayMs: 5000,
          transferOutThreshold: ethers.parseEther('0.5'),
          gasBoostPercentage: 30,
          concurrentTransactions: 3,
          gasPolicy: CONFIG.defender.relayer.gasPolicy,
          staleTransactionThresholdMinutes:
            CONFIG.executor.staleTransactionThresholdMinutes,
          errorLogger, // Pass the error logger to the config
        }
      : {
          wallet: {
            privateKey: CONFIG.executor.privateKey,
            minBalance: ethers.parseEther('0'),
            maxPendingTransactions: 5,
          },
          defaultTipReceiver: CONFIG.executor.tipReceiver,
          staleTransactionThresholdMinutes:
            CONFIG.executor.staleTransactionThresholdMinutes,
          errorLogger, // Pass the error logger to the config
        };

  const executor = new ExecutorWrapper(
    lstContract,
    provider,
    executorType === 'defender' ? ExecutorType.DEFENDER : ExecutorType.WALLET,
    executorConfig,
    database,
  );

  // Start executor
  await executor.start();
  logger.info('Executor started successfully');

  // Set up health check interval for executor
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

// Initialize and start the Profitability Engine
async function initializeProfitabilityEngine(
  database: DatabaseWrapper,
  executor: IExecutor,
  stakerAbi: ethers.InterfaceAbi,
  logger: Logger,
  errorLogger: ErrorLogger,
): Promise<GovLstProfitabilityEngineWrapper> {
  logger.info('Initializing profitability engine...');

  const provider = createProvider();

  // Validate required addresses
  const govLstAddress = CONFIG.govlst.address;
  if (!govLstAddress) {
    throw new Error(
      'No GovLst contract address configured. Please set GOVLST_ADDRESSES environment variable.',
    );
  }

  const stakerAddress = CONFIG.monitor.stakerAddress;
  if (!stakerAddress) {
    throw new Error(
      'No staker contract address configured. Please set STAKER_CONTRACT_ADDRESS environment variable.',
    );
  }

  // Create contract instances
  logger.info('Creating contract instances:', {
    govLstAddress,
    stakerAddress,
  });

  const govLstContract = new ethers.Contract(
    govLstAddress,
    govlstAbi,
    provider,
  );

  const stakerContract = new ethers.Contract(
    stakerAddress,
    stakerAbi,
    provider,
  );

  // Create profitability engine
  logger.info('Creating profitability engine...');
  const profitabilityEngine = new GovLstProfitabilityEngineWrapper(
    database,
    govLstContract,
    stakerContract,
    provider,
    logger,
    {
      minProfitMargin: CONFIG.govlst.minProfitMargin,
      gasPriceBuffer: CONFIG.govlst.gasPriceBuffer,
      maxBatchSize: CONFIG.govlst.maxBatchSize,
      rewardTokenAddress: govLstAddress,
      defaultTipReceiver: CONFIG.executor.tipReceiver || ethers.ZeroAddress,
      priceFeed: {
        cacheDuration: CONFIG.profitability.priceFeed.cacheDuration,
      },
      errorLogger, // Pass the error logger to the config
    },
    executor,
  );

  // Start profitability engine
  await profitabilityEngine.start();
  logger.info('Profitability engine started successfully');

  // Set up health check interval for profitability engine
  setInterval(async () => {
    try {
      const status = await profitabilityEngine.getStatus();
      logger.info('Profitability engine health check:', {
        isRunning: status.isRunning,
        lastGasPrice: status.lastGasPrice.toString(),
        lastUpdateTimestamp: new Date(status.lastUpdateTimestamp).toISOString(),
        queueSize: status.queueSize,
      });
    } catch (error) {
      await errorLogger.error(error as Error, {
        context: 'profitability-engine-health-check',
      });
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return profitabilityEngine;
}

// Initialize the Rari Earning Power Calculator
async function initializeCalculator(
  logger: Logger,
  errorLogger: ErrorLogger,
): Promise<CalculatorWrapper> {
  logger.info('Initializing Rari Earning Power Calculator...');

  // Create provider instance
  const provider = createProvider();
  
  // Create calculator wrapper
  const calculatorWrapper = new CalculatorWrapper(
    database,
    provider,
    { type: 'binary' }
  );

  // Start calculator - this now includes its own processing loop
  await calculatorWrapper.start();
  logger.info('Calculator started successfully');

  // Set up health check interval
  setInterval(async () => {
    try {
      const status = await calculatorWrapper.getStatus();
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

  logger.info('Calculator initialized successfully');
  return calculatorWrapper;
}

// Initialize Rari Bump Earning Power Engine
async function initializeRariBumpEarningPowerEngine(
  database: DatabaseWrapper,
  executor: IExecutor,
  calculatorWrapper: CalculatorWrapper,
  logger: Logger,
  errorLogger: ErrorLogger,
): Promise<RariBumpEarningPowerEngine> {
  logger.info('Initializing Rari Bump Earning Power Engine...');

  // Create provider instance for contracts
  const provider = createProvider();

  // Create price feed with correct config
  const priceFeed = new CoinMarketCapFeed({
    baseUrl: 'https://pro-api.coinmarketcap.com',
    apiKey: CONFIG.priceFeed.coinmarketcap.apiKey,
    rewardToken: CONFIG.govlst.address,
    gasToken: ethers.ZeroAddress,
    errorLogger: profitabilityErrorLogger,
    timeout: 5000
  }, profitabilityLogger);

  // Create Rari Bump Earning Power Engine
  const bumpEarningPowerEngine = new RariBumpEarningPowerEngine({
    database,
    executor,
    calculatorWrapper,
    calculator: calculatorWrapper as unknown as BinaryEligibilityOracleEarningPowerCalculator,
    stakerContract: new ethers.Contract(
      CONFIG.monitor.stakerAddress,
      stakerAbi,
      provider
    ) as unknown as ethers.Contract & {
      deposits(depositId: bigint): Promise<{
        owner: string;
        balance: bigint;
        earningPower: bigint;
        delegatee: string;
        claimer: string;
      }>;
      unclaimedReward(depositId: bigint): Promise<bigint>;
      maxBumpTip(): Promise<bigint>;
      bumpEarningPower(depositId: bigint, tipReceiver: string, tip: bigint): Promise<bigint>;
      REWARD_TOKEN(): Promise<string>;
    },
    provider,
    config: {
      rewardTokenAddress: CONFIG.govlst.address,
      defaultTipReceiver: CONFIG.executor.tipReceiver || ethers.ZeroAddress,
      minProfitMargin: CONFIG.govlst.minProfitMargin,
      gasPriceBuffer: CONFIG.govlst.gasPriceBuffer,
      maxBatchSize: CONFIG.govlst.maxBatchSize,
      priceFeed: {
        cacheDuration: CONFIG.profitability.priceFeed.cacheDuration
      }
    },
    priceFeed,
    logger: profitabilityLogger
  });

  logger.info('Rari Bump Earning Power Engine initialized successfully');
  return bumpEarningPowerEngine;
}

// Initialize Rari Claim and Distribute Engine
async function initializeRariClaimDistributeEngine(
  database: DatabaseWrapper,
  executor: IExecutor,
  logger: Logger,
): Promise<RariClaimDistributeEngine> {
  logger.info('Initializing Rari Claim and Distribute Engine...');

  // Create provider instance
  const provider = createProvider();

  // Create calculator wrapper
  const calculatorWrapper = new CalculatorWrapper(
    database,
    provider,
    { type: 'binary' }
  );

  // Create price feed
  const priceFeed = new CoinMarketCapFeed({
    baseUrl: 'https://pro-api.coinmarketcap.com',
    apiKey: CONFIG.priceFeed.coinmarketcap.apiKey,
    rewardToken: CONFIG.govlst.address,
    gasToken: ethers.ZeroAddress,
    errorLogger: profitabilityErrorLogger,
    timeout: 5000
  }, profitabilityLogger);

  // Create Rari Claim and Distribute Engine
  const claimDistributeEngine = new RariClaimDistributeEngine({
    database,
    executor,
    calculator: calculatorWrapper as unknown as BinaryEligibilityOracleEarningPowerCalculator,
    stakerContract: new ethers.Contract(
      CONFIG.monitor.stakerAddress,
      stakerAbi,
      provider
    ) as unknown as ethers.Contract & {
      deposits(depositId: bigint): Promise<{
        owner: string;
        balance: bigint;
        earningPower: bigint;
        delegatee: string;
        claimer: string;
      }>;
      unclaimedReward(depositId: bigint): Promise<bigint>;
      maxBumpTip(): Promise<bigint>;
      bumpEarningPower(depositId: bigint, tipReceiver: string, tip: bigint): Promise<bigint>;
      REWARD_TOKEN(): Promise<string>;
    },
    provider,
    config: {
      rewardTokenAddress: CONFIG.govlst.address,
      defaultTipReceiver: CONFIG.executor.tipReceiver || ethers.ZeroAddress,
      minProfitMargin: CONFIG.govlst.minProfitMargin,
      gasPriceBuffer: CONFIG.govlst.gasPriceBuffer,
      maxBatchSize: CONFIG.govlst.maxBatchSize,
      priceFeed: {
        cacheDuration: CONFIG.profitability.priceFeed.cacheDuration
      }
    },
    priceFeed
  });

  logger.info('Rari Claim and Distribute Engine initialized successfully');
  return claimDistributeEngine;
}

// Main entry point
async function main() {
  mainLogger.info('Starting Rari Staking Application...');

  try {
    // Load staker ABI
    const stakerAbi = await loadStakerAbi();

    // Database already initialized at top of file

    // Check and update checkpoints if needed
    await ensureCheckpointsAtStartBlock(database, mainLogger, mainErrorLogger);

    // Parse components to run
    const rawComponents = process.env.COMPONENTS?.split(',').map((c) =>
      c.trim().toLowerCase(),
    ) || ['all'];
    
    // Add new Rari components
    const supportedComponents = ['monitor', 'executor', 'profitability', 'bump', 'claim'];
    const componentsToRun = rawComponents.includes('all')
      ? supportedComponents
      : rawComponents.filter(c => supportedComponents.includes(c));

    mainLogger.info('Components to run:', { components: componentsToRun });

    // Initialize components in sequence
    // 1. First initialize monitor if enabled
    if (componentsToRun.includes('monitor')) {
      mainLogger.info('Initializing monitor...');
      runningComponents.monitor = await initializeMonitor(
        database,
        monitorLogger,
        monitorErrorLogger,
      );
    }

    // 2. Initialize executor if enabled (required for profitability engine)
    if (
      componentsToRun.includes('executor') ||
      componentsToRun.includes('profitability') ||
      componentsToRun.includes('bump') ||
      componentsToRun.includes('claim')
    ) {
      mainLogger.info('Initializing executor...');
      runningComponents.executor = await initializeExecutor(
        database,
        executorLogger,
        executorErrorLogger,
      );
    }

    // 3. Initialize profitability engine if enabled
    if (componentsToRun.includes('profitability')) {
      mainLogger.info('Initializing profitability engine...');
      if (!runningComponents.executor) {
        throw new Error(
          'Executor must be initialized before profitability engine',
        );
      }

      runningComponents.profitabilityEngine =
        await initializeProfitabilityEngine(
          database,
          runningComponents.executor as IExecutor,
          stakerAbi,
          profitabilityLogger,
          profitabilityErrorLogger,
        );
    }

    // 4. Initialize calculator wrapper if needed for bump engine
    if (componentsToRun.includes('bump')) {
      mainLogger.info('Initializing calculator wrapper...');
      runningComponents.calculatorWrapper = await initializeCalculator(
        profitabilityLogger,
        profitabilityErrorLogger,
      );
    }

    // 5. Initialize Rari Bump Earning Power Engine if enabled
    if (componentsToRun.includes('bump')) {
      mainLogger.info('Initializing Rari Bump Earning Power Engine...');
      if (!runningComponents.executor) {
        throw new Error(
          'Executor must be initialized before Bump Earning Power Engine',
        );
      }
      if (!runningComponents.calculatorWrapper) {
        throw new Error(
          'Calculator must be initialized before Bump Earning Power Engine',
        );
      }

      runningComponents.bumpEarningPowerEngine =
        await initializeRariBumpEarningPowerEngine(
          database,
          runningComponents.executor as IExecutor,
          runningComponents.calculatorWrapper,
          profitabilityLogger,
          profitabilityErrorLogger,
        );

      // Connect calculator to profitability engine
      const earningPowerCalculator = runningComponents.calculatorWrapper.getEarningPowerCalculator();
      if (earningPowerCalculator) {
        earningPowerCalculator.setProfitabilityEngine(runningComponents.bumpEarningPowerEngine);
        mainLogger.info('Connected calculator to bump earning power engine');
      }
      
      // Start the bump earning power engine to begin periodic checks
      await runningComponents.bumpEarningPowerEngine!.start();
      mainLogger.info('Bump Earning Power Engine started successfully');

      // Set up health check interval for bump engine
      setInterval(async () => {
        try {
          if (runningComponents.bumpEarningPowerEngine) {
            const status = await runningComponents.bumpEarningPowerEngine.getStatus();
            mainLogger.info('Bump Earning Power Engine health check:', {
              isRunning: status.isRunning,
              lastUpdateTimestamp: new Date(status.lastUpdateTimestamp).toISOString()
            });
          }
        } catch (error) {
          await profitabilityErrorLogger.error(error as Error, {
            context: 'bump-engine-health-check',
          });
        }
      }, CONFIG.monitor.healthCheckInterval * 1000);
    }

    // 6. Initialize Rari Claim and Distribute Engine if enabled
    if (componentsToRun.includes('claim')) {
      mainLogger.info('Initializing Rari Claim and Distribute Engine...');
      if (!runningComponents.executor) {
        throw new Error(
          'Executor must be initialized before Claim and Distribute Engine',
        );
      }

      runningComponents.claimDistributeEngine =
        await initializeRariClaimDistributeEngine(
          database,
          runningComponents.executor as IExecutor,
          profitabilityLogger,
        );
      
      // Start the claim and distribute engine
      await runningComponents.claimDistributeEngine.start();
      mainLogger.info('Claim and Distribute Engine started successfully');
      
      // Set up health check interval for claim engine
      setInterval(async () => {
        try {
          if (runningComponents.claimDistributeEngine) {
            const status = await runningComponents.claimDistributeEngine.getStatus();
            mainLogger.info('Claim and Distribute Engine health check:', {
              isRunning: status.isRunning,
              lastUpdateTimestamp: new Date(status.lastUpdateTimestamp).toISOString()
            });
          }
        } catch (error) {
          await profitabilityErrorLogger.error(error as Error, {
            context: 'claim-engine-health-check',
          });
        }
      }, CONFIG.monitor.healthCheckInterval * 1000);
    }

    // Log final status
    mainLogger.info('Application startup complete, components running:', {
      monitor: !!runningComponents.monitor,
      executor: !!runningComponents.executor,
      profitabilityEngine: !!runningComponents.profitabilityEngine,
      bumpEarningPowerEngine: !!runningComponents.bumpEarningPowerEngine,
      claimDistributeEngine: !!runningComponents.claimDistributeEngine,
    });

    mainLogger.info('Application is now running. Press Ctrl+C to stop.');
  } catch (error) {
    await mainErrorLogger.error(error as Error, {
      context: 'main',
      severity: ErrorSeverity.FATAL,
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
    severity: ErrorSeverity.FATAL,
  });
  // Don't exit the process - allow the application to continue running
});

process.on('unhandledRejection', async (reason) => {
  await mainErrorLogger.error(
    reason instanceof Error ? reason : new Error(String(reason)),
    {
      context: 'unhandled-rejection',
      severity: ErrorSeverity.FATAL,
    },
  );
  // Don't exit the process - allow the application to continue running
});