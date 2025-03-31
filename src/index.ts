import { DatabaseWrapper } from './database';
import { CONFIG } from './config';
import { ConsoleLogger } from './monitor/logging';
import { StakerMonitor } from './monitor/StakerMonitor';
import { createMonitorConfig } from './monitor/constants';
import { ExecutorWrapper, ExecutorType } from './executor';
import { IExecutor } from './executor/interfaces/IExecutor';
import { GovLstProfitabilityEngineWrapper } from './profitability';
import { CoinMarketCapFeed } from '@/shared/price-feeds/coinmarketcap/CoinMarketCapFeed';
import { GOVLST_ABI } from './monitor/constants';
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
  profitabilityEngine?: GovLstProfitabilityEngineWrapper;
  transactionExecutor?: ExecutorWrapper;
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

  // Check required addresses
  const govLstAddress = CONFIG.govlst.addresses?.[0];
  if (!govLstAddress) {
    throw new Error('No GovLst contract address configured');
  }

  const stakerAddress = CONFIG.monitor.stakerAddress;
  if (!stakerAddress) {
    throw new Error('No staker contract address configured');
  }

  // Create contract instances
  const govLstContract = new ethers.Contract(
    govLstAddress,
    GOVLST_ABI,
    provider,
  );

  const stakerContract = new ethers.Contract(
    stakerAddress,
    STAKER_ABI,
    provider,
  );

  // Initialize price feed
  const priceFeed = new CoinMarketCapFeed(
    {
      apiKey: CONFIG.priceFeed.coinmarketcap.apiKey,
      baseUrl: CONFIG.priceFeed.coinmarketcap.baseUrl,
      timeout: CONFIG.priceFeed.coinmarketcap.timeout,
    },
    profitabilityLogger,
  );

  const profitabilityEngine = new GovLstProfitabilityEngineWrapper(
    database,
    govLstContract,
    stakerContract,
    provider,
    profitabilityLogger,
    priceFeed,
    {
      minProfitMargin: CONFIG.govlst.minProfitMargin,
      gasPriceBuffer: CONFIG.govlst.gasPriceBuffer,
      maxBatchSize: CONFIG.govlst.maxBatchSize,
      rewardTokenAddress: govLstAddress,
      defaultTipReceiver: CONFIG.executor.tipReceiver || ethers.ZeroAddress,
      priceFeed: {
        cacheDuration: CONFIG.profitability.priceFeed.cacheDuration,
      },
    },
    runningComponents.transactionExecutor as IExecutor,
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

  // Get executor type from environment variable
  const executorType = process.env.EXECUTOR_TYPE?.toLowerCase() || 'wallet';

  // Validate executor type
  if (!['wallet', 'defender'].includes(executorType)) {
    throw new Error(
      `Invalid executor type: ${executorType}. Must be 'wallet' or 'defender'`,
    );
  }

  // Create staker contract instance
  const stakerContract = new ethers.Contract(
    CONFIG.monitor.stakerAddress,
    STAKER_ABI,
    provider,
  );

  // Configure executor based on type
  const executorConfig =
    executorType === 'defender'
      ? {
          relayer: {
            apiKey: CONFIG.defender.apiKey,
            secretKey: CONFIG.defender.secretKey,
            minBalance: CONFIG.defender.relayer.minBalance,
            maxPendingTransactions:
              CONFIG.defender.relayer.maxPendingTransactions,
            gasPolicy: CONFIG.defender.relayer.gasPolicy,
          },
          defaultTipReceiver: CONFIG.executor.tipReceiver,
          minConfirmations: CONFIG.monitor.confirmations,
          maxRetries: CONFIG.monitor.maxRetries,
          transferOutThreshold: ethers.parseEther('0.5'),
        }
      : {
          wallet: {
            privateKey: CONFIG.executor.privateKey,
            minBalance: ethers.parseEther('0.01'),
            maxPendingTransactions: 5,
          },
          defaultTipReceiver: CONFIG.executor.tipReceiver,
        };

  executorLogger.info('Initializing executor', { type: executorType });

  const executor = new ExecutorWrapper(
    stakerContract,
    provider,
    executorType === 'defender' ? ExecutorType.DEFENDER : ExecutorType.WALLET,
    executorConfig,
    database,
  );

  await executor.start();

  return executor;
}

async function main() {
  logger.info('Starting staker-bots...');

  try {
    // Setup database
    const database = new DatabaseWrapper({
      type: CONFIG.monitor.databaseType as 'json' | 'supabase',
    });

    // Get components to run from environment variable or run monitor by default
    const componentsToRun = process.env.COMPONENTS?.split(',').map((c) =>
      c.trim(),
    ) || ['monitor'];

    logger.info('Running components:', { components: componentsToRun });

    // Sequential startup to ensure proper dependency initialization
    if (componentsToRun.includes('monitor')) {
      logger.info('Starting monitor...');
      runningComponents.monitor = await runMonitor(database);
    }

    // Start executor if requested (needed for both profitability and GovLst)
    if (
      componentsToRun.includes('executor') ||
      componentsToRun.includes('profitability') ||
      componentsToRun.includes('govlst')
    ) {
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

      if (!runningComponents.transactionExecutor) {
        throw new Error(
          'Executor must be initialized before profitability engine',
        );
      }

      logger.info('Starting profitability engine...');
      runningComponents.profitabilityEngine =
        await runProfitabilityEngine(database);
    }

    // Connect components
    if (
      runningComponents.profitabilityEngine &&
      runningComponents.transactionExecutor
    ) {
      logger.info('Components initialized:', {
        monitor: !!runningComponents.monitor,
        profitability: !!runningComponents.profitabilityEngine,
        executor: !!runningComponents.transactionExecutor,
      });
    }

    logger.info('Startup complete, running components:', {
      monitor: !!runningComponents.monitor,
      profitability: !!runningComponents.profitabilityEngine,
      executor: !!runningComponents.transactionExecutor,
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
