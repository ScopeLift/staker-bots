import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { IDatabase } from '@/database';
import { EventProcessor } from './EventProcessor';
import { ConsoleLogger, Logger } from './logging';
import {
  MonitorConfig,
  MonitorStatus,
  StakeDepositedEvent,
  StakeWithdrawnEvent,
  DelegateeAlteredEvent,
} from './types';
import { STAKER_ABI } from './constants';

export class StakerMonitor extends EventEmitter {
  private readonly db: IDatabase;
  private readonly provider: ethers.Provider;
  private readonly contract: ethers.Contract;
  private readonly logger: Logger;
  private readonly eventProcessor: EventProcessor;
  private readonly config: MonitorConfig;
  private isRunning: boolean;
  private processingPromise?: Promise<void>;
  private lastProcessedBlock: number;

  constructor(config: MonitorConfig) {
    super();
    this.config = config;
    this.db = config.database;
    this.provider = config.provider;
    this.contract = new ethers.Contract(
      config.stakerAddress,
      STAKER_ABI,
      config.provider,
    );
    this.logger = new ConsoleLogger(config.logLevel);
    this.eventProcessor = new EventProcessor(this.db, this.logger);
    this.isRunning = false;
    this.lastProcessedBlock = config.startBlock;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Monitor is already running');
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting Staker Monitor', {
      network: this.config.networkName,
      chainId: this.config.chainId,
      address: this.config.stakerAddress,
    });

    // Check for existing checkpoint first
    const checkpoint = await this.db.getCheckpoint('staker-monitor');

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
        component_type: 'staker-monitor',
        last_block_number: this.config.startBlock,
        block_hash:
          '0x0000000000000000000000000000000000000000000000000000000000000000',
        last_update: new Date().toISOString(),
      });
      this.logger.info('Starting from initial block', {
        blockNumber: this.lastProcessedBlock,
      });
    }

    this.processingPromise = this.processLoop();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.processingPromise) {
      await this.processingPromise;
    }
    this.logger.info('Staker Monitor stopped');
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

        await this.processBlockRange(fromBlock, toBlock);

        const block = await this.provider.getBlock(toBlock);
        if (!block) throw new Error(`Block ${toBlock} not found`);

        // Update checkpoint
        await this.db.updateCheckpoint({
          component_type: 'staker-monitor',
          last_block_number: toBlock,
          block_hash: block.hash!,
          last_update: new Date().toISOString(),
        });

        this.lastProcessedBlock = toBlock;
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

  private async processBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    const [depositedEvents, withdrawnEvents, alteredEvents] = await Promise.all(
      [
        this.contract.queryFilter(
          this.contract.filters.StakeDeposited!(),
          fromBlock,
          toBlock,
        ),
        this.contract.queryFilter(
          this.contract.filters.StakeWithdrawn!(),
          fromBlock,
          toBlock,
        ),
        this.contract.queryFilter(
          this.contract.filters.DelegateeAltered!(),
          fromBlock,
          toBlock,
        ),
      ],
    );

    // Group events by transaction hash for correlation
    const eventsByTx = new Map<
      string,
      {
        deposited?: ethers.EventLog;
        altered?: ethers.EventLog;
      }
    >();

    // Group StakeDeposited events
    for (const event of depositedEvents) {
      const typedEvent = event as ethers.EventLog;
      const existing = eventsByTx.get(typedEvent.transactionHash) || {};
      this.logger.debug('Adding StakeDeposited event to transaction group', {
        txHash: typedEvent.transactionHash,
        depositId: typedEvent.args.depositId.toString(),
        blockNumber: typedEvent.blockNumber,
        hasExistingAltered: !!existing.altered,
      });
      eventsByTx.set(typedEvent.transactionHash, {
        ...existing,
        deposited: typedEvent,
      });
    }

    // Group DelegateeAltered events
    for (const event of alteredEvents) {
      const typedEvent = event as ethers.EventLog;
      const existing = eventsByTx.get(typedEvent.transactionHash) || {};
      this.logger.debug('Adding DelegateeAltered event to transaction group', {
        txHash: typedEvent.transactionHash,
        depositId: typedEvent.args.depositId.toString(),
        blockNumber: typedEvent.blockNumber,
        hasExistingDeposit: !!existing.deposited,
        oldDelegatee: typedEvent.args.oldDelegatee,
        newDelegatee: typedEvent.args.newDelegatee,
      });
      eventsByTx.set(typedEvent.transactionHash, {
        ...existing,
        altered: typedEvent,
      });
    }

    // If we found any events, fetch and log the full blocks
    const eventBlocks = new Set([
      ...depositedEvents.map((e) => e.blockNumber),
      ...withdrawnEvents.map((e) => e.blockNumber),
      ...alteredEvents.map((e) => e.blockNumber),
    ]);

    for (const blockNumber of eventBlocks) {
      const block = await this.provider.getBlock(blockNumber!, true);
      if (!block) continue;

      const txs = await Promise.all(
        block.transactions.map(async (txHash) => {
          const tx = await this.provider.getTransaction(txHash as string);
          return tx
            ? {
                hash: tx.hash,
                from: tx.from,
                to: tx.to,
                index: tx.blockNumber,
              }
            : null;
        }),
      );

      this.logger.info('Full block details for block with events:', {
        blockNumber,
        blockHash: block.hash,
        timestamp: block.timestamp,
        transactions: txs.filter((tx) => tx !== null),
      });
    }

    // Process events by transaction
    for (const [txHash, events] of eventsByTx) {
      if (events.deposited) {
        const depositEvent = events.deposited;
        const { depositId, owner: ownerAddress, amount } = depositEvent.args;

        // Get the delegatee from the DelegateeAltered event if it exists, otherwise use owner
        const delegateeAddress = events.altered
          ? events.altered.args.newDelegatee
          : ownerAddress;

        this.logger.info('Processing deposit transaction group', {
          txHash,
          depositId: depositId.toString(),
          ownerAddress,
          delegateeAddress,
          amount: amount.toString(),
          blockNumber: depositEvent.blockNumber,
          hasAlteredEvent: !!events.altered,
          originalDelegatee: events.altered
            ? events.altered.args.oldDelegatee
            : null,
        });

        await this.handleStakeDeposited({
          depositId: depositId.toString(),
          ownerAddress,
          delegateeAddress,
          amount,
          blockNumber: depositEvent.blockNumber!,
          transactionHash: depositEvent.transactionHash!,
        });
      }
    }

    // Process remaining events (StakeWithdrawn and standalone DelegateeAltered)
    for (const event of withdrawnEvents) {
      const typedEvent = event as ethers.EventLog;
      const { depositId, amount } = typedEvent.args;
      this.logger.debug('Processing StakeWithdrawn event', {
        depositId: depositId.toString(),
        amount: amount.toString(),
        blockNumber: typedEvent.blockNumber,
        txHash: typedEvent.transactionHash,
      });
      await this.handleStakeWithdrawn({
        depositId: depositId.toString(),
        withdrawnAmount: amount,
        blockNumber: typedEvent.blockNumber!,
        transactionHash: typedEvent.transactionHash!,
      });
    }

    // Only process DelegateeAltered events that weren't part of a deposit
    for (const event of alteredEvents) {
      const typedEvent = event as ethers.EventLog;
      const txEvents = eventsByTx.get(typedEvent.transactionHash);
      // Skip if this was part of a deposit transaction
      if (txEvents?.deposited) continue;

      const { depositId, oldDelegatee, newDelegatee } = typedEvent.args;
      this.logger.debug('Processing DelegateeAltered event', {
        depositId,
        oldDelegatee,
        newDelegatee,
        blockNumber: typedEvent.blockNumber,
        txHash: typedEvent.transactionHash,
      });
      await this.handleDelegateeAltered({
        depositId,
        oldDelegatee,
        newDelegatee,
        blockNumber: typedEvent.blockNumber!,
        transactionHash: typedEvent.transactionHash!,
      });
    }
  }

  async handleStakeDeposited(event: StakeDepositedEvent): Promise<void> {
    let attempts = 0;
    while (attempts < this.config.maxRetries) {
      const result = await this.eventProcessor.processStakeDeposited(event);
      if (result.success || !result.retryable) {
        return;
      }
      attempts++;
      if (attempts < this.config.maxRetries) {
        this.logger.warn(
          `Retrying StakeDeposited event (attempt ${attempts + 1}/${this.config.maxRetries})`,
          { event },
        );
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempts)); // Exponential backoff
      }
    }
    this.logger.error(
      'Failed to process StakeDeposited event after max retries',
      { event },
    );
  }

  async handleStakeWithdrawn(event: StakeWithdrawnEvent): Promise<void> {
    let attempts = 0;
    while (attempts < this.config.maxRetries) {
      const result = await this.eventProcessor.processStakeWithdrawn(event);
      if (result.success || !result.retryable) {
        return;
      }
      attempts++;
      if (attempts < this.config.maxRetries) {
        this.logger.warn(
          `Retrying StakeWithdrawn event (attempt ${attempts + 1}/${this.config.maxRetries})`,
          { event },
        );
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
      }
    }
    this.logger.error(
      'Failed to process StakeWithdrawn event after max retries',
      { event },
    );
  }

  async handleDelegateeAltered(event: DelegateeAlteredEvent): Promise<void> {
    let attempts = 0;
    while (attempts < this.config.maxRetries) {
      const result = await this.eventProcessor.processDelegateeAltered(event);
      if (result.success || !result.retryable) {
        this.emit('delegateEvent', event);
        return;
      }
      attempts++;
      if (attempts < this.config.maxRetries) {
        this.logger.warn(
          `Retrying DelegateeAltered event (attempt ${attempts + 1}/${this.config.maxRetries})`,
          { event },
        );
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
      }
    }
    this.logger.error(
      'Failed to process DelegateeAltered event after max retries',
      { event },
    );
    this.emit(
      'error',
      new Error('Failed to process DelegateeAltered event after max retries'),
    );
  }

  async getCurrentBlock(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  async getLastProcessedBlock(): Promise<number> {
    return this.lastProcessedBlock;
  }

  async getMonitorStatus(): Promise<MonitorStatus> {
    const currentBlock = await this.getCurrentBlock();
    const checkpoint = await this.db.getCheckpoint('staker-monitor');

    return {
      isRunning: this.isRunning,
      lastProcessedBlock: this.lastProcessedBlock,
      currentChainBlock: currentBlock,
      processingLag: currentBlock - this.lastProcessedBlock,
      lastCheckpoint: checkpoint!,
      networkStatus: {
        chainId: this.config.chainId,
        networkName: this.config.networkName,
        isConnected: true, // You might want to implement a more sophisticated check
      },
    };
  }

  async getProcessingLag(): Promise<number> {
    const currentBlock = await this.getCurrentBlock();
    return currentBlock - this.lastProcessedBlock;
  }
}
