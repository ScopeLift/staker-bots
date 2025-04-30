import { ethers } from 'ethers';
import { ExecutorWrapper, ExecutorType } from '../executor';
import { ConsoleLogger, Logger } from '../monitor/logging';
import { TransactionStatus } from '../executor/interfaces/types';
import fs from 'fs';
import { CONFIG } from '../config';

const logger: Logger = new ConsoleLogger('info');

async function main() {
  logger.info('Starting executor test...');

  // Initialize provider
  logger.info('Initializing provider...');
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const network = await provider.getNetwork();
  logger.info('Connected to network:', {
    chainId: network.chainId,
    name: network.name,
  });

  // Initialize staker contract
  logger.info('Initializing staker contract...');
  const stakerAddress = CONFIG.monitor.stakerAddress;
  const stakerAbi = JSON.parse(
    fs.readFileSync('./src/tests/abis/staker.json', 'utf-8'),
  );
  const stakerContract = new ethers.Contract(
    stakerAddress!,
    stakerAbi,
    provider,
  );
  logger.info('Staker contract initialized at:', { address: stakerAddress });

  const executor = new ExecutorWrapper(
    stakerContract,
    provider,
    ExecutorType.WALLET,
    {
      wallet: {
        privateKey: CONFIG.executor.privateKey,
        minBalance: ethers.parseEther('0.0000001'), // 0.1 ETH
        maxPendingTransactions: 2,
      },
      maxQueueSize: 5,
      minConfirmations: 1,
      maxRetries: 2,
      retryDelayMs: 2000,
      transferOutThreshold: ethers.parseEther('0.5'), // 0.5 ETH
      gasBoostPercentage: 5,
      concurrentTransactions: 2,
    },
  );

  // Start executor
  await executor.start();
  logger.info('Executor started');

  // Test 1: Check initial status
  logger.info('\nTest 1: Checking initial status...');
  const initialStatus = await executor.getStatus();
  logger.info('Initial status:', {
    isRunning: initialStatus.isRunning,
    walletBalance: ethers.formatEther(initialStatus.walletBalance),
    pendingTransactions: initialStatus.pendingTransactions,
    queueSize: initialStatus.queueSize,
  });

  // Test 2: Queue a transaction
  logger.info('\nTest 2: Queueing a transaction...');
  const mockProfitability = {
    canBump: true,
    constraints: {
      calculatorEligible: true,
      hasEnoughRewards: true,
      isProfitable: true,
    },
    estimates: {
      optimalTip: ethers.parseEther('0.01'), // 0.01 ETH
      gasEstimate: BigInt(100000),
      expectedProfit: ethers.parseEther('0.005'), // 0.005 ETH
      tipReceiver: process.env.TIP_RECEIVER || ethers.ZeroAddress,
    },
  };

  const queuedTx = await executor.queueTransaction(
    BigInt(1),
    mockProfitability,
  );
  logger.info('Transaction queued:', {
    id: queuedTx.id,
    status: queuedTx.status,
  });

  // Test 3: Check queue stats
  logger.info('\nTest 3: Checking queue stats...');
  const queueStats = await executor.getQueueStats();
  logger.info('Queue stats:', {
    totalQueued: queueStats.totalQueued,
    totalPending: queueStats.totalPending,
    totalConfirmed: queueStats.totalConfirmed,
    totalFailed: queueStats.totalFailed,
  });

  // Test 4: Monitor transaction status
  logger.info('\nTest 4: Monitoring transaction status...');
  let tx = await executor.getTransaction(queuedTx.id);
  let attempts = 0;
  const maxAttempts = 30;

  while (
    tx &&
    tx.status !== TransactionStatus.CONFIRMED &&
    tx.status !== TransactionStatus.FAILED &&
    attempts < maxAttempts
  ) {
    logger.info('Current transaction status:', {
      id: tx.id,
      status: tx.status,
      hash: tx.hash,
    });

    if (tx.hash) {
      const receipt = await executor.getTransactionReceipt(tx.hash);
      if (receipt) {
        logger.info('Transaction receipt:', {
          status: receipt.status,
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: ethers.formatEther(receipt.effectiveGasPrice),
        });
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds
    tx = await executor.getTransaction(queuedTx.id);
    attempts++;
  }

  if (attempts >= maxAttempts) {
    logger.warn('Transaction monitoring timed out');
  }

  // Test 5: Check final transaction state
  logger.info('\nTest 5: Checking final transaction state...');
  const finalTx = await executor.getTransaction(queuedTx.id);
  if (finalTx) {
    logger.info('Final transaction state:', {
      id: finalTx.id,
      status: finalTx.status,
      hash: finalTx.hash,
      error: finalTx.error?.message,
    });
  }

  // Test 6: Test queue limits
  logger.info('\nTest 6: Testing queue limits...');
  try {
    for (let i = 0; i < 10; i++) {
      await executor.queueTransaction(BigInt(i + 2), mockProfitability);
    }
  } catch (error) {
    logger.info('Queue limit reached as expected:', {
      error: (error as Error).message,
    });
  }

  // Test 7: Clear queue
  logger.info('\nTest 7: Clearing queue...');
  await executor.clearQueue();
  const finalStats = await executor.getQueueStats();
  logger.info('Final queue stats:', {
    totalQueued: finalStats.totalQueued,
    totalPending: finalStats.totalPending,
    totalConfirmed: finalStats.totalConfirmed,
    totalFailed: finalStats.totalFailed,
  });

  // Stop executor
  await executor.stop();
  logger.info('\nExecutor stopped');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Error:', { error: error as Error });
    process.exit(1);
  });
