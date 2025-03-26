import { ConsoleLogger } from '../monitor/logging';
import { StakerMonitor } from '../monitor/StakerMonitor';
import { createMonitorConfig } from '../monitor/constants';
import { GovLstClaimerWrapper } from '../govlst-claimer/GovLstClaimerWrapper';
import { ProfitabilityEngineWrapper } from '../profitability/ProfitabilityEngineWrapper';
import { ExecutorWrapper, ExecutorType } from '../executor';
import { DatabaseWrapper } from '../database';
import { CONFIG } from '../config';
import { ethers } from 'ethers';
import fs from 'fs/promises';
import path from 'path';

// Configuration
const OUTPUT_LOG = path.join(process.cwd(), 'output.log');
const ERROR_LOG = path.join(process.cwd(), 'errors.log');
const STAKER_ABI_PATH = path.join(process.cwd(), 'src/tests/abis/staker.json');

// Setup logging
const logger = new ConsoleLogger('info');
const fullTestLogger = new ConsoleLogger('info', {
  color: '\x1b[33m', // Yellow
  prefix: '[Full Integration]',
});

async function writeToLog(message: string, file: string = OUTPUT_LOG) {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] ${message}\n`;
  await fs.appendFile(file, formattedMessage);
  console.log(formattedMessage.trim());
}

async function writeToErrorLog(error: unknown, context: string) {
  const timestamp = new Date().toISOString();
  const errorMessage = `[${timestamp}] ${context}: ${error instanceof Error ? error.message : String(error)}\n${error instanceof Error ? error.stack : ''}\n\n`;
  await fs.appendFile(ERROR_LOG, errorMessage);
  console.error(`[ERROR] ${context}:`, error);
}

async function waitForDeposits(database: DatabaseWrapper): Promise<boolean> {
  const deposits = await database.getAllDeposits();
  return deposits.length > 0;
}

async function testFullIntegration() {
  try {
    await writeToLog('Starting full integration test with all components');

    // Create provider
    const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);

    // Create database
    const database = new DatabaseWrapper({
      type: CONFIG.monitor.databaseType as 'json' | 'supabase',
    });

    await writeToLog('Initialized provider and database');

    // Load staker ABI
    const stakerAbi = JSON.parse(await fs.readFile(STAKER_ABI_PATH, 'utf8'));

    // Create staker contract instance
    const stakerContract = new ethers.Contract(
      CONFIG.monitor.stakerAddress,
      stakerAbi,
      provider
    );

    await writeToLog('Created staker contract instance');

    // Create components

    // 1. Create Monitor
    const monitor = new StakerMonitor(createMonitorConfig(provider, database));

    // 2. Create Executor
    const executorConfig = {
      wallet: {
        privateKey: CONFIG.executor.privateKey,
        minBalance: ethers.parseEther('0.01'),
        maxPendingTransactions: 3,
      },
      defaultTipReceiver: CONFIG.executor.tipReceiver,
      maxQueueSize: 10,
      minConfirmations: 1,
      maxRetries: 3,
      retryDelayMs: 5000,
      gasBoostPercentage: 10,
      concurrentTransactions: 1, // Keep low for testing
    };

    const executor = new ExecutorWrapper(
      stakerContract,
      provider,
      ExecutorType.WALLET, // Use wallet for testing
      executorConfig,
      database
    );

    await writeToLog('Executor created');

    // 3. Create Profitability Engine
    const profitabilityEngine = new ProfitabilityEngineWrapper(
      database,
      provider,
      CONFIG.monitor.stakerAddress,
      fullTestLogger,
      {
        minProfitMargin: CONFIG.profitability.minProfitMargin,
        gasPriceBuffer: CONFIG.profitability.gasPriceBuffer,
        maxBatchSize: CONFIG.profitability.maxBatchSize,
        rewardTokenAddress: CONFIG.profitability.rewardTokenAddress,
        defaultTipReceiver: CONFIG.profitability.defaultTipReceiver,
        priceFeed: {
          cacheDuration: CONFIG.profitability.priceFeed.cacheDuration,
        },
      }
    );

    await writeToLog('Profitability Engine created');

    // 4. Create GovLst Claimer
    const govLstClaimer = new GovLstClaimerWrapper(
      database,
      provider,
      executor,
      CONFIG.govlst
    );

    await writeToLog('GovLst Claimer created');

    // Connect the components
    profitabilityEngine.setExecutor(executor);

    await writeToLog('All components created and connected');

    // Start components in correct order

    // 1. Start Monitor first to collect deposits
    await monitor.start();
    await writeToLog('Monitor started successfully');

    // 2. Start Executor
    await executor.start();
    await writeToLog('Executor started successfully');

    // Wait for initial deposits
    let hasDeposits = false;
    let attempts = 0;
    const maxAttempts = 5;

    while (!hasDeposits && attempts < maxAttempts) {
      await writeToLog(`Waiting for deposits (attempt ${attempts + 1}/${maxAttempts})...`);
      hasDeposits = await waitForDeposits(database);
      if (!hasDeposits) {
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds
      }
      attempts++;
    }

    // Get monitor status
    const monitorStatus = await monitor.getMonitorStatus();
    await writeToLog(`Monitor Status: ${JSON.stringify(monitorStatus, null, 2)}`);

    // Get executor status
    const executorStatus = await executor.getStatus();
    await writeToLog(`Executor Status: ${JSON.stringify(executorStatus, null, 2)}`);

    // Continue with other components if we have deposits
    if (hasDeposits) {
      await writeToLog('Deposits found, starting remaining components');

      // 3. Start Profitability Engine
      await profitabilityEngine.start();
      await writeToLog('Profitability Engine started successfully');

      // 4. Start GovLst Claimer
      await govLstClaimer.start();
      await writeToLog('GovLst Claimer started successfully');

      // Wait for components to initialize
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds

      // Get all deposits
      const deposits = await database.getAllDeposits();
      await writeToLog(`Total deposits found by monitor: ${deposits.length}`);

      // Get component statuses
      const profitabilityStatus = await profitabilityEngine.getStatus();
      await writeToLog(`Profitability Engine Status: ${JSON.stringify(profitabilityStatus, null, 2)}`);

      const govLstStatus = await govLstClaimer.getStatus();
      await writeToLog(`GovLst Claimer Status: ${JSON.stringify(govLstStatus, null, 2)}`);

      // Test GovLst analysis
      for (const govLstAddress of CONFIG.govlst.addresses!) {
        try {
          await writeToLog(`Analyzing rewards for GovLst address: ${govLstAddress}`);
          const analysis = await govLstClaimer.analyzeRewards(govLstAddress);
          await writeToLog(`Reward analysis for ${govLstAddress}: ${JSON.stringify(analysis, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)}`);
        } catch (error) {
          await writeToErrorLog(error, `Failed to analyze rewards for ${govLstAddress}`);
        }
      }

      // Test Profitability checks
      if (deposits.length > 0) {
        const testDeposits = deposits.slice(0, Math.min(3, deposits.length));

        for (const deposit of testDeposits) {
          try {
            await writeToLog(`Checking profitability for deposit: ${deposit.deposit_id}`);
            // Convert deposit to the format expected by profitabilityEngine
            const convertedDeposit = {
              ...deposit,
              deposit_id: BigInt(deposit.deposit_id),
              amount: BigInt(deposit.amount || '0')
            };
            const profitability = await profitabilityEngine.checkProfitability(convertedDeposit);
            await writeToLog(`Profitability result: ${JSON.stringify(profitability, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)}`);
          } catch (error) {
            await writeToErrorLog(error, `Failed to check profitability for deposit ${deposit.deposit_id}`);
          }
        }
      }

      // Process GovLst claims
      await govLstClaimer.processClaimableRewards();
      await writeToLog('Processed claimable rewards');

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds

      // Get transaction queue status
      const queueStats = await executor.getQueueStats();
      await writeToLog(`Transaction Queue Statistics: ${JSON.stringify(queueStats, null, 2)}`);

      // Get updated component statuses
      const updatedGovLstStatus = await govLstClaimer.getStatus();
      await writeToLog(`Updated GovLst Claimer Status: ${JSON.stringify(updatedGovLstStatus, null, 2)}`);

      const updatedProfitabilityStatus = await profitabilityEngine.getStatus();
      await writeToLog(`Updated Profitability Engine Status: ${JSON.stringify(updatedProfitabilityStatus, null, 2)}`);

      // Stop components in reverse order
      await govLstClaimer.stop();
      await writeToLog('GovLst Claimer stopped successfully');

      await profitabilityEngine.stop();
      await writeToLog('Profitability Engine stopped successfully');
    } else {
      await writeToLog('No deposits found after waiting, skipping remaining component initialization');
    }

    // Stop executor
    await executor.stop();
    await writeToLog('Executor stopped successfully');

    // Stop monitor
    await monitor.stop();
    await writeToLog('Monitor stopped successfully');

    await writeToLog('Full integration test completed successfully');

    return {
      success: true,
      hasDeposits,
      monitorStatus
    };
  } catch (error) {
    await writeToErrorLog(error, 'Full integration test failed');
    return {
      success: false,
      error
    };
  }
}

// Run the test
testFullIntegration()
  .then(result => {
    if (result.success) {
      writeToLog(`Full integration test completed successfully. Found deposits: ${result.hasDeposits}`);
    } else {
      writeToLog(`Full integration test failed: ${result.error}`, ERROR_LOG);
    }
  })
  .catch(error => writeToErrorLog(error, 'Uncaught error in full integration test'));
