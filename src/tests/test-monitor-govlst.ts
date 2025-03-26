import { ConsoleLogger } from '../monitor/logging';
import { StakerMonitor } from '../monitor/StakerMonitor';
import { createMonitorConfig } from '../monitor/constants';
import { GovLstClaimerWrapper } from '../govlst-claimer/GovLstClaimerWrapper';
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
const monitorLogger = new ConsoleLogger('info', {
  color: '\x1b[34m', // Blue
  prefix: '[Monitor+GovLst]',
});
const govLstLogger = new ConsoleLogger('info', {
  color: '\x1b[32m', // Green
  prefix: '[Monitor+GovLst]',
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

async function testMonitorGovLst() {
  try {
    await writeToLog('Starting Monitor + GovLst integrated test');

    // Create provider
    const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);

    // Create database
    const database = new DatabaseWrapper({
      type: CONFIG.monitor.databaseType as 'json' | 'supabase',
    });

    await writeToLog('Initialized provider and database');

    // Create a mock executor for GovLst
    const mockExecutor = {
      queueTransaction: async (depositId: bigint, profitabilityCheck: any, txData: string) => {
        await writeToLog(`Mock executor received transaction request for depositId: ${depositId}, data: ${txData}`);
        return { id: '12345', depositId, status: 'QUEUED' };
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
      await writeToLog('Deposits found, initializing GovLst Claimer');

      // Create GovLst claimer
      const govLstClaimer = new GovLstClaimerWrapper(
        database,
        provider,
        mockExecutor,
        CONFIG.govlst
      );

      // Start the claimer
      await govLstClaimer.start();
      await writeToLog('GovLst Claimer started successfully');

      // Wait for claimer to initialize
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds

      // Get claimer status
      const claimerStatus = await govLstClaimer.getStatus();
      await writeToLog(`GovLst Claimer Status: ${JSON.stringify(claimerStatus, null, 2)}`);

      // Get all deposits
      const deposits = await database.getAllDeposits();
      await writeToLog(`Total deposits found by monitor: ${deposits.length}`);

      // Analyze rewards for each GovLst address
      for (const govLstAddress of CONFIG.govlst.addresses) {
        try {
          await writeToLog(`Analyzing rewards for GovLst address: ${govLstAddress}`);
          const analysis = await govLstClaimer.analyzeRewards(govLstAddress);
          await writeToLog(`Reward analysis for ${govLstAddress}: ${JSON.stringify(analysis, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)}`);
        } catch (error) {
          await writeToErrorLog(error, `Failed to analyze rewards for ${govLstAddress}`);
        }
      }

      // Process one round of claims
      await govLstClaimer.processClaimableRewards();
      await writeToLog('Processed claimable rewards');

      // Get updated status
      const updatedStatus = await govLstClaimer.getStatus();
      await writeToLog(`Updated GovLst Claimer Status: ${JSON.stringify(updatedStatus, null, 2)}`);

      // Stop claimer
      await govLstClaimer.stop();
      await writeToLog('GovLst Claimer stopped successfully');
    } else {
      await writeToLog('No deposits found after waiting, skipping GovLst claimer initialization');
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
    await writeToErrorLog(error, 'Monitor+GovLst integrated test failed');
    return {
      success: false,
      error
    };
  }
}

// Run the test
testMonitorGovLst()
  .then(result => {
    if (result.success) {
      writeToLog(`Monitor+GovLst integrated test completed successfully. Found deposits: ${result.hasDeposits}`);
    } else {
      writeToLog(`Monitor+GovLst integrated test failed: ${result.error}`, ERROR_LOG);
    }
  })
  .catch(error => writeToErrorLog(error, 'Uncaught error in Monitor+GovLst integrated test'));
