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
  private readonly lstContract: ethers.Contract;
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
    this.lstContract = new ethers.Contract(
      config.lstAddress,
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
    const [lstDepositEvents, depositedEvents, withdrawnEvents, alteredEvents] = await Promise.all(
      [
        this.lstContract.queryFilter(
          this.lstContract.filters.Staked!(),
          fromBlock,
          toBlock,
        ),
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

    // Sort all events by block number and log index to ensure chronological processing
    const sortEvents = (events: ethers.Log[]) => {
      return [...events].sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
          return a.blockNumber - b.blockNumber;
        }
        // Use nullish coalescing to handle cases where logIndex might be undefined
        const aLogIndex = (a as any).logIndex ?? 0;
        const bLogIndex = (b as any).logIndex ?? 0;
        return aLogIndex - bLogIndex;
      });
    };

    const sortedLstDepositEvents = sortEvents(lstDepositEvents);
    const sortedDepositedEvents = sortEvents(depositedEvents);
    const sortedWithdrawnEvents = sortEvents(withdrawnEvents);
    const sortedAlteredEvents = sortEvents(alteredEvents);

    // Log the sorted events for debugging
    this.logger.debug('Events sorted by block number and log index', {
      lstDepositCount: sortedLstDepositEvents.length,
      depositedCount: sortedDepositedEvents.length,
      withdrawnCount: sortedWithdrawnEvents.length,
      alteredCount: sortedAlteredEvents.length,
    });

    // Group events by transaction hash for correlation
    const eventsByTx = new Map<
      string,
      {
        deposited?: ethers.EventLog;
        lstDeposited?: ethers.EventLog;
        altered?: ethers.EventLog;
      }
    >();

    // Group StakeDeposited events
    for (const event of sortedDepositedEvents) {
      const typedEvent = event as ethers.EventLog;
      const existing = eventsByTx.get(typedEvent.transactionHash) || {};
      this.logger.debug('Adding StakeDeposited event to transaction group', {
        txHash: typedEvent.transactionHash,
        depositId: typedEvent.args.depositId.toString(),
        blockNumber: typedEvent.blockNumber,
        logIndex: (typedEvent as any).logIndex ?? 0,
        hasExistingAltered: !!existing.altered,
      });
      eventsByTx.set(typedEvent.transactionHash, {
        ...existing,
        deposited: typedEvent,
      });
    }

    // Group LstDeposited events - take the first one or keep the existing one
    for (const event of sortedLstDepositEvents) {
      const typedEvent = event as ethers.EventLog;

      // Debug full event data to understand the structure
      this.logger.debug('LST Deposit Event Raw Data:', {
        txHash: typedEvent.transactionHash,
        eventName: typedEvent.eventName,
        args: JSON.stringify(typedEvent.args, (key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        ),
        eventSignature: typedEvent.eventSignature,
      });

      const existing = eventsByTx.get(typedEvent.transactionHash) || {};

      // Make sure we get the amount from the right parameter
      // According to ABI: 'event Staked(address indexed account, uint256 amount)'
      const amount = typedEvent.args[1] || typedEvent.args.amount || '0';

      this.logger.debug('Adding LstDeposited event to transaction group', {
        txHash: typedEvent.transactionHash,
        blockNumber: typedEvent.blockNumber,
        hasExistingAltered: !!existing.altered,
        account: typedEvent.args[0] || typedEvent.args.account,
        amount: amount.toString(),
      });

      eventsByTx.set(typedEvent.transactionHash, {
        ...existing,
        lstDeposited: existing.lstDeposited || typedEvent,
      });
    }

    // Group DelegateeAltered events
    for (const event of sortedAlteredEvents) {
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
      ...sortedDepositedEvents.map((e) => e.blockNumber),
      ...sortedWithdrawnEvents.map((e) => e.blockNumber),
      ...sortedAlteredEvents.map((e) => e.blockNumber),
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
    }

    // Process events by transaction
    // First, convert the map to an array and sort by block number and transaction index
    const txEntries = [...eventsByTx.entries()].map(([txHash, events]) => {
      // Get block number from any of the events (they're from the same tx so same block)
      const blockNumber = events.deposited?.blockNumber ||
                         events.lstDeposited?.blockNumber ||
                         events.altered?.blockNumber || 0;

      return {
        txHash,
        events,
        blockNumber
      };
    });

    // Sort transactions by block number
    txEntries.sort((a, b) => a.blockNumber - b.blockNumber);

    this.logger.info('Processing transactions in chronological order', {
      transactionCount: txEntries.length
    });

    // Process sorted transactions
    for (const { txHash, events } of txEntries) {
      if (events.deposited) {
        const depositEvent = events.deposited;
        let lstDepositEvent = events.lstDeposited;
        const { depositId, owner: ownerAddress } = depositEvent.args;

        // Extract amount from deposited event or LST deposit event if available
        let amount = depositEvent.args.amount;

        // Extract depositor account from lst deposit event if available
        const depositorAddress = lstDepositEvent?.args?.[0] || lstDepositEvent?.args?.account || ownerAddress;

        // If we have an LST deposit event with an amount, use that
        if (lstDepositEvent?.args) {
          // Try different ways to access the amount from LST event
          const lstAmount = lstDepositEvent.args[1] || lstDepositEvent.args.amount;

          if (lstAmount) {
            amount = lstAmount;
            this.logger.info('Using amount from LST deposit event', {
              lstAmount: amount.toString(),
              depositEventAmount: depositEvent.args.amount.toString()
            });
          }
        }

        // Get the delegatee from the DelegateeAltered event if it exists, otherwise use owner
        const delegateeAddress = events.altered
          ? events.altered.args.newDelegatee
          : ownerAddress;

        this.logger.info('Processing deposit transaction group', {
          txHash,
          depositId: depositId.toString(),
          ownerAddress,
          depositorAddress,
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
          depositorAddress,
          amount,
          blockNumber: depositEvent.blockNumber!,
          transactionHash: depositEvent.transactionHash!,
        });

        // Debug log to confirm the final amount being used
        this.logger.info('Final deposit amount being processed:', {
          depositId: depositId.toString(),
          amount: amount.toString(),
          hasLstEvent: !!lstDepositEvent,
          transactionHash: depositEvent.transactionHash,
        });
      }
    }

    // Process remaining events (StakeWithdrawn and standalone DelegateeAltered)
    for (const event of sortedWithdrawnEvents) {
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
    for (const event of sortedAlteredEvents) {
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
