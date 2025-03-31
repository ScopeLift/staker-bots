import { ethers } from 'ethers'
import { DatabaseWrapper } from '@/database'
import { ConsoleLogger } from '@/monitor/logging'
import { GovLstProfitabilityEngineWrapper } from '@/profitability'
import { ExecutorWrapper, ExecutorType } from '@/executor'
import { CONFIG } from '@/config'
import { CoinMarketCapFeed } from '@/shared/price-feeds/coinmarketcap/CoinMarketCapFeed'
import { IExecutor } from '@/executor/interfaces/IExecutor'
import { govlst } from '@/constants'
import stakerAbi from '../abis/staker.json'
import { TransactionQueueStatus, ProcessingQueueStatus } from '@/database/interfaces/types'
import { GovLstProfitabilityCheck } from '@/profitability/interfaces/types'
import fs from 'fs/promises'

// Helper function to serialize BigInt values
function serializeBigInt(obj: any): any {
  if (typeof obj === 'bigint') {
    return obj.toString();
  } else if (Array.isArray(obj)) {
    return obj.map(serializeBigInt);
  } else if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const key in obj) {
      result[key] = serializeBigInt(obj[key]);
    }
    return result;
  }
  return obj;
}

async function main() {
  console.log('Starting profitability-executor integration test...', process.env.EXECUTOR_TYPE);

  // Initialize database
  const database = new DatabaseWrapper({
    type: 'json',
  });
  console.log('Using database at', process.cwd() + '/staker-monitor-db.json', process.env.EXECUTOR_TYPE);

  // Initialize provider
  console.log('Initializing provider...');
  const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);
  const network = await provider.getNetwork();
  console.log('Connected to network:', {
    chainId: network.chainId,
    name: network.name,
  });

  // Initialize Staker contract
  console.log('Initializing Staker contract...');
  const stakerContract = new ethers.Contract(
    '0xdFAa0c8116bAFc8a9F474DFa6A5a28dB0BbCF556',
    stakerAbi,
    provider
  ) as ethers.Contract & {
    unclaimedReward(depositId: string): Promise<bigint>;
  };
  console.log('Staker contract initialized at:', { address: stakerContract.target });

  // Initialize GovLst contract
  console.log('Initializing GovLst contract...');
  const govLstContract = new ethers.Contract(
    '0x6fbb31f8c459d773a8d0f67c8c055a70d943c1f1',
    govlst,
    provider
  );
  console.log('GovLst contract initialized at:', { address: govLstContract.target });

  // Initialize LST contract
  console.log('Initializing LST contract...');
  const lstContract = new ethers.Contract(
    CONFIG.monitor.lstAddress,
    govlst,
    provider
  );
  console.log('LST contract initialized at:', { address: lstContract.target });

  // Initialize executor
  console.log('Initializing executor...');
  const executorType = process.env.EXECUTOR_TYPE?.toLowerCase() || 'wallet';

  if (!['wallet', 'relayer'].includes(executorType)) {
    throw new Error(`Invalid executor type: ${executorType}. Must be 'wallet' or 'relayer'`);
  }

  const executorConfig = executorType === 'relayer' ? {
    apiKey: process.env.DEFENDER_API_KEY || '',
    apiSecret: process.env.DEFENDER_SECRET_KEY || '',
    address: process.env.PUBLIC_ADDRESS_DEFENDER || '',
    minBalance: BigInt(0),
    maxPendingTransactions: 5,
    maxQueueSize: 100,
    minConfirmations: 2,
    maxRetries: 3,
    retryDelayMs: 5000,
    transferOutThreshold: BigInt(0),
    gasBoostPercentage: 30,
    concurrentTransactions: 3,
    gasPolicy: {
      maxFeePerGas: BigInt(0),
      maxPriorityFeePerGas: BigInt(0)
    }
  } : {
    wallet: {
      privateKey: CONFIG.executor.privateKey,
      minBalance: ethers.parseEther('0.01'),
      maxPendingTransactions: 5,
    },
    defaultTipReceiver: CONFIG.executor.tipReceiver,
  };

  const executor = new ExecutorWrapper(
    lstContract, // Pass LST contract instead of Staker contract
    provider,
    executorType === 'relayer' ? ExecutorType.RELAYER : ExecutorType.WALLET,
    executorConfig,
    database
  );

  // Initialize profitability engine
  console.log('Initializing profitability engine...');
  const priceFeed = new CoinMarketCapFeed(
    {
      apiKey: CONFIG.priceFeed.coinmarketcap.apiKey,
      baseUrl: CONFIG.priceFeed.coinmarketcap.baseUrl,
      timeout: CONFIG.priceFeed.coinmarketcap.timeout
    },
    new ConsoleLogger('info')
  );

  const profitabilityEngine = new GovLstProfitabilityEngineWrapper(
    database,
    govLstContract,
    stakerContract,
    provider,
    new ConsoleLogger('info'),
    priceFeed,
    {
      minProfitMargin: CONFIG.govlst.minProfitMargin,
      gasPriceBuffer: CONFIG.govlst.gasPriceBuffer,
      maxBatchSize: CONFIG.govlst.maxBatchSize,
      rewardTokenAddress: '0x6fbb31f8c459d773a8d0f67c8c055a70d943c1f1',
      defaultTipReceiver: CONFIG.executor.tipReceiver || ethers.ZeroAddress,
      priceFeed: {
        cacheDuration: CONFIG.profitability.priceFeed.cacheDuration,
      },
    },
    executor as IExecutor
  );

  // Start components
  await executor.start();
  console.log('Executor started');

  await profitabilityEngine.start();
  console.log('Profitability engine started');

  // Add test deposits to database
  const deposits = [
    {
      deposit_id: '1',
      owner_address: '0x6Fbb31f8c459d773A8d0f67C8C055a70d943C1F1',
      depositor_address: '0x6Fbb31f8c459d773A8d0f67C8C055a70d943C1F1',
      delegatee_address: '0x0000000000000000000000000000000000000B01',
      amount: '19200000000000000000000',
      block_number: 7876306,
      transaction_hash: '0x123',
    },
    {
      deposit_id: '2',
      owner_address: '0x6Fbb31f8c459d773A8d0f67C8C055a70d943C1F1',
      depositor_address: '0x0872Dc5D4D11822bb57206c67A65A6d9405f8bcC',
      delegatee_address: '0x98457E13DDFFD3DbA645688EDBf3a159359b730d',
      amount: '75436044328372155512382',
      block_number: 7876306,
      transaction_hash: '0x456',
    },
    {
      deposit_id: '3',
      owner_address: '0x6Fbb31f8c459d773A8d0f67C8C055a70d943C1F1',
      depositor_address: '0x0872Dc5D4D11822bb57206c67A65A6d9405f8bcC',
      delegatee_address: '0x98457E13DDFFD3DbA645688EDBf3a159359b730d',
      amount: '0',
      block_number: 7876306,
      transaction_hash: '0x789',
    },
  ];

  console.log(`Found ${deposits.length} deposits to analyze`);

  // First, add all deposits to the database
  for (const deposit of deposits) {
    console.log('Adding deposit to database', deposit.deposit_id, {
      owner: deposit.owner_address,
      depositor: deposit.depositor_address,
      delegatee: deposit.delegatee_address,
      amount: deposit.amount,
    });

    await database.createDeposit({
      deposit_id: deposit.deposit_id,
      owner_address: deposit.owner_address,
      depositor_address: deposit.depositor_address,
      delegatee_address: deposit.delegatee_address,
      amount: deposit.amount.toString(),
    });
  }

  // Then process all deposits together
  const profitableDeposits = [];
  const depositDetails = [];

  for (const deposit of deposits) {
    const unclaimedRewards = await stakerContract.unclaimedReward(deposit.deposit_id);
    console.log(`Unclaimed rewards for deposit ${deposit.deposit_id}:`, {
      depositId: deposit.deposit_id,
      rewards: unclaimedRewards.toString(),
      owner: deposit.owner_address,
      depositor: deposit.depositor_address,
    });

    if (unclaimedRewards > 0n) {
      profitableDeposits.push(deposit);
      depositDetails.push({
        depositId: BigInt(deposit.deposit_id),
        rewards: unclaimedRewards
      });
    }
  }

  if (profitableDeposits.length > 0) {
    // Calculate total rewards and shares
    const totalRewards = depositDetails.reduce((sum, detail) => sum + detail.rewards, 0n);
    const totalShares = profitableDeposits.reduce((sum, deposit) => sum + BigInt(deposit.amount), 0n);
    const gasEstimate = BigInt(300000); // Default gas estimate

    // Create profitability check object for all deposits
    const profitabilityCheck: GovLstProfitabilityCheck = {
      is_profitable: true,
      constraints: {
        has_enough_shares: true,
        meets_min_reward: true,
        meets_min_profit: true
      },
      estimates: {
        expected_profit: totalRewards,
        gas_estimate: gasEstimate,
        total_shares: totalShares,
        payout_amount: totalRewards
      },
      deposit_details: depositDetails
    };

    // Add all deposits to processing queue
    for (const deposit of profitableDeposits) {
      await database.createProcessingQueueItem({
        deposit_id: deposit.deposit_id,
        status: ProcessingQueueStatus.PENDING,
        delegatee: deposit.delegatee_address || '',
      });
    }

    // Create a single transaction queue item for all deposits
    const txQueueItem = await database.createTransactionQueueItem({
      deposit_id: profitableDeposits.map(d => d.deposit_id).join(','),
      status: TransactionQueueStatus.PENDING,
      tx_data: JSON.stringify({
        depositIds: profitableDeposits.map(d => d.deposit_id),
        totalRewards: totalRewards.toString(),
        profitability: serializeBigInt(profitabilityCheck)
      }),
    });

    // Queue a single transaction with executor for all deposits
    await executor.queueTransaction(
      profitableDeposits.map(d => BigInt(d.deposit_id)),
      profitabilityCheck,
      JSON.stringify({
        depositIds: profitableDeposits.map(d => d.deposit_id),
        totalRewards: totalRewards.toString(),
        profitability: serializeBigInt(profitabilityCheck),
        queueItemId: txQueueItem.id
      })
    );

    console.log('Queued batch transaction for deposits:', {
      depositIds: profitableDeposits.map(d => d.deposit_id),
      totalRewards: ethers.formatEther(totalRewards),
      gasEstimate: gasEstimate.toString()
    });
  }

  // Wait for transactions to complete
  console.log('Waiting for transactions to complete...');
  await new Promise((resolve) => setTimeout(resolve, 30000)); // Wait 30 seconds

  // Get final queue stats
  const queueStats = await executor.getQueueStats();
  console.log('Final queue stats:', {
    totalConfirmed: queueStats.totalConfirmed,
    totalFailed: queueStats.totalFailed,
    totalPending: queueStats.totalPending,
    totalQueued: queueStats.totalQueued,
    averageGasPrice: ethers.formatUnits(queueStats.averageGasPrice, 'gwei'),
    totalProfits: ethers.formatEther(queueStats.totalProfits),
  });

  // Stop components
  await profitabilityEngine.stop();
  console.log('Profitability engine stopped');

  await executor.stop();
  console.log('Executor stopped');
}

// Run the test
main().catch(async (error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
