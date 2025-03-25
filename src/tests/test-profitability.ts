import { ethers } from 'ethers';
import { BinaryEligibilityOracleEarningPowerCalculator } from '../calculator';
import { BaseProfitabilityEngine } from '../profitability/strategies/BaseProfitabilityEngine';
import {
  ProfitabilityConfig,
  Deposit as ProfitabilityDeposit,
  ProfitabilityCheck,
  BatchAnalysis,
} from '../profitability/interfaces/types';
import { IDatabase } from '../database';
import { ConsoleLogger, Logger } from '../monitor/logging';
import fs from 'fs';
import 'dotenv/config';
import { Deposit } from '../database/interfaces/types';
import { CoinMarketCapFeed } from '../shared/price-feeds/coinmarketcap/CoinMarketCapFeed';
import { CONFIG } from '../config';

// Define database deposit type
interface DatabaseDeposit {
  deposit_id: string;
  amount: string;
  earning_power?: string;
  owner_address: string;
  delegatee_address: string;
}

interface DatabaseContent {
  deposits: Record<string, DatabaseDeposit>;
}

// Create logger instance
const logger: Logger = new ConsoleLogger('info');

// Mock database adapter for testing
class MockDatabase implements IDatabase {
  async createScoreEvent() {
    return;
  }
  async getLatestScoreEvent() {
    return null;
  }
  async getScoreEventsByBlockRange() {
    return [];
  }
  async updateCheckpoint() {
    return;
  }
  async createDeposit() {
    return;
  }
  async getDeposit() {
    return null;
  }
  async getDepositsByDelegatee() {
    return [];
  }
  async updateDeposit() {
    return;
  }
  async updateScoreEvent() {
    return;
  }
  async deleteScoreEvent() {
    return;
  }
  async deleteScoreEventsByBlockRange() {
    return;
  }
  async getScoreEvent() {
    return null;
  }
  async getCheckpoint() {
    return null;
  }
  async getAllDeposits(): Promise<Deposit[]> {
    return [];
  }
}

async function main() {
  logger.info('Starting profitability test...');

  // Load database
  logger.info('Loading staker-monitor database...');
  const dbPath = './staker-monitor-db.json';
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8')) as DatabaseContent;

  // Convert deposits to the correct format
  logger.info('Converting deposits to the correct format...');
  const deposits = Object.values(db.deposits).map(
    (deposit: DatabaseDeposit) => {
      logger.info(`Processing deposit ${deposit.deposit_id}:`, {
        amount: deposit.amount,
        earning_power: deposit.earning_power || '0',
        owner: deposit.owner_address,
        delegatee: deposit.delegatee_address,
      });
      return {
        deposit_id: BigInt(deposit.deposit_id),
        amount: BigInt(deposit.amount),
        earning_power: deposit.earning_power
          ? BigInt(deposit.earning_power)
          : BigInt(0),
        owner_address: deposit.owner_address,
        delegatee_address: deposit.delegatee_address,
      } satisfies ProfitabilityDeposit;
    },
  );
  logger.info(`Loaded ${deposits.length} deposits from database`);

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
  const stakerAddress = process.env.STAKER_CONTRACT_ADDRESS;
  const stakerAbi = JSON.parse(
    fs.readFileSync('./src/tests/abis/staker.json', 'utf-8'),
  );
  const stakerContract = new ethers.Contract(
    stakerAddress!,
    stakerAbi,
    provider,
  );
  logger.info('Staker contract initialized at:', { address: stakerAddress });

  // Test contract read functions
  logger.info('Testing contract read functions...');
  try {
    const typedContract = stakerContract as ethers.Contract & {
      deposits(depositId: bigint): Promise<{
        owner: string;
        balance: bigint;
        earningPower: bigint;
        delegatee: string;
        claimer: string;
      }>;
      unclaimedReward(depositId: bigint): Promise<bigint>;
      maxBumpTip(): Promise<bigint>;
      bumpEarningPower(
        depositId: bigint,
        tipReceiver: string,
        tip: bigint,
      ): Promise<bigint>;
    };

    const maxBumpTip = await typedContract.maxBumpTip();
    logger.info('Max bump tip:', {
      value: `${ethers.formatEther(maxBumpTip)} ETH`,
    });

    // Test reading first deposit
    const firstDeposit = deposits[0];
    if (firstDeposit) {
      const depositInfo = await typedContract.deposits(firstDeposit.deposit_id);
      logger.info('First deposit info:', {
        id: firstDeposit.deposit_id.toString(),
        owner: depositInfo.owner,
        balance: ethers.formatEther(depositInfo.balance),
        earningPower: ethers.formatEther(depositInfo.earningPower),
        delegatee: depositInfo.delegatee,
      });

      const unclaimedReward = await typedContract.unclaimedReward(
        firstDeposit.deposit_id,
      );
      logger.info('Unclaimed reward:', {
        value: `${ethers.formatEther(unclaimedReward)} ETH`,
      });
    }
  } catch (error) {
    logger.error('Error testing contract read functions:', {
      error: error as Error,
    });
    throw error;
  }

  // Initialize calculator
  logger.info('Initializing calculator...');
  const calculator = new BinaryEligibilityOracleEarningPowerCalculator(
    new MockDatabase(),
    provider,
  );

  // Initialize price feed
  const priceFeed = new CoinMarketCapFeed(
    {
      ...CONFIG.priceFeed.coinmarketcap,
      arbTestTokenAddress: CONFIG.monitor.arbTestTokenAddress,
      arbRealTokenAddress: CONFIG.monitor.arbRealTokenAddress,
    },
    logger,
  );

  // Define typed contract for better type safety
  const typedContract = stakerContract as ethers.Contract & {
    deposits(depositId: bigint): Promise<{
      owner: string;
      balance: bigint;
      earningPower: bigint;
      delegatee: string;
      claimer: string;
    }>;
    unclaimedReward(depositId: bigint): Promise<bigint>;
    maxBumpTip(): Promise<bigint>;
    bumpEarningPower(
      depositId: bigint,
      tipReceiver: string,
      tip: bigint,
    ): Promise<bigint>;
    REWARD_TOKEN(): Promise<string>;
  };

  // Configure profitability engine
  logger.info('Configuring profitability engine...');
  const rewardTokenAddress = await typedContract.REWARD_TOKEN();
  const config: ProfitabilityConfig = {
    minProfitMargin: BigInt(1e16), // 0.01 ETH
    gasPriceBuffer: 20, // 20%
    maxBatchSize: 10,
    defaultTipReceiver: process.env.TIP_RECEIVER || ethers.ZeroAddress,
    rewardTokenAddress,
    priceFeed: {
      cacheDuration: 10 * 60 * 1000, // 10 minutes
    },
  };

  logger.info('Profitability config:', {
    minProfitMargin: ethers.formatEther(config.minProfitMargin),
    gasPriceBuffer: config.gasPriceBuffer,
    maxBatchSize: config.maxBatchSize,
    tipReceiver: config.defaultTipReceiver,
  });

  // Initialize profitability engine
  logger.info('Initializing profitability engine...');
  const profitabilityEngine = new BaseProfitabilityEngine(
    calculator,
    typedContract,
    provider,
    config,
    priceFeed,
  );

  // Start the engine
  await profitabilityEngine.start();
  logger.info('Profitability engine started');

  logger.info(`\nAnalyzing ${deposits.length} deposits for profitability...`);
  try {
    // Create an array to store the successfully analyzed deposits
    const results: { depositId: bigint; profitability: ProfitabilityCheck }[] =
      [];
    let totalGasEstimate = BigInt(0);
    let totalExpectedProfit = BigInt(0);

    // Process each deposit individually to avoid failing the entire batch
    for (const deposit of deposits) {
      try {
        const profitability =
          await profitabilityEngine.checkProfitability(deposit);
        results.push({ depositId: deposit.deposit_id, profitability });

        // Add to totals if profitable
        if (profitability.canBump) {
          totalGasEstimate += profitability.estimates.gasEstimate;
          totalExpectedProfit += profitability.estimates.expectedProfit;
        }
      } catch (error) {
        logger.warn(`Error analyzing deposit ${deposit.deposit_id}:`, {
          error: error instanceof Error ? error.message : String(error),
        });

        // Add a failed result to keep track of all deposits
        results.push({
          depositId: deposit.deposit_id,
          profitability: {
            canBump: false,
            constraints: {
              calculatorEligible: false,
              hasEnoughRewards: false,
              isProfitable: false,
            },
            estimates: {
              optimalTip: BigInt(0),
              gasEstimate: BigInt(0),
              expectedProfit: BigInt(0),
              tipReceiver: config.defaultTipReceiver,
            },
          },
        });
      }
    }

    // Create a batch analysis result manually
    const batchAnalysis: BatchAnalysis = {
      deposits: results,
      totalGasEstimate,
      totalExpectedProfit,
      recommendedBatchSize: Math.min(
        results.filter((r) => r.profitability.canBump).length,
        config.maxBatchSize,
      ),
    };

    // Print results
    logger.info('\nBatch Analysis Results:');
    logger.info('------------------------');
    logger.info(
      `Total Gas Estimate: ${ethers.formatEther(batchAnalysis.totalGasEstimate)} ETH`,
    );
    logger.info(
      `Total Expected Profit: ${ethers.formatEther(
        batchAnalysis.totalExpectedProfit,
      )} ETH`,
    );
    logger.info(
      `Recommended Batch Size: ${batchAnalysis.recommendedBatchSize}`,
    );

    logger.info('\nDeposit Results:');
    logger.info('----------------');
    batchAnalysis.deposits.forEach((result) => {
      logger.info(`\nDeposit ID: ${result.depositId}`);
      logger.info(`Can Bump: ${result.profitability.canBump}`);
      logger.info('Constraints:', {
        constraints: result.profitability.constraints,
      });
      if (result.profitability.canBump) {
        logger.info(
          `Optimal Tip: ${ethers.formatEther(
            result.profitability.estimates.optimalTip,
          )} ETH`,
        );
        logger.info(
          `Gas Estimate: ${ethers.formatEther(
            result.profitability.estimates.gasEstimate,
          )} ETH`,
        );
        logger.info(
          `Expected Profit: ${ethers.formatEther(
            result.profitability.estimates.expectedProfit,
          )} ETH`,
        );
      }
    });
  } catch (error) {
    logger.error('Error during profitability analysis:', {
      error: error as Error,
    });
    throw error;
  }

  // Stop the engine
  await profitabilityEngine.stop();
  logger.info('\nProfitability engine stopped');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Error:', { error: error as Error });
    process.exit(1);
  });
