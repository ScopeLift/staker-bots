import { ICalculatorStrategy } from './interfaces/ICalculatorStrategy';
import { BinaryEligibilityOracleEarningPowerCalculator } from './strategies/BinaryEligibilityOracleEarningPowerCalculator';
import { CalculatorConfig, CalculatorStatus } from './interfaces/types';
import { IDatabase } from '@/database';
import { ethers } from 'ethers';
import { CONFIG } from '@/configuration';
import { ConsoleLogger } from '@/monitor/logging';

export class CalculatorWrapper implements ICalculatorStrategy {
  private strategy: ICalculatorStrategy;
  private isRunning: boolean;
  private lastProcessedBlock: number;
  private provider: ethers.Provider;
  private db: IDatabase;
  private logger: ConsoleLogger;
  private processingPromise?: Promise<void>;

  constructor(
    db: IDatabase,
    provider: ethers.Provider,
    config: CalculatorConfig = { type: 'binary' },
  ) {
    // Initialize with BinaryEligibilityOracleEarningPowerCalculator strategy by default
    this.strategy = new BinaryEligibilityOracleEarningPowerCalculator(
      db,
      provider,
    );
    this.isRunning = false;
    this.lastProcessedBlock = 0;
    this.provider = provider;
    this.db = db;
    this.logger = new ConsoleLogger('info');

    // Can extend here to support other calculator types
    if (config.type !== 'binary') {
      throw new Error(`Calculator type ${config.type} not supported`);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Calculator is already running');
      return;
    }

    // Set running status
    this.isRunning = true;

    // Initialize from checkpoint or start block
    const checkpoint = await this.db.getCheckpoint('calculator');
    if (checkpoint) {
      this.lastProcessedBlock = checkpoint.last_block_number;
    } else {
      this.lastProcessedBlock = CONFIG.monitor.startBlock;
      await this.db.updateCheckpoint({
        component_type: 'calculator',
        last_block_number: CONFIG.monitor.startBlock,
        block_hash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        last_update: new Date().toISOString(),
      });
    }

    // Start the processing loop in the background
    this.processingPromise = this.processLoop();
    
    this.logger.info('Calculator started with processing loop', {
      startBlock: this.lastProcessedBlock,
      pollInterval: CONFIG.monitor.pollInterval,
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    try {
      this.isRunning = false;
      if (this.processingPromise) {
        await this.processingPromise;
      }
      this.logger.info('Calculator stopped successfully');
    } catch (error) {
      this.logger.error('Error stopping calculator', { error });
      throw error;
    }
  }

  async getStatus(): Promise<CalculatorStatus> {
    return {
      isRunning: this.isRunning,
      lastProcessedBlock: this.lastProcessedBlock,
    };
  }

  async getEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string,
  ): Promise<bigint> {
    return this.strategy.getEarningPower(amountStaked, staker, delegatee);
  }

  async getNewEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string,
    oldEarningPower: bigint,
  ): Promise<[bigint, boolean]> {
    return this.strategy.getNewEarningPower(
      amountStaked,
      staker,
      delegatee,
      oldEarningPower,
    );
  }

  async processScoreEvents(fromBlock: number, toBlock: number): Promise<void> {
    await this.strategy.processScoreEvents(fromBlock, toBlock);
    this.lastProcessedBlock = toBlock;
  }

  /**
   * Main processing loop that continuously monitors for new blocks and processes score events.
   * Handles block range processing, checkpointing, and error recovery.
   */
  private async processLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const currentBlock = await this.provider.getBlockNumber();
        const targetBlock = currentBlock - CONFIG.monitor.confirmations;

        if (targetBlock <= this.lastProcessedBlock) {
          await new Promise((resolve) =>
            setTimeout(resolve, CONFIG.monitor.pollInterval * 1000),
          );
          continue;
        }

        const fromBlock = this.lastProcessedBlock + 1;
        const toBlock = Math.min(
          targetBlock,
          fromBlock + CONFIG.monitor.maxBlockRange - 1,
        );

        this.logger.info('Processing score events', {
          fromBlock,
          toBlock,
          contractAddress: CONFIG.monitor.rewardCalculatorAddress,
        });

        await this.strategy.processScoreEvents(fromBlock, toBlock);

        // Update checkpoint
        const block = await this.provider.getBlock(toBlock);
        if (!block) throw new Error(`Block ${toBlock} not found`);

        await this.db.updateCheckpoint({
          component_type: 'calculator',
          last_block_number: toBlock,
          block_hash: block.hash || '0x0000000000000000000000000000000000000000000000000000000000000000',
          last_update: new Date().toISOString(),
        });

        this.logger.info('Score events processed successfully', {
          fromBlock,
          toBlock,
          processedBlocks: toBlock - fromBlock + 1,
        });

        this.lastProcessedBlock = toBlock;
      } catch (error) {
        this.logger.error('Error in calculator processing loop', {
          error: error instanceof Error ? error.message : String(error),
          lastProcessedBlock: this.lastProcessedBlock,
        });
        
        // Wait before retrying
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.monitor.pollInterval * 1000),
        );
      }
    }
  }

  /**
   * Get the earning power calculator instance
   */
  getEarningPowerCalculator(): BinaryEligibilityOracleEarningPowerCalculator | null {
    return this.strategy instanceof
      BinaryEligibilityOracleEarningPowerCalculator
      ? this.strategy
      : null;
  }
}
