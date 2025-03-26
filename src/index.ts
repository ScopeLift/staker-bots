import { DatabaseWrapper } from './database';
import { CONFIG } from './config';
import { ConsoleLogger } from './monitor/logging';
import { StakerMonitor } from './monitor/StakerMonitor';
import { createMonitorConfig } from './monitor/constants';
import { ExecutorWrapper, ExecutorType } from './executor';
import { ProfitabilityEngineWrapper } from './profitability/ProfitabilityEngineWrapper';
import { GovLstClaimerWrapper } from './govlst-claimer/GovLstClaimerWrapper';
import { ethers } from 'ethers';
import fs from 'fs/promises';
import path from 'path';

// Create component-specific loggers with colors
const monitorLogger = new ConsoleLogger('info', {
  color: '\x1b[34m', // Blue
  prefix: '[Monitor]',
});
const profitabilityLogger = new ConsoleLogger('info', {
  color: '\x1b[31m', // Red
  prefix: '[Profitability]',
});
const executorLogger = new ConsoleLogger('info', {
  color: '\x1b[31m', // Red
  prefix: '[Executor]',
});
const govLstLogger = new ConsoleLogger('info', {
  color: '\x1b[32m', // Green
  prefix: '[GovLst]',
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
  profitabilityEngine?: ProfitabilityEngineWrapper;
  transactionExecutor?: ExecutorWrapper;
  govLstClaimer?: GovLstClaimerWrapper;
} = {};

async function shutdown(signal: string) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);
  try {
    if (runningComponents.monitor) {
      await runningComponents.monitor.stop();
    }
    if (runningComponents.profitabilityEngine) {
      await runningComponents.profitabilityEngine.stop();
    }
    if (runningComponents.transactionExecutor) {
      await runningComponents.transactionExecutor.stop();
    }
    if (runningComponents.govLstClaimer) {
      await runningComponents.govLstClaimer.stop();
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

async function runProfitabilityEngine(database: DatabaseWrapper) {
  const provider = createProvider();

  // Test provider connection
  try {
    await provider.getNetwork();
  } catch (error) {
    profitabilityLogger.error('Failed to connect to provider:', { error });
    throw error;
  }

  profitabilityLogger.info('Initializing profitability engine');

  const profitabilityEngine = new ProfitabilityEngineWrapper(
    database,
    provider,
    CONFIG.monitor.stakerAddress,
    profitabilityLogger,
    {
      minProfitMargin: CONFIG.profitability.minProfitMargin,
      gasPriceBuffer: CONFIG.profitability.gasPriceBuffer,
      maxBatchSize: CONFIG.profitability.maxBatchSize,
      rewardTokenAddress: CONFIG.profitability.rewardTokenAddress,
      defaultTipReceiver: CONFIG.profitability.defaultTipReceiver,
      priceFeed: {
        cacheDuration: CONFIG.profitability.priceFeed.cacheDuration,
      },
    },
  );

  await profitabilityEngine.start();

  return profitabilityEngine;
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

  // Create staker contract instance
  const stakerContract = new ethers.Contract(
    CONFIG.monitor.stakerAddress,
    STAKER_ABI,
    provider
  );

  // Use a minimal config that leverages the defaults
  const executorConfig = {
    wallet: {
      privateKey: CONFIG.executor.privateKey,
      minBalance: ethers.parseEther('0.01'),
      maxPendingTransactions: 5,
    },
    defaultTipReceiver: CONFIG.executor.tipReceiver,
  };

  executorLogger.info('Initializing executor');

  const executor = new ExecutorWrapper(
    stakerContract,
    provider,
    ExecutorType.WALLET,
    executorConfig,
    database
  );

  await executor.start();

  return executor;
}

async function runGovLstClaimer(database: DatabaseWrapper, executor: ExecutorWrapper) {
  const provider = createProvider();

  // Test provider connection
  try {
    await provider.getNetwork();
  } catch (error) {
    govLstLogger.error('Failed to connect to provider:', { error });
    throw error;
  }

  govLstLogger.info('Initializing GovLst Claimer');

  // Check if GovLst addresses are configured
  if (CONFIG.govlst.addresses?.length === 0) {
    govLstLogger.warn('No GovLst addresses configured, claimer will be inactive');
  }

  const govLstClaimer = new GovLstClaimerWrapper(
    database,
    provider,
    executor,
    CONFIG.govlst
  );

  await govLstClaimer.start();

  return govLstClaimer;
}

async function main() {
  logger.info('Starting staker-bots...');

  try {
    // Setup database
    const database = new DatabaseWrapper({
      type: CONFIG.monitor.databaseType as 'json' | 'supabase',
    });

    // Get components to run from environment variable or run monitor by default
    const componentsToRun =
      process.env.COMPONENTS?.split(',').map((c) => c.trim()) || ['monitor'];

    logger.info('Running components:', { components: componentsToRun });

    // Sequential startup to ensure proper dependency initialization
    if (componentsToRun.includes('monitor')) {
      logger.info('Starting monitor...');
      runningComponents.monitor = await runMonitor(database);
    }

    // Start executor if requested (needed for both profitability and GovLst)
    if (componentsToRun.includes('executor') ||
        componentsToRun.includes('profitability') ||
        componentsToRun.includes('govlst')) {
      logger.info('Starting transaction executor...');
      runningComponents.transactionExecutor = await runExecutor(database);
    }

    // Start profitability engine if requested
    if (componentsToRun.includes('profitability')) {
      // Wait for initial deposits before starting profitability
      if (componentsToRun.includes('monitor')) {
        logger.info('Waiting for initial deposits...');
        let hasDeposits = false;
        while (!hasDeposits) {
          hasDeposits = await waitForDeposits(database);
          if (!hasDeposits) {
            logger.info('No deposits found yet, waiting...');
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
        logger.info('Deposits found, starting profitability engine');
      }

      logger.info('Starting profitability engine...');
      runningComponents.profitabilityEngine = await runProfitabilityEngine(
        database,
      );
    }

    // Start GovLst claimer if requested
    if (componentsToRun.includes('govlst') && runningComponents.transactionExecutor) {
      logger.info('Starting GovLst claimer...');
      runningComponents.govLstClaimer = await runGovLstClaimer(
        database,
        runningComponents.transactionExecutor
      );
    }

    // Connect components
    if (runningComponents.profitabilityEngine && runningComponents.transactionExecutor) {
      // Connect profitability engine to executor
      runningComponents.profitabilityEngine.setExecutor(
        runningComponents.transactionExecutor,
      );
      logger.info('Connected profitability engine to executor');
    }

    logger.info('Startup complete, running components:', {
      monitor: !!runningComponents.monitor,
      profitability: !!runningComponents.profitabilityEngine,
      executor: !!runningComponents.transactionExecutor,
      govlst: !!runningComponents.govLstClaimer,
    });
  } catch (error) {
    await logError(error, 'Error during startup');
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Start the application
main().catch(async (error) => {
  await logError(error, 'Unhandled error in main');
  process.exit(1);
});
