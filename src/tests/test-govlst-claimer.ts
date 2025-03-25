// Set environment variable to force 'json' database type for tests
process.env.DATABASE_TYPE = 'json';
process.env.DB = 'json';
// Disable Supabase for tests
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';

import { ConsoleLogger } from '../monitor/logging';
import { GovLstClaimerWrapper } from '../govlst-claimer/GovLstClaimerWrapper';
import { DatabaseWrapper } from '../database';
import { CONFIG } from '../config';
import { ethers } from 'ethers';
import fs from 'fs/promises';
import path from 'path';

// Configuration
const OUTPUT_LOG = path.join(process.cwd(), 'output.log');
const ERROR_LOG = path.join(process.cwd(), 'errors.log');
const TEST_DB_PATH = path.join(process.cwd(), 'staker-monitor-db.json');

// Setup logging
const logger = new ConsoleLogger('info');
const govLstLogger = new ConsoleLogger('info', {
  color: '\x1b[32m', // Green
  prefix: '[GovLst Test]',
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

async function testGovLstClaimer() {
  try {
    await writeToLog('Starting GovLst Claimer component test');

    // Create provider
    const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);

    // Create database - use DatabaseWrapper with json config
    const database = new DatabaseWrapper({
      type: 'json',
      jsonDbPath: TEST_DB_PATH
    });

    await writeToLog('Initialized provider and database');

    // Add a mock executor for this test
    const mockExecutor = {
      queueTransaction: async (depositId: bigint, profitabilityCheck: any, txData: string) => {
        await writeToLog(`Mock executor received transaction request for depositId: ${depositId}, data: ${txData}`);
        return { id: '12345', depositId, status: 'QUEUED' };
      }
    } as any;

    // Create GovLst claimer
    const govLstClaimer = new GovLstClaimerWrapper(
      database,
      provider,
      mockExecutor,
      CONFIG.govlst
    );

    await writeToLog('GovLst Claimer created successfully');

    // Start the claimer
    await govLstClaimer.start();
    await writeToLog('GovLst Claimer started successfully');

    // Wait for claimer to initialize
    await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds

    // Get claimer status
    const status = await govLstClaimer.getStatus();
    await writeToLog(`GovLst Claimer Status: ${JSON.stringify(status, null, 2)}`);

    // Analyze rewards for each GovLst address
    for (const govLstAddress of CONFIG.govlst.addresses!) {
      try {
        await writeToLog(`Analyzing rewards for GovLst address: ${govLstAddress}`);
        const analysis = await govLstClaimer.analyzeRewards(govLstAddress);
        await writeToLog(`Reward analysis for ${govLstAddress}: ${JSON.stringify(analysis, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)}`);
      } catch (error) {
        await writeToErrorLog(error, `Failed to analyze rewards for ${govLstAddress}`);
      }
    }

    // Process all claimable rewards
    await govLstClaimer.processClaimableRewards();
    await writeToLog('Processed all claimable rewards');

    // Wait for processing to complete
    await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds

    // Get updated status
    const updatedStatus = await govLstClaimer.getStatus();
    await writeToLog(`Updated GovLst Claimer Status: ${JSON.stringify(updatedStatus, null, 2)}`);

    // Stop claimer
    await govLstClaimer.stop();
    await writeToLog('GovLst Claimer stopped successfully');

    // Get GovLst deposit data from database
    const govLstDeposits = await Promise.all(
      CONFIG.govlst.addresses?.map(async (address) => {
        try {
          return await database.getDepositsByOwner(address);
        } catch (error) {
          await writeToErrorLog(error, `Failed to get deposits for ${address}`);
          return [];
        }
      })
    ).then(results => results.flat());

    await writeToLog(`Found ${govLstDeposits.length} GovLst deposits in total`);

    return {
      success: true,
      govLstDeposits,
      status: updatedStatus
    };
  } catch (error) {
    await writeToErrorLog(error, 'GovLst Claimer test failed');
    return {
      success: false,
      error
    };
  }
}

// Run the test
testGovLstClaimer()
  .then(result => {
    if (result.success) {
      writeToLog(`GovLst Claimer test completed successfully with ${result.govLstDeposits?.length || 0} deposits`);
    } else {
      writeToLog(`GovLst Claimer test failed: ${result.error}`, ERROR_LOG);
    }
  })
  .catch(error => writeToErrorLog(error, 'Uncaught error in GovLst Claimer test'));
