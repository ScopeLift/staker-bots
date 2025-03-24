import { ConsoleLogger } from '../monitor/logging';
import { StakerMonitor } from '../monitor/StakerMonitor';
import { createMonitorConfig } from '../monitor/constants';
import { GovLstClaimerWrapper } from '../govlst-claimer/GovLstClaimerWrapper';
import { ProfitabilityEngineWrapper } from '../profitability/ProfitabilityEngineWrapper';
import { DatabaseWrapper } from '../database';
import { CONFIG } from '../config';
import { ethers } from 'ethers';
import fs from 'fs/promises';
import path from 'path';

// Configuration
const OUTPUT_LOG = path.join(process.cwd(), 'output.log');
const ERROR_LOG = path.join(process.cwd(), 'errors.log');

// Setup logging
const logger = new ConsoleLogger('info');
const testLogger = new ConsoleLogger('info', {
  color: '\x1b[36m', // Cyan
  prefix: '[Integrated Test]',
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

async function testIntegration() {
  try {
    await writeToLog('Starting Monitor + GovLst + Profitability integrated test');

    // Create provider
    const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);

    // Create database
    const database = new DatabaseWrapper({
      type: CONFIG.monitor.databaseType as 'json' | 'supabase',
    });

    await writeToLog('Initialized provider and database');

    // Create a mock executor
    const mockExecutor = {
      queueTransaction: async (depositId: bigint, profitabilityCheck: any, txData?: string) => {
        if (txData) {
          await writeToLog(`Mock executor received govlst transaction request for depositId: ${depositId}, data: ${txData}`);
        } else {
          await writeToLog(`Mock executor received profitability transaction request for depositId: ${depositId}, check: ${JSON.stringify(profitabilityCheck, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
        }
        return { id: '12345-' + Date.now(), depositId, status: 'QUEUED' };
      }
    } as any;

    // Create and start monitor
    const monitor = new StakerMonitor(createMonitorConfig(provider, database));
    await monitor.start();
    await writeToLog('Monitor started successfully');

    // Wait for some blocks to be processed
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

    if (hasDeposits) {
      await writeToLog('Deposits found, initializing other components');

      // Create GovLst claimer
      const govLstClaimer = new GovLstClaimerWrapper(
        database,
        provider,
        mockExecutor,
        CONFIG.govlst
      );

      // Create profitability engine
      const profitabilityEngine = new ProfitabilityEngineWrapper(
        database,
        provider,
        CONFIG.monitor.stakerAddress,
        testLogger,
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

      // Connect profitability engine to executor
      profitabilityEngine.setExecutor(mockExecutor);

      // Start components
      await govLstClaimer.start();
      await writeToLog('GovLst Claimer started successfully');

      await profitabilityEngine.start();
      await writeToLog('Profitability Engine started successfully');

      // Wait for initialization
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds

      // Get all deposits
      const deposits = await database.getAllDeposits();
      await writeToLog(`Total deposits found by monitor: ${deposits.length}`);

      // Get component statuses
      const govLstStatus = await govLstClaimer.getStatus();
      await writeToLog(`GovLst Claimer Status: ${JSON.stringify(govLstStatus, null, 2)}`);

      const profitabilityStatus = await profitabilityEngine.getStatus();
      await writeToLog(`Profitability Engine Status: ${JSON.stringify(profitabilityStatus, null, 2)}`);

      // Analyze GovLst rewards
      for (const govLstAddress of CONFIG.govlst.addresses) {
        try {
          await writeToLog(`Analyzing rewards for GovLst address: ${govLstAddress}`);
          const analysis = await govLstClaimer.analyzeRewards(govLstAddress);
          await writeToLog(`Reward analysis for ${govLstAddress}: ${JSON.stringify(analysis, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)}`);
        } catch (error) {
          await writeToErrorLog(error, `Failed to analyze rewards for ${govLstAddress}`);
        }
      }

      // Check profitability for a few deposits
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

      // Process one round of GovLst claims
      await govLstClaimer.processClaimableRewards();
      await writeToLog('Processed claimable rewards');

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds

      // Get updated statuses
      const updatedGovLstStatus = await govLstClaimer.getStatus();
      await writeToLog(`Updated GovLst Claimer Status: ${JSON.stringify(updatedGovLstStatus, null, 2)}`);

      const updatedProfitabilityStatus = await profitabilityEngine.getStatus();
      await writeToLog(`Updated Profitability Engine Status: ${JSON.stringify(updatedProfitabilityStatus, null, 2)}`);

      // Stop components
      await govLstClaimer.stop();
      await writeToLog('GovLst Claimer stopped successfully');

      await profitabilityEngine.stop();
      await writeToLog('Profitability Engine stopped successfully');
    } else {
      await writeToLog('No deposits found after waiting, skipping component initialization');
    }

    // Stop monitor
    await monitor.stop();
    await writeToLog('Monitor stopped successfully');

    return {
      success: true,
      hasDeposits,
      monitorStatus
    };
  } catch (error) {
    await writeToErrorLog(error, 'Integrated test failed');
    return {
      success: false,
      error
    };
  }
}

// Run the test
testIntegration()
  .then(result => {
    if (result.success) {
      writeToLog(`Integrated test completed successfully. Found deposits: ${result.hasDeposits}`);
    } else {
      writeToLog(`Integrated test failed: ${result.error}`, ERROR_LOG);
    }
  })
  .catch(error => writeToErrorLog(error, 'Uncaught error in integrated test'));
