// Set environment variable to force 'json' database type for tests
process.env.DATABASE_TYPE = 'json';
process.env.DB = 'json';
// Disable Supabase for tests
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';

import { ConsoleLogger } from '../monitor/logging';
import { ProfitabilityEngineWrapper } from '../profitability/ProfitabilityEngineWrapper';
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
const profitabilityLogger = new ConsoleLogger('info', {
  color: '\x1b[31m', // Red
  prefix: '[Profitability Test]',
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

async function testProfitability() {
  try {
    await writeToLog('Starting Profitability Engine component test');

    // Create provider
    const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);

    // Create database - use DatabaseWrapper with json config
    const database = new DatabaseWrapper({
      type: 'json',
      jsonDbPath: TEST_DB_PATH
    });

    await writeToLog('Initialized provider and database');

    // Create a mock executor
    const mockExecutor = {
      queueTransaction: async (depositId: bigint, profitabilityCheck: any) => {
        await writeToLog(`Mock executor received transaction request for depositId: ${depositId}, profitabilityCheck: ${JSON.stringify(profitabilityCheck, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
        return { id: '12345', depositId, status: 'QUEUED' };
      }
    } as any;

    // Create profitability engine
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
      }
    );

    await writeToLog('Profitability Engine created successfully');

    // Connect to executor
    profitabilityEngine.setExecutor(mockExecutor);

    // Start the engine
    await profitabilityEngine.start();
    await writeToLog('Profitability Engine started successfully');

    // Get deposits
    const deposits = await database.getAllDeposits();
    await writeToLog(`Found ${deposits.length} deposits in total`);

    if (deposits.length > 0) {
      const testDeposits = deposits.slice(0, Math.min(5, deposits.length));
      await writeToLog(`Testing profitability for ${testDeposits.length} deposits`);

      // Check individual deposit profitability
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

      // Analyze batch profitability
      if (testDeposits.length > 1) {
        try {
          await writeToLog('Analyzing batch profitability');
          // Convert deposits to the format expected by profitabilityEngine
          const convertedDeposits = testDeposits.map(deposit => ({
            ...deposit,
            deposit_id: BigInt(deposit.deposit_id),
            amount: BigInt(deposit.amount || '0')
          }));
          const batchAnalysis = await profitabilityEngine.analyzeBatchProfitability(convertedDeposits);
          await writeToLog(`Batch profitability result: ${JSON.stringify(batchAnalysis, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)}`);
        } catch (error) {
          await writeToErrorLog(error, 'Failed to analyze batch profitability');
        }
      }
    } else {
      await writeToLog('No deposits available for profitability testing');
    }

    // Get engine status
    const status = await profitabilityEngine.getStatus();
    await writeToLog(`Profitability Engine Status: ${JSON.stringify(status, null, 2)}`);

    // Get queue statistics
    const queueStats = await profitabilityEngine.getQueueStats();
    await writeToLog(`Queue Statistics: ${JSON.stringify(queueStats, null, 2)}`);

    // Stop engine
    await profitabilityEngine.stop();
    await writeToLog('Profitability Engine stopped successfully');

    return {
      success: true,
      depositCount: deposits.length,
      status,
      queueStats
    };
  } catch (error) {
    await writeToErrorLog(error, 'Profitability Engine test failed');
    return {
      success: false,
      error
    };
  }
}

// Run the test
testProfitability()
  .then(result => {
    if (result.success) {
      writeToLog('Profitability Engine test completed successfully');
    } else {
      writeToLog(`Profitability Engine test failed: ${result.error}`, ERROR_LOG);
    }
  })
  .catch(error => writeToErrorLog(error, 'Uncaught error in Profitability Engine test'));
