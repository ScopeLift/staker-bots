// Set environment variable to force 'json' database type for tests
process.env.DATABASE_TYPE = 'json';
process.env.DB = 'json';
// Disable Supabase for tests
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';

import { ConsoleLogger } from '../monitor/logging';
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
const TEST_DB_PATH = path.join(process.cwd(), 'staker-monitor-db.json');

// Setup logging
const logger = new ConsoleLogger('info');
const executorLogger = new ConsoleLogger('info', {
  color: '\x1b[35m', // Purple
  prefix: '[Executor Test]',
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

async function testExecutor() {
  try {
    await writeToLog('Starting Executor component test');

    // Create provider
    const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);

    // Create database
    const database = new DatabaseWrapper({
      type: 'json',
      jsonDbPath: TEST_DB_PATH
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

    // Create executor
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

    await writeToLog('Executor created successfully');

    // Start the executor
    await executor.start();
    await writeToLog('Executor started successfully');

    // Get executor status
    const status = await executor.getStatus();
    await writeToLog(`Executor Status: ${JSON.stringify(status, null, 2)}`);

    // Check wallet balance
    await writeToLog(`Wallet balance: ${status.walletBalance ? ethers.formatEther(status.walletBalance) : 'unknown'} ETH`);

    // Get queue statistics
    const queueStats = await executor.getQueueStats();
    await writeToLog(`Queue Statistics: ${JSON.stringify(queueStats, null, 2)}`);

    // Prepare a test transaction (only if we have sufficient balance)
    if (status.walletBalance && status.walletBalance > ethers.parseEther('0.02')) {
      try {
        await writeToLog('Queuing a test transaction');

        // Create sample profitability check
        const profitabilityCheck = {
          canBump: false, // Not a bump, but a test transaction
          constraints: {
            calculatorEligible: true,
            hasEnoughRewards: true,
            isProfitable: true,
          },
          estimates: {
            optimalTip: BigInt(0),
            gasEstimate: BigInt(200000),
            expectedProfit: BigInt(0),
            tipReceiver: CONFIG.executor.tipReceiver || ethers.ZeroAddress,
          },
        };

        // Queue dummy transaction - we're not actually executing it on the real network
        const transaction = await executor.queueTransaction(
          BigInt(999999), // Dummy deposit ID
          profitabilityCheck,
          JSON.stringify({ test: true, timestamp: Date.now() })
        );

        await writeToLog(`Transaction queued with ID: ${transaction.id}`);

        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds

        // Get transaction status
        const txStatus = await executor.getTransaction(transaction.id);
        await writeToLog(`Transaction status: ${JSON.stringify(txStatus, null, 2)}`);
      } catch (error) {
        await writeToErrorLog(error, 'Failed to queue test transaction');
      }
    } else {
      await writeToLog('Skipping test transaction due to insufficient balance');
    }

    // Stop executor
    await executor.stop();
    await writeToLog('Executor stopped successfully');

    return {
      success: true,
      status,
      queueStats
    };
  } catch (error) {
    await writeToErrorLog(error, 'Executor test failed');
    return {
      success: false,
      error
    };
  }
}

// Run the test
testExecutor()
  .then(result => {
    if (result.success) {
      writeToLog('Executor test completed successfully');
    } else {
      writeToLog(`Executor test failed: ${result.error}`, ERROR_LOG);
    }
  })
  .catch(error => writeToErrorLog(error, 'Uncaught error in Executor test'));
