import { ethers } from 'ethers';
import { IDatabase } from '@/database';
import { ConsoleLogger, Logger } from '@/monitor/logging';
import { CalculatorWrapper } from './CalculatorWrapper';
import { MonitorConfig } from '@/monitor/types';

export class Calculator {
  private readonly db: IDatabase;
  private readonly provider: ethers.Provider;
  private readonly logger: Logger;
  private readonly calculator: CalculatorWrapper;
  private readonly config: MonitorConfig;
  private isRunning: boolean;
  private processingPromise?: Promise<void>;
  private lastProcessedBlock: number;

  constructor(config: MonitorConfig) {
    this.config = config;
    this.db = config.database;
    this.provider = config.provider;
    this.logger = new ConsoleLogger(config.logLevel);
    this.calculator = new CalculatorWrapper(this.db, this.provider);
    this.isRunning = false;
    this.lastProcessedBlock = config.startBlock;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Calculator is already running');
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting Calculator', {
      network: this.config.networkName,
      chainId: this.config.chainId,
      rewardCalculatorAddress: this.config.rewardCalculatorAddress,
    });

    // Check for existing checkpoint first
    const checkpoint = await this.db.getCheckpoint('calculator');

    if (checkpoint) {
      this.lastProcessedBlock = checkpoint.last_block_number;
      this.logger.info('Resuming from checkpoint', {
        blockNumber: this.lastProcessedBlock,
        blockHash: checkpoint.block_hash,
        lastUpdate: checkpoint.last_update,
      });
    } else {
      // Initialize with start block if no checkpoint exists
      this.lastProcessedBlock = this.config.startBlock;
      await this.db.updateCheckpoint({
        component_type: 'calculator',
        last_block_number: this.config.startBlock,
        block_hash:
          '0x0000000000000000000000000000000000000000000000000000000000000000',
        last_update: new Date().toISOString(),
      });
      this.logger.info('Starting from initial block', {
        blockNumber: this.lastProcessedBlock,
      });
    }

    await this.calculator.start();
    this.processingPromise = this.processLoop();
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping calculator...');
    this.isRunning = false;
    await this.calculator.stop();
    if (this.processingPromise) {
      await this.processingPromise;
    }
    this.logger.info('Calculator stopped');
  }

  async getCalculatorStatus(): Promise<{
    isRunning: boolean;
    lastProcessedBlock: number;
    currentChainBlock: number;
    processingLag: number;
  }> {
    const currentBlock = await this.getCurrentBlock();
    return {
      isRunning: this.isRunning,
      lastProcessedBlock: this.lastProcessedBlock,
      currentChainBlock: currentBlock,
      processingLag: currentBlock - this.lastProcessedBlock,
    };
  }

  private async processLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const currentBlock = await this.getCurrentBlock();
        const targetBlock = currentBlock - this.config.confirmations;

        if (targetBlock <= this.lastProcessedBlock) {
          this.logger.debug('Waiting for new blocks', {
            currentBlock,
            targetBlock,
            lastProcessedBlock: this.lastProcessedBlock,
          });
          await new Promise((resolve) =>
            setTimeout(resolve, this.config.pollInterval * 1000),
          );
          continue;
        }

        const fromBlock = this.lastProcessedBlock + 1;
        const toBlock = Math.min(
          targetBlock,
          fromBlock + this.config.maxBlockRange - 1,
        );

        this.logger.info('Processing new blocks', {
          fromBlock,
          toBlock,
          currentBlock,
          blockRange: toBlock - fromBlock + 1,
        });

        await this.calculator.processScoreEvents(fromBlock, toBlock);

        const block = await this.provider.getBlock(toBlock);
        if (!block) throw new Error(`Block ${toBlock} not found`);

        // Update checkpoint
        await this.db.updateCheckpoint({
          component_type: 'calculator',
          last_block_number: toBlock,
          block_hash: block.hash!,
          last_update: new Date().toISOString(),
        });

        this.lastProcessedBlock = toBlock;
        this.logger.info('Blocks processed successfully', {
          fromBlock,
          toBlock,
          blockHash: block.hash,
        });
      } catch (error) {
        this.logger.error('Error in processing loop', {
          error,
          lastProcessedBlock: this.lastProcessedBlock,
        });
        await new Promise((resolve) =>
          setTimeout(resolve, this.config.pollInterval * 1000),
        );
      }
    }
  }

  private async getCurrentBlock(): Promise<number> {
    return this.provider.getBlockNumber();
  }
}
