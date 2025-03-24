// Set environment variable to force 'json' database type for tests
process.env.DATABASE_TYPE = 'json';
process.env.DB = 'json';
// Disable Supabase for tests
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';

import { ConsoleLogger } from '../monitor/logging';
import { StakerMonitor } from '../monitor/StakerMonitor';
import { createMonitorConfig } from '../monitor/constants';
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
const monitorLogger = new ConsoleLogger('info', {
  color: '\x1b[34m', // Blue
  prefix: '[Monitor Test]',
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

async function testMonitor() {
  try {
    await writeToLog('Starting Monitor component test');

    // Create provider
    const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);

    // Create database - use DatabaseWrapper with json config
    const database = new DatabaseWrapper({
      type: 'json',
      jsonDbPath: TEST_DB_PATH
    });

    await writeToLog('Initialized provider and database');

    // Create and start monitor
    const monitor = new StakerMonitor(createMonitorConfig(provider, database));
    await monitor.start();

    await writeToLog('Monitor started successfully');

    // Wait for some time to get blocks
    await writeToLog('Waiting for block processing...');
    await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds

    // Get monitor status
    const status = await monitor.getMonitorStatus();
    await writeToLog(`Monitor Status: ${JSON.stringify(status, null, 2)}`);

    // Stop monitor
    await monitor.stop();
    await writeToLog('Monitor stopped successfully');

    // Get deposits from database
    const deposits = await database.getAllDeposits();
    await writeToLog(`Total deposits found: ${deposits.length}`);

    return {
      success: true,
      deposits,
      status
    };
  } catch (error) {
    await writeToErrorLog(error, 'Monitor test failed');
    return {
      success: false,
      error
    };
  }
}

// Run the test
testMonitor()
  .then(result => {
    if (result.success) {
      writeToLog(`Monitor test completed successfully with ${result.deposits?.length || 0} deposits`);
    } else {
      writeToLog(`Monitor test failed: ${result.error}`, ERROR_LOG);
    }
  })
  .catch(error => writeToErrorLog(error, 'Uncaught error in monitor test'));
