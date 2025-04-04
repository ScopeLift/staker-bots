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
  EventGroup,
  TransactionEntry,
  StakedWithAttributionEvent,
  UnstakedEvent,
  DepositInitializedEvent,
  DepositUpdatedEvent,
} from './types';
import {
  DEFAULT_DELEGATEE_ADDRESS,
  MONITOR_EVENTS,
  PROCESSING_COMPONENT,
  EVENT_TYPES,
} from './constants';
import {
  EventProcessingError,
  DatabaseError,
  MonitorError,
} from '@/configuration/errors';
import { stakerAbi } from '@/configuration/abis';

/**
 * StakerMonitor is responsible for monitoring staking events on the blockchain.
 * It processes StakeDeposited, StakeWithdrawn, and DelegateeAltered events,
 * maintains state in a database, and emits events for other components.
 */
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
      stakerAbi,
      config.provider,
    );
    this.lstContract = new ethers.Contract(
      config.lstAddress,
      stakerAbi,
      config.provider,
    );
    this.logger = new ConsoleLogger(config.logLevel);
    this.eventProcessor = new EventProcessor(this.db, this.logger);
    this.isRunning = false;
    this.lastProcessedBlock = config.startBlock;
  }

  /**
   * Starts the monitor process. If already running, logs a warning and returns.
   * Resumes from last checkpoint if available, otherwise starts from configured block.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Monitor is already running');
      return;
    }

    this.isRunning = true;
    const checkpoint = await this.db.getCheckpoint(PROCESSING_COMPONENT.TYPE);

    if (checkpoint) {
      this.lastProcessedBlock = checkpoint.last_block_number;
    } else {
      this.lastProcessedBlock = this.config.startBlock;
      await this.db.updateCheckpoint({
        component_type: PROCESSING_COMPONENT.TYPE,
        last_block_number: this.config.startBlock,
        block_hash: PROCESSING_COMPONENT.INITIAL_BLOCK_HASH,
        last_update: new Date().toISOString(),
      });
    }

    this.processingPromise = this.processLoop();
  }

  /**
   * Stops the monitor process gracefully.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.processingPromise) {
      await this.processingPromise;
    }
  }

  /**
   * Returns the current status of the monitor including:
   * - Running state
   * - Last processed block
   * - Current chain block
   * - Processing lag
   * - Last checkpoint
   * - Network status
   */
  async getMonitorStatus(): Promise<MonitorStatus> {
    const currentBlock = await this.getCurrentBlock();
    const checkpoint = await this.db.getCheckpoint(PROCESSING_COMPONENT.TYPE);

    return {
      isRunning: this.isRunning,
      lastProcessedBlock: this.lastProcessedBlock,
      currentChainBlock: currentBlock,
      processingLag: currentBlock - this.lastProcessedBlock,
      lastCheckpoint: checkpoint!,
      networkStatus: {
        chainId: this.config.chainId,
        networkName: this.config.networkName,
        isConnected: true,
      },
    };
  }

  private async getCurrentBlock(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  /**
   * Main processing loop that continuously monitors for new blocks and processes events.
   * Handles block range processing, checkpointing, and error recovery.
   */
  private async processLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const currentBlock = await this.getCurrentBlock();
        const targetBlock = currentBlock - this.config.confirmations;

        if (targetBlock <= this.lastProcessedBlock) {
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

        await this.db.updateCheckpoint({
          component_type: PROCESSING_COMPONENT.TYPE,
          last_block_number: toBlock,
          block_hash: block.hash!,
          last_update: new Date().toISOString(),
        });

        this.lastProcessedBlock = toBlock;
      } catch (error) {
        this.logger.error('Error in processing loop', { error });
        await new Promise((resolve) =>
          setTimeout(resolve, this.config.pollInterval * 1000),
        );
      }
    }
  }

  /**
   * Processes events within a specified block range.
   * Fetches and processes StakeDeposited, StakeWithdrawn, and DelegateeAltered events.
   * Groups related events by transaction for atomic processing.
   *
   * @param fromBlock - Starting block number
   * @param toBlock - Ending block number
   */
  private async processBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    const [
      lstDepositEvents,
      depositedEvents,
      withdrawnEvents,
      alteredEvents,
      stakedWithAttributionEvents,
      unstakedEvents,
      depositInitializedEvents,
      depositUpdatedEvents,
    ] = await Promise.all([
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
      this.lstContract.queryFilter(
        this.lstContract.filters.StakedWithAttribution!(),
        fromBlock,
        toBlock,
      ),
      this.lstContract.queryFilter(
        this.lstContract.filters.Unstaked!(),
        fromBlock,
        toBlock,
      ),
      this.lstContract.queryFilter(
        this.lstContract.filters.DepositInitialized!(),
        fromBlock,
        toBlock,
      ),
      this.lstContract.queryFilter(
        this.lstContract.filters.DepositUpdated!(),
        fromBlock,
        toBlock,
      ),
    ]);

    const sortEvents = (events: ethers.Log[]) => {
      return [...events].sort((a, b) => {
        if (a.blockNumber !== b.blockNumber)
          return a.blockNumber - b.blockNumber;
        const indexA = 'index' in a ? (a.index ?? 0) : 0;
        const indexB = 'index' in b ? (b.index ?? 0) : 0;
        return indexA - indexB;
      });
    };

    const sortedEvents = {
      lstDeposit: sortEvents(lstDepositEvents),
      deposited: sortEvents(depositedEvents),
      withdrawn: sortEvents(withdrawnEvents),
      altered: sortEvents(alteredEvents),
      stakedWithAttribution: sortEvents(stakedWithAttributionEvents),
      unstaked: sortEvents(unstakedEvents),
      depositInitialized: sortEvents(depositInitializedEvents),
      depositUpdated: sortEvents(depositUpdatedEvents),
    };

    const eventsByTx = new Map<string, EventGroup>();

    // Group all events by transaction hash
    const addEventsToGroup = (events: ethers.Log[], key: keyof EventGroup) => {
      for (const event of events) {
        const typedEvent = event as ethers.EventLog;
        const existing = eventsByTx.get(typedEvent.transactionHash) || {};
        eventsByTx.set(typedEvent.transactionHash, {
          ...existing,
          [key]: typedEvent,
        });
      }
    };

    addEventsToGroup(sortedEvents.deposited, 'deposited');
    addEventsToGroup(sortedEvents.lstDeposit, 'lstDeposited');
    addEventsToGroup(sortedEvents.altered, 'altered');
    addEventsToGroup(
      sortedEvents.stakedWithAttribution,
      'stakedWithAttribution',
    );
    addEventsToGroup(sortedEvents.unstaked, 'unstaked');
    addEventsToGroup(sortedEvents.depositInitialized, 'depositInitialized');
    addEventsToGroup(sortedEvents.depositUpdated, 'depositUpdated');

    // Process events chronologically
    const txEntries = [...eventsByTx.entries()]
      .map(([txHash, events]) => ({
        txHash,
        events,
        blockNumber:
          events.deposited?.blockNumber ||
          events.lstDeposited?.blockNumber ||
          events.altered?.blockNumber ||
          events.stakedWithAttribution?.blockNumber ||
          events.unstaked?.blockNumber ||
          events.depositInitialized?.blockNumber ||
          events.depositUpdated?.blockNumber ||
          0,
      }))
      .sort((a, b) => a.blockNumber - b.blockNumber);

    await this.processTransactions(txEntries);
    await this.processStandaloneEvents(sortedEvents);
  }

  /**
   * Processes transactions that contain related events.
   * Handles the events atomically to maintain data consistency.
   *
   * @param txEntries - Array of transaction entries containing grouped events
   */
  private async processTransactions(
    txEntries: TransactionEntry[],
  ): Promise<void> {
    for (const { events } of txEntries) {
      // Process stake deposits with attribution
      if (events.stakedWithAttribution) {
        const event = events.stakedWithAttribution;
        const { _depositId, _amount, _referrer } = event.args;
        await this.handleStakedWithAttribution({
          depositId: _depositId.toString(),
          amount: _amount,
          referrer: _referrer,
          blockNumber: event.blockNumber!,
          transactionHash: event.transactionHash!,
        });
      }

      // Process unstake events
      if (events.unstaked) {
        const event = events.unstaked;
        const { account, amount } = event.args;
        await this.handleUnstaked({
          account,
          amount,
          blockNumber: event.blockNumber!,
          transactionHash: event.transactionHash!,
        });
      }

      // Process deposit initialization
      if (events.depositInitialized) {
        const event = events.depositInitialized;
        const { delegatee, depositId } = event.args;
        await this.handleDepositInitialized({
          delegatee,
          depositId: depositId.toString(),
          blockNumber: event.blockNumber!,
          transactionHash: event.transactionHash!,
        });
      }

      // Process deposit updates
      if (events.depositUpdated) {
        const event = events.depositUpdated;
        const { holder, oldDepositId, newDepositId } = event.args;
        await this.handleDepositUpdated({
          holder,
          oldDepositId: oldDepositId.toString(),
          newDepositId: newDepositId.toString(),
          blockNumber: event.blockNumber!,
          transactionHash: event.transactionHash!,
        });
      }

      // Process existing events...
      if (events.deposited) {
        const depositEvent = events.deposited;
        const lstDepositEvent = events.lstDeposited;

        const { depositId, owner: ownerAddress } = depositEvent.args;
        const depositIdString = depositId.toString();
        let amount = depositEvent.args.amount;

        // Get depositor from LST event or fallback to owner
        const depositorAddress =
          lstDepositEvent?.args?.[0] ||
          lstDepositEvent?.args?.account ||
          ownerAddress;

        // Use LST amount if available
        if (lstDepositEvent?.args) {
          const lstAmount =
            lstDepositEvent.args[1] || lstDepositEvent.args.amount;
          if (lstAmount) amount = lstAmount;
        }

        // Get delegatee or use default
        let delegateeAddress =
          events.altered?.args.newDelegatee || DEFAULT_DELEGATEE_ADDRESS;

        // Force default delegatee for GovLst-owned deposits unless explicitly altered
        if (
          ownerAddress.toLowerCase() === this.config.lstAddress.toLowerCase() &&
          !events.altered
        ) {
          delegateeAddress = DEFAULT_DELEGATEE_ADDRESS;
        }

        await this.handleStakeDeposited({
          depositId: depositIdString,
          ownerAddress,
          delegateeAddress,
          depositorAddress,
          amount,
          blockNumber: depositEvent.blockNumber!,
          transactionHash: depositEvent.transactionHash!,
        });
      }
    }
  }

  /**
   * Processes standalone events that are not part of a deposit transaction.
   * This includes withdrawals and delegatee changes that occur independently.
   *
   * @param events - Object containing sorted events by type
   */
  private async processStandaloneEvents(events: {
    withdrawn: ethers.Log[];
    altered: ethers.Log[];
  }): Promise<void> {
    // Process withdrawals
    for (const event of events.withdrawn) {
      const typedEvent = event as ethers.EventLog;
      const { depositId, amount } = typedEvent.args;

      await this.handleStakeWithdrawn({
        depositId: depositId.toString(),
        withdrawnAmount: amount,
        blockNumber: typedEvent.blockNumber!,
        transactionHash: typedEvent.transactionHash!,
      });
    }

    // Process standalone delegatee changes
    for (const event of events.altered) {
      const typedEvent = event as ethers.EventLog;
      const { depositId, oldDelegatee, newDelegatee } = typedEvent.args;

      await this.handleDelegateeAltered({
        depositId: depositId.toString(),
        oldDelegatee,
        newDelegatee,
        blockNumber: typedEvent.blockNumber!,
        transactionHash: typedEvent.transactionHash!,
      });
    }
  }

  /**
   * Handles a StakeDeposited event by processing it and updating the database.
   * Retries on failure up to the configured maximum attempts.
   *
   * @param event - The StakeDeposited event to process
   */
  private async handleStakeDeposited(
    event: StakeDepositedEvent,
  ): Promise<void> {
    await this.withRetry(async () => {
      try {
        if (!event.depositorAddress) {
          event.depositorAddress = event.ownerAddress;
        }

        if (!event.delegateeAddress) {
          event.delegateeAddress = DEFAULT_DELEGATEE_ADDRESS;
        }

        const result = await this.eventProcessor.processStakeDeposited(event);
        if (result.success || !result.retryable) {
          await this.updateGovLstDeposit(
            event.depositId,
            event.delegateeAddress,
          );
          return;
        }

        throw new EventProcessingError(
          EVENT_TYPES.STAKE_DEPOSITED,
          new Error('Failed to process StakeDeposited event'),
          { event },
        );
      } catch (error) {
        if (error instanceof MonitorError) throw error;
        throw new EventProcessingError(
          EVENT_TYPES.STAKE_DEPOSITED,
          error as Error,
          { event },
        );
      }
    }, 'process StakeDeposited event');
  }

  /**
   * Handles a StakeWithdrawn event by processing it and updating the database.
   * Retries on failure up to the configured maximum attempts.
   *
   * @param event - The StakeWithdrawn event to process
   */
  private async handleStakeWithdrawn(
    event: StakeWithdrawnEvent,
  ): Promise<void> {
    await this.withRetry(async () => {
      try {
        const result = await this.eventProcessor.processStakeWithdrawn(event);
        if (result.success || !result.retryable) return;

        throw new EventProcessingError(
          EVENT_TYPES.STAKE_WITHDRAWN,
          new Error('Failed to process StakeWithdrawn event'),
          { event },
        );
      } catch (error) {
        if (error instanceof MonitorError) throw error;
        throw new EventProcessingError(
          EVENT_TYPES.STAKE_WITHDRAWN,
          error as Error,
          { event },
        );
      }
    }, 'process StakeWithdrawn event');
  }

  /**
   * Handles a DelegateeAltered event by processing it and updating the database.
   * Retries on failure up to the configured maximum attempts.
   * Emits a delegateEvent on successful processing.
   *
   * @param event - The DelegateeAltered event to process
   */
  private async handleDelegateeAltered(
    event: DelegateeAlteredEvent,
  ): Promise<void> {
    await this.withRetry(async () => {
      try {
        if (!event.newDelegatee) {
          event.newDelegatee = DEFAULT_DELEGATEE_ADDRESS;
        }

        const result = await this.eventProcessor.processDelegateeAltered(event);
        if (result.success || !result.retryable) {
          await this.updateGovLstDeposit(event.depositId, event.newDelegatee);
          this.emit(MONITOR_EVENTS.DELEGATE_EVENT, event);
          return;
        }

        throw new EventProcessingError(
          EVENT_TYPES.DELEGATEE_ALTERED,
          new Error('Failed to process DelegateeAltered event'),
          { event },
        );
      } catch (error) {
        if (error instanceof MonitorError) throw error;
        throw new EventProcessingError(
          EVENT_TYPES.DELEGATEE_ALTERED,
          error as Error,
          { event },
        );
      }
    }, 'process DelegateeAltered event');
  }

  /**
   * Handles a StakedWithAttribution event.
   * Emits a STAKE_WITH_ATTRIBUTION event on successful processing.
   *
   * @param event - The StakedWithAttribution event to process
   */
  private async handleStakedWithAttribution(
    event: StakedWithAttributionEvent,
  ): Promise<void> {
    await this.withRetry(async () => {
      // Update GovLst deposit mapping
      await this.updateGovLstDeposit(event.depositId, event.referrer);

      this.emit(MONITOR_EVENTS.STAKE_WITH_ATTRIBUTION, event);
    }, 'process StakedWithAttribution event');
  }

  /**
   * Handles an Unstaked event.
   * Emits an UNSTAKED event on successful processing.
   *
   * @param event - The Unstaked event to process
   */
  private async handleUnstaked(event: UnstakedEvent): Promise<void> {
    await this.withRetry(async () => {
      // Emit event for other components to handle
      this.emit(MONITOR_EVENTS.UNSTAKED, event);
    }, 'process Unstaked event');
  }

  /**
   * Handles a DepositInitialized event.
   * Emits a DEPOSIT_INITIALIZED event on successful processing.
   *
   * @param event - The DepositInitialized event to process
   */
  private async handleDepositInitialized(
    event: DepositInitializedEvent,
  ): Promise<void> {
    await this.withRetry(async () => {
      // Update GovLst deposit mapping
      await this.updateGovLstDeposit(event.depositId, event.delegatee);

      this.emit(MONITOR_EVENTS.DEPOSIT_INITIALIZED, event);
    }, 'process DepositInitialized event');
  }

  /**
   * Handles a DepositUpdated event.
   * Updates the deposit mapping and emits a DEPOSIT_UPDATED event.
   *
   * @param event - The DepositUpdated event to process
   */
  private async handleDepositUpdated(
    event: DepositUpdatedEvent,
  ): Promise<void> {
    await this.withRetry(async () => {
      try {
        const result = await this.eventProcessor.processDepositUpdated(event);
        if (result.success || !result.retryable) {
          // Update GovLst deposit mapping for the new deposit ID
          await this.updateGovLstDeposit(event.newDepositId, event.holder);
          this.emit(MONITOR_EVENTS.DEPOSIT_UPDATED, event);
          return;
        }

        throw new EventProcessingError(
          EVENT_TYPES.DEPOSIT_UPDATED,
          new Error('Failed to process DepositUpdated event'),
          { event },
        );
      } catch (error) {
        if (error instanceof MonitorError) throw error;
        throw new EventProcessingError(
          EVENT_TYPES.DEPOSIT_UPDATED,
          error as Error,
          { event },
        );
      }
    }, 'process DepositUpdated event');
  }

  /**
   * Retries an async operation with exponential backoff until it succeeds or max retries reached
   * @param operation - The async function to retry
   * @param context - Description of the operation for error logging
   * @returns The result of the operation if successful
   * @throws The last error encountered after max retries
   *
   * Used to make event processing more resilient by retrying failed operations.
   * Implements exponential backoff by increasing delay between retries.
   * Logs error and rethrows after max retries reached.
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    context: string,
  ): Promise<T> {
    let attempts = 0;
    while (attempts < this.config.maxRetries) {
      try {
        return await operation();
      } catch (error) {
        attempts++;
        if (attempts === this.config.maxRetries) {
          this.logger.error(`Failed to ${context} after max retries`, {
            error,
          });
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
      }
    }
    throw new Error('Unreachable');
  }

  /**
   * Updates or creates a GovLst deposit record in the database
   * @param depositId - Unique identifier for the deposit
   * @param delegatee - Address of the delegatee for this deposit
   * @throws DatabaseError if database operations fail
   *
   * Used to maintain mapping between deposits and their delegatees.
   * Updates existing record if found, creates new record if not.
   * Handles both creation and update timestamps automatically.
   */
  private async updateGovLstDeposit(
    depositId: string,
    delegatee: string,
  ): Promise<void> {
    try {
      const existingDeposit = await this.db.getGovLstDeposit(depositId);
      if (existingDeposit) {
        await this.db.updateGovLstDeposit(depositId, {
          govlst_address: delegatee,
        });
      } else {
        await this.db.createGovLstDeposit({
          deposit_id: depositId,
          govlst_address: delegatee,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      throw new DatabaseError('update GovLst deposit mapping', error as Error, {
        depositId,
        delegatee,
      });
    }
  }
}
