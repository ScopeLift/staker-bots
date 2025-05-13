import { ethers } from 'ethers';
import { DatabaseWrapper } from '@/database';
import { ConsoleLogger } from '@/monitor/logging';
import { GovLstProfitabilityEngineWrapper } from '@/profitability';
import { ExecutorWrapper } from '@/executor';
import { ExecutorType } from '@/executor/interfaces/types';
import { CONFIG } from '@/configuration';
import { IExecutor } from '@/executor/interfaces/IExecutor';
import { govlstAbi, stakerAbi } from '@/configuration/abis';
import {
  TransactionQueueStatus,
  ProcessingQueueStatus,
} from '@/database/interfaces/types';
import { GovLstProfitabilityCheck } from '@/profitability/interfaces/types';

// Test constants
const TEST_DEPOSITS = [
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

describe('GovLst Profitability Executor Integration', () => {
  let database: DatabaseWrapper;
  let provider: ethers.JsonRpcProvider;
  let stakerContract: ethers.Contract & {
    unclaimedReward(depositId: string): Promise<bigint>;
  };
  let govLstContract: ethers.Contract;
  let lstContract: ethers.Contract;
  let executor: ExecutorWrapper;
  let profitabilityEngine: GovLstProfitabilityEngineWrapper;
  let logger: ConsoleLogger;

  beforeAll(async () => {
    logger = new ConsoleLogger('info');

    // Initialize database
    database = new DatabaseWrapper({ type: 'json' });

    // Initialize provider
    provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);
    const network = await provider.getNetwork();
    expect(network.chainId).toBeGreaterThan(0);

    // Initialize contracts
    stakerContract = new ethers.Contract(
      '0xdFAa0c8116bAFc8a9F474DFa6A5a28dB0BbCF556',
      stakerAbi,
      provider,
    ) as typeof stakerContract;

    govLstContract = new ethers.Contract(
      '0x6fbb31f8c459d773a8d0f67c8c055a70d943c1f1',
      govlstAbi,
      provider,
    );

    lstContract = new ethers.Contract(
      CONFIG.monitor.lstAddress,
      govlstAbi,
      provider,
    );

    // Initialize executor
    const executorType = CONFIG.executor.executorType || 'wallet';
    const executorConfig =
      executorType === 'relayer'
        ? {
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
              maxPriorityFeePerGas: BigInt(0),
            },
          }
        : {
            wallet: {
              privateKey: CONFIG.executor.privateKey,
              minBalance: ethers.parseEther('0.01'),
              maxPendingTransactions: 5,
            },
            defaultTipReceiver: CONFIG.executor.tipReceiver,
          };

    executor = new ExecutorWrapper(
      lstContract,
      provider,
      executorType === 'relayer' ? ExecutorType.DEFENDER : ExecutorType.WALLET,
      executorConfig,
      database,
    );

    // Initialize profitability engine
    profitabilityEngine = new GovLstProfitabilityEngineWrapper(
      database,
      govLstContract,
      stakerContract,
      provider,
      logger,
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
      executor as IExecutor,
    );

    // Start components
    await executor.start();
    await profitabilityEngine.start();
  });

  afterAll(async () => {
    await profitabilityEngine.stop();
    await executor.stop();
  });

  beforeEach(async () => {
    // Reset database state by deleting all items
    const pendingItems = await database.getProcessingQueueItemsByStatus(
      ProcessingQueueStatus.PENDING,
    );
    for (const item of pendingItems) {
      if (item.id) {
        await database.deleteProcessingQueueItem(item.id);
      }
    }
    const queuedItems = await database.getTransactionQueueItemsByStatus(
      TransactionQueueStatus.PENDING,
    );
    for (const item of queuedItems) {
      if (item.id) {
        await database.deleteTransactionQueueItem(item.id);
      }
    }
  });

  describe('Deposit Processing', () => {
    it('should process multiple deposits and queue profitable transactions', async () => {
      // Add test deposits to database
      for (const deposit of TEST_DEPOSITS) {
        await database.createDeposit({
          deposit_id: deposit.deposit_id,
          owner_address: deposit.owner_address,
          depositor_address: deposit.depositor_address,
          delegatee_address: deposit.delegatee_address,
          amount: deposit.amount.toString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }

      // Process deposits and collect profitable ones
      const profitableDeposits = [];
      const depositDetails = [];

      for (const deposit of TEST_DEPOSITS) {
        const unclaimedRewards = await stakerContract.unclaimedReward(
          deposit.deposit_id,
        );

        if (unclaimedRewards > 0n) {
          profitableDeposits.push(deposit);
          depositDetails.push({
            depositId: BigInt(deposit.deposit_id),
            rewards: unclaimedRewards,
          });
        }
      }

      // Verify we found profitable deposits
      expect(profitableDeposits.length).toBeGreaterThan(0);

      if (profitableDeposits.length > 0) {
        // Calculate totals
        const totalRewards = depositDetails.reduce(
          (sum, detail) => sum + detail.rewards,
          0n,
        );
        const totalShares = profitableDeposits.reduce(
          (sum, deposit) => sum + BigInt(deposit.amount),
          0n,
        );
        const gasEstimate = BigInt(300000);

        // Create profitability check
        const profitabilityCheck: GovLstProfitabilityCheck = {
          is_profitable: true,
          constraints: {
            has_enough_shares: true,
            meets_min_reward: true,
            meets_min_profit: true,
          },
          estimates: {
            expected_profit: totalRewards,
            gas_estimate: gasEstimate,
            gas_cost: gasEstimate * 20n,
            total_shares: totalShares,
            payout_amount: totalRewards,
          },
          deposit_details: depositDetails,
        };

        // Add deposits to processing queue
        for (const deposit of profitableDeposits) {
          const queueItem = await database.createProcessingQueueItem({
            deposit_id: deposit.deposit_id,
            status: ProcessingQueueStatus.PENDING,
            delegatee: deposit.delegatee_address || '',
          });
          expect(queueItem.status).toBe(ProcessingQueueStatus.PENDING);
        }

        // Create transaction queue item
        const txQueueItem = await database.createTransactionQueueItem({
          deposit_id: profitableDeposits.map((d) => d.deposit_id).join(','),
          status: TransactionQueueStatus.PENDING,
          tx_data: JSON.stringify({
            depositIds: profitableDeposits.map((d) => d.deposit_id),
            totalRewards: totalRewards.toString(),
            profitability: profitabilityCheck,
          }),
        });
        expect(txQueueItem.status).toBe(TransactionQueueStatus.PENDING);

        // Queue transaction with executor
        await executor.queueTransaction(
          profitableDeposits.map((d) => BigInt(d.deposit_id)),
          profitabilityCheck,
          JSON.stringify({
            depositIds: profitableDeposits.map((d) => d.deposit_id),
            totalRewards: totalRewards.toString(),
            profitability: profitabilityCheck,
            queueItemId: txQueueItem.id,
          }),
        );

        // Wait for processing
        await new Promise((resolve) => setTimeout(resolve, 30000));

        // Verify queue stats
        const queueStats = await executor.getQueueStats();
        expect(queueStats.totalQueued).toBeGreaterThan(0);
        expect(
          queueStats.totalPending +
            queueStats.totalConfirmed +
            queueStats.totalFailed,
        ).toBe(queueStats.totalQueued);

        // Verify database state
        const processingItems = await database.getProcessingQueueItemsByStatus(
          ProcessingQueueStatus.PENDING,
        );
        expect(processingItems.length).toBe(profitableDeposits.length);

        const txItems = await database.getTransactionQueueItemsByStatus(
          TransactionQueueStatus.PENDING,
        );
        expect(txItems.length).toBeGreaterThan(0);
        expect(txItems[0]?.status).not.toBe(TransactionQueueStatus.PENDING);
      }
    }, 120000); // 2 minute timeout

    it('should handle deposits with no rewards', async () => {
      const noRewardDeposit = TEST_DEPOSITS[2];
      if (!noRewardDeposit) {
        throw new Error('Test deposit not found');
      }

      await database.createDeposit({
        deposit_id: noRewardDeposit.deposit_id,
        owner_address: noRewardDeposit.owner_address,
        depositor_address: noRewardDeposit.depositor_address,
        delegatee_address: noRewardDeposit.delegatee_address,
        amount: noRewardDeposit.amount,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const unclaimedRewards = await stakerContract.unclaimedReward(
        noRewardDeposit.deposit_id,
      );
      expect(unclaimedRewards).toBe(0n);

      const processingItems = await database.getProcessingQueueItemsByStatus(
        ProcessingQueueStatus.PENDING,
      );
      expect(processingItems.length).toBe(0);

      const txItems = await database.getTransactionQueueItemsByStatus(
        TransactionQueueStatus.PENDING,
      );
      expect(txItems.length).toBe(0);
    }, 30000);
  });
});
