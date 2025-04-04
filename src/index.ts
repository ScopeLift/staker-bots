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
import fs from 'fs/promises';
import { GovLstProfitabilityCheck } from './profitability';
import { ProcessingQueueStatus, TransactionQueueStatus } from './database';
import path from 'path';
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

// Set up error logging path
const ERROR_LOG_PATH = path.join(process.cwd(), 'error.logs');
// Reward check interval (in milliseconds)
const REWARD_CHECK_INTERVAL = 60 * 1000; // 1 minutes

// Load staker ABI from configuration
const loadStakerAbi = async (): Promise<typeof stakerAbi> => {
  try {
    return stakerAbi;
  } catch (error) {
    mainLogger.error('Failed to load staker ABI:', { error });
    throw error;
  }
};

// Helper function to serialize objects with BigInt values
function serializeBigInt<T>(
  value: T,
): string | Array<unknown> | Record<string, unknown> | T {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeBigInt(item));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key in value as object) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const val = (value as Record<string, unknown>)[key];
        if (val !== undefined) {
          result[key] = serializeBigInt(val);
        }
      }
    }
    return result;
  }

  return value;
}

// Helper function to serialize profitability check objects
function serializeProfitabilityCheck(check: GovLstProfitabilityCheck): {
  is_profitable: boolean;
  constraints: {
    has_enough_shares: boolean;
    meets_min_reward: boolean;
    meets_min_profit: boolean;
  };
  estimates: {
    expected_profit: string;
    gas_estimate: string;
    total_shares: string;
    payout_amount: string;
  };
  deposit_details: Array<{
    depositId: string;
    rewards: string;
  }>;
} {
  return {
    is_profitable: check.is_profitable,
    constraints: {
      has_enough_shares: check.constraints.has_enough_shares,
      meets_min_reward: check.constraints.meets_min_reward,
      meets_min_profit: check.constraints.meets_min_profit,
    },
    estimates: {
      expected_profit: serializeBigInt(
        check.estimates.expected_profit,
      ).toString(),
      gas_estimate: serializeBigInt(check.estimates.gas_estimate).toString(),
      total_shares: serializeBigInt(check.estimates.total_shares).toString(),
      payout_amount: serializeBigInt(check.estimates.payout_amount).toString(),
    },
    deposit_details: check.deposit_details.map((detail) => ({
      depositId: serializeBigInt(detail.depositId).toString(),
      rewards: serializeBigInt(detail.rewards).toString(),
    })),
  };
}

// Create provider helper function
function createProvider() {
  if (!CONFIG.monitor.rpcUrl) {
    throw new Error(
      'RPC URL is not configured. Please set RPC_URL environment variable.',
    );
  }
  return new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);
}

// Helper to log errors to file
async function logError(error: unknown, context: string) {
  const timestamp = new Date().toISOString();
  const errorMessage = `[${timestamp}] ${context}: ${error instanceof Error ? error.message : String(error)}\n${error instanceof Error ? error.stack : ''}\n\n`;

  try {
    await fs.appendFile(ERROR_LOG_PATH, errorMessage);
  } catch (writeError) {
    console.error('Failed to write to error log:', writeError);
  }

  mainLogger.error(context, { error });
}

// Keep track of running components for graceful shutdown
const runningComponents: {
  monitor?: StakerMonitor;
  profitabilityEngine?: GovLstProfitabilityEngineWrapper;
  executor?: ExecutorWrapper;
  rewardCheckInterval?: NodeJS.Timeout;
} = {};

// Graceful shutdown handler
async function shutdown(signal: string) {
  mainLogger.info(`Received ${signal}. Starting graceful shutdown...`);
  try {
    // Clear any running intervals
    if (runningComponents.rewardCheckInterval) {
      clearInterval(runningComponents.rewardCheckInterval);
      runningComponents.rewardCheckInterval = undefined;
    }

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
    await logError(error, 'Error during shutdown');
    process.exit(1);
  }
}

// Function to check for unclaimed rewards and process them
async function checkAndProcessRewards(
  database: DatabaseWrapper,
  stakerContract: ethers.Contract & {
    unclaimedReward(depositId: string): Promise<bigint>;
  },
  executor: ExecutorWrapper,
  logger: Logger,
) {
  try {
    logger.info('Starting reward check cycle with components:', {
      monitor: !!runningComponents.monitor?.getMonitorStatus(),
      profitability: !!runningComponents.profitabilityEngine?.getStatus(),
      executor: !!runningComponents.executor?.getStatus(),
    });

    // Get all deposits from database
    const deposits = await database.getAllDeposits();
    logger.info(`Found ${deposits.length} deposits to check for rewards`);

    if (deposits.length === 0) {
      logger.info('No deposits found to check');
      return;
    }

    // Check each deposit for unclaimed rewards
    const profitableDeposits = [];
    const depositDetails = [];

    for (const deposit of deposits) {
      try {
        // Skip deposits with no ID
        if (!deposit.deposit_id) continue;

        // Get unclaimed rewards for this deposit
        const unclaimedRewards = await stakerContract.unclaimedReward(
          deposit.deposit_id,
        );

        logger.info(`Unclaimed rewards for deposit ${deposit.deposit_id}:`, {
          depositId: deposit.deposit_id,
          rewards: unclaimedRewards.toString(),
          owner: deposit.owner_address,
          amount: deposit.amount,
        });

        // Add deposits with non-zero rewards to the profitable list
        if (unclaimedRewards > 0n) {
          profitableDeposits.push(deposit);
          depositDetails.push({
            depositId: BigInt(deposit.deposit_id),
            rewards: unclaimedRewards,
          });
        }
      } catch (error) {
        logger.error(
          `Error checking rewards for deposit ${deposit.deposit_id}:`,
          { error },
        );
        // Continue with other deposits
      }
    }

    logger.info(
      `Found ${profitableDeposits.length} deposits with unclaimed rewards`,
    );

    // Process profitable deposits if any found
    if (profitableDeposits.length > 0) {
      // Calculate total rewards and shares
      const totalRewards = depositDetails.reduce(
        (sum, detail) => sum + detail.rewards,
        0n,
      );

      const totalShares = profitableDeposits.reduce(
        (sum, deposit) => sum + BigInt(deposit.amount),
        0n,
      );

      // Get current gas price and estimate total gas cost
      const provider = createProvider();
      const gasPrice = await provider.getFeeData();
      const gasEstimate = BigInt(300000); // Default gas estimate
      const gasBuffer = BigInt(CONFIG.govlst.gasPriceBuffer || 20); // 20% buffer by default
      const totalGasCost =
        (gasEstimate * (gasPrice.gasPrice || 0n) * (100n + gasBuffer)) / 100n;

      // Check if rewards exceed gas costs plus minimum profit margin
      const minProfitMargin = BigInt(CONFIG.govlst.minProfitMargin || 0n);
      const isReallyProfitable = totalRewards > totalGasCost + minProfitMargin;

      if (!isReallyProfitable) {
        logger.info('Skipping deposits - not profitable after gas costs:', {
          totalRewards: ethers.formatEther(totalRewards),
          estimatedGasCost: ethers.formatEther(totalGasCost),
          minProfitMargin: ethers.formatEther(minProfitMargin),
        });
        return;
      }

      // Create profitability check object for all deposits
      const profitabilityCheck: GovLstProfitabilityCheck = {
        is_profitable: true,
        constraints: {
          has_enough_shares: true,
          meets_min_reward: true,
          meets_min_profit: true,
        },
        estimates: {
          expected_profit: totalRewards - totalGasCost,
          gas_estimate: gasEstimate,
          total_shares: totalShares,
          payout_amount: totalRewards,
        },
        deposit_details: depositDetails,
      };

      try {
        // First validate the transaction
        await executor.validateTransaction(
          profitableDeposits.map((d) => BigInt(d.deposit_id)),
          profitabilityCheck,
        );

        // If validation succeeds, create database entries
        // Update or create processing queue items
        for (const deposit of profitableDeposits) {
          // Check for existing queue item
          const existingItem = await database.getProcessingQueueItem(
            deposit.deposit_id,
          );
          if (existingItem) {
            // Update existing item
            await database.updateProcessingQueueItem(existingItem.id, {
              status: ProcessingQueueStatus.PENDING,
              delegatee: deposit.delegatee_address || '',
            });
            logger.info(
              `Updated existing queue item for deposit ${deposit.deposit_id}`,
            );
          } else {
            // Create new item
            await database.createProcessingQueueItem({
              deposit_id: deposit.deposit_id,
              status: ProcessingQueueStatus.PENDING,
              delegatee: deposit.delegatee_address || '',
            });
            logger.info(
              `Created new queue item for deposit ${deposit.deposit_id}`,
            );
          }
        }

        // Create a single transaction queue item for all deposits
        const txQueueItem = await database.createTransactionQueueItem({
          deposit_id: profitableDeposits.map((d) => d.deposit_id).join(','),
          status: TransactionQueueStatus.PENDING,
          tx_data: JSON.stringify({
            depositIds: profitableDeposits.map((d) => d.deposit_id),
            totalRewards: totalRewards.toString(),
            profitability: serializeProfitabilityCheck(profitabilityCheck),
          }),
        });

        // Queue the transaction with the executor
        const queueResult = await executor.queueTransaction(
          profitableDeposits.map((d) => BigInt(d.deposit_id)),
          profitabilityCheck,
          JSON.stringify({
            depositIds: profitableDeposits.map((d) => d.deposit_id),
            totalRewards: totalRewards.toString(),
            profitability: serializeProfitabilityCheck(profitabilityCheck),
            queueItemId: txQueueItem.id,
          }),
        );

        logger.info('Transaction processing status:', {
          queueItemId: txQueueItem.id,
          depositIds: profitableDeposits.map((d) => d.deposit_id),
          totalRewards: ethers.formatEther(totalRewards),
          gasEstimate: gasEstimate.toString(),
          executorStatus: await executor.getStatus(),
          queueResult,
        });
      } catch (error) {
        logger.error('Failed to validate/queue transaction:', { error });
        throw error; // No cleanup needed since we validate before creating database entries
      }
    } else {
      logger.info('No profitable deposits found in this check cycle');
    }
  } catch (error) {
    logger.error('Error in reward check cycle:', {
      error,
      message: 'Skipping current cycle and continuing to next one',
    });
    // No need for cleanup since validation happens before database operations
  }
}

// Initialize and start the StakerMonitor
async function initializeMonitor(
  database: DatabaseWrapper,
  logger: Logger,
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
    logger.error('Failed to connect to provider:', { error });
    throw error;
  }

  // Create monitor with config
  const monitor = new StakerMonitor(createMonitorConfig(provider, database));

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
      logger.error('Health check failed:', { error });
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return monitor;
}

// Initialize and start the Executor
async function initializeExecutor(
  database: DatabaseWrapper,
  logger: Logger,
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
        }
      : {
          wallet: {
            privateKey: CONFIG.executor.privateKey,
            minBalance: ethers.parseEther('0.01'),
            maxPendingTransactions: 5,
          },
          defaultTipReceiver: CONFIG.executor.tipReceiver,
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
      logger.error('Executor health check failed:', { error });
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
): Promise<GovLstProfitabilityEngineWrapper> {
  logger.info('Initializing profitability engine...');

  const provider = createProvider();

  // Validate required addresses
  const govLstAddress = CONFIG.govlst.addresses?.[0];
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
      logger.error('Profitability engine health check failed:', { error });
    }
  }, CONFIG.monitor.healthCheckInterval * 1000);

  return profitabilityEngine;
}

// Main entry point
async function main() {
  mainLogger.info('Starting GovLst Staking Application...');

  try {
    // Load staker ABI
    const stakerAbi = await loadStakerAbi();

    // Initialize database
    mainLogger.info('Initializing database...');
    const database = new DatabaseWrapper({
      type: CONFIG.monitor.databaseType as 'json' | 'supabase',
      fallbackToJson: true,
    });

    // Parse components to run
    const rawComponents = process.env.COMPONENTS?.split(',').map((c) =>
      c.trim().toLowerCase(),
    ) || ['all'];
    const componentsToRun = rawComponents.includes('all')
      ? ['monitor', 'executor', 'profitability']
      : rawComponents;

    mainLogger.info('Components to run:', { components: componentsToRun });

    // Initialize components in sequence
    // 1. First initialize monitor if enabled
    if (componentsToRun.includes('monitor')) {
      mainLogger.info('Initializing monitor...');
      runningComponents.monitor = await initializeMonitor(
        database,
        monitorLogger,
      );
    }

    // 2. Initialize executor if enabled (required for profitability engine)
    if (
      componentsToRun.includes('executor') ||
      componentsToRun.includes('profitability')
    ) {
      mainLogger.info('Initializing executor...');
      runningComponents.executor = await initializeExecutor(
        database,
        executorLogger,
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
        );

      // Create staker contract with unclaimedReward method for reward checking
      const stakerContract = new ethers.Contract(
        CONFIG.monitor.stakerAddress,
        stakerAbi,
        createProvider(),
      ) as ethers.Contract & {
        unclaimedReward(depositId: string): Promise<bigint>;
      };

      // Set up periodic reward checking interval
      mainLogger.info(
        `Setting up reward checking interval (${REWARD_CHECK_INTERVAL / 1000 / 60} minutes)`,
      );

      // Then set up the interval for future checks
      runningComponents.rewardCheckInterval = setInterval(
        () =>
          checkAndProcessRewards(
            database,
            stakerContract,
            runningComponents.executor!,
            profitabilityLogger,
          ),
        REWARD_CHECK_INTERVAL,
      );
    }

    // Log final status
    mainLogger.info('Application startup complete, components running:', {
      monitor: !!runningComponents.monitor,
      executor: !!runningComponents.executor,
      profitabilityEngine: !!runningComponents.profitabilityEngine,
      rewardCheckInterval: !!runningComponents.rewardCheckInterval,
    });

    mainLogger.info('Application is now running. Press Ctrl+C to stop.');
  } catch (error) {
    await logError(error, 'Error during application startup');
    process.exit(1);
  }
}

// Register signal handlers for graceful shutdown
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Run the application
main().catch(async (error) => {
  await logError(error, 'Unhandled error in main function');
  process.exit(1);
});

// Add global error handlers to prevent crashes
process.on('uncaughtException', async (error) => {
  await logError(
    error,
    'UNCAUGHT EXCEPTION: Application will continue running',
  );
  // Don't exit the process - allow the application to continue running
});

process.on('unhandledRejection', async (reason) => {
  await logError(
    reason,
    'UNHANDLED PROMISE REJECTION: Application will continue running',
  );
  // Don't exit the process - allow the application to continue running
});
