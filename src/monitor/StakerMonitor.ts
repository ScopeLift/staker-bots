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
  ClaimerAlteredEvent,
  RewardClaimedEvent,
  DepositSubsidizedEvent,
  EarningPowerBumpedEvent,
} from './types';
import {
  DEFAULT_DELEGATEE_ADDRESS,
  MONITOR_EVENTS,
  PROCESSING_COMPONENT,
  EVENT_TYPES,
} from './constants';
import { EventProcessingError, MonitorError } from '@/configuration/errors';
import { stakerAbi } from '@/configuration/abis';
import { ErrorLogger } from '@/configuration/errorLogger';
import { Deposit } from '@/database/interfaces/types';
import { DepositCountPredictor } from '@/utils/DepositCountPredictor';

/**
 * Extended MonitorConfig that includes the error logger
 */
export interface ExtendedMonitorConfig extends MonitorConfig {
  errorLogger?: ErrorLogger;
}

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
  private readonly errorLogger?: ErrorLogger;
  private readonly eventProcessor: EventProcessor;
  private readonly config: MonitorConfig;
  private isRunning: boolean;
  private processingPromise?: Promise<void>;
  private lastProcessedBlock: number;
  private depositScanInProgress: boolean;
  private cachedBlockNumber: number;
  private lastBlockNumberUpdate: number;
  private readonly BLOCK_NUMBER_CACHE_TTL = 5000; // 5 seconds cache
  private readonly depositPredictor: DepositCountPredictor;

  constructor(config: ExtendedMonitorConfig) {
    super();
    this.config = config;
    this.db = config.database;
    this.provider = config.provider;
    this.errorLogger = config.errorLogger;
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
    this.eventProcessor = new EventProcessor(
      this.db,
      this.logger,
      this.errorLogger,
    );
    this.isRunning = false;
    this.lastProcessedBlock = config.startBlock;
    this.depositScanInProgress = false;
    this.cachedBlockNumber = 0;
    this.lastBlockNumberUpdate = 0;
    this.depositPredictor = new DepositCountPredictor(this.contract, this.logger);
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

    try {
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

      // Don't automatically run the deposit discovery scan - it's resource intensive
      // Only run it when explicitly called via discoverMissingDeposits()
      this.logger.info(
        'Monitor started successfully. Deposit discovery scan can be run manually if needed.',
      );
    } catch (error) {
      this.logger.error('Failed to start monitor:', { error });
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'monitor-start',
        });
      }
      throw error;
    }
  }

  /**
   * Stops the monitor process gracefully.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    try {
      this.isRunning = false;
      if (this.processingPromise) {
        await this.processingPromise;
      }
    } catch (error) {
      this.logger.error('Error stopping monitor:', { error });
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'monitor-stop',
        });
      }
      throw error;
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
    try {
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
    } catch (error) {
      this.logger.error('Error getting monitor status:', { error });
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'get-monitor-status',
        });
      }
      throw error;
    }
  }

  private async getCurrentBlock(): Promise<number> {
    try {
      const now = Date.now();

      // Use cached block number if it's still fresh
      if (
        this.cachedBlockNumber > 0 &&
        now - this.lastBlockNumberUpdate < this.BLOCK_NUMBER_CACHE_TTL
      ) {
        return this.cachedBlockNumber;
      }

      // Fetch fresh block number
      const blockNumber = await this.provider.getBlockNumber();
      this.cachedBlockNumber = blockNumber;
      this.lastBlockNumberUpdate = now;

      return blockNumber;
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'get-current-block',
        });
      }
      throw error;
    }
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

        if (this.errorLogger) {
          await this.errorLogger.error(error as Error, {
            context: 'processing-loop',
            fromBlock: this.lastProcessedBlock + 1,
          });
        }

        await new Promise((resolve) =>
          setTimeout(resolve, this.config.pollInterval * 1000),
        );
      }
    }
  }

  /**
   * Retry function with exponential backoff for rate limiting
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries = 3
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Check if it's a rate limiting error
        if (errorMessage.includes('compute units per second capacity') || 
            errorMessage.includes('429') || 
            errorMessage.includes('rate limit')) {
          
          if (attempt < maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Exponential backoff, max 5s
            this.logger.warn(
              `Rate limit hit for ${operationName}, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`
            );
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
        
        // If it's not a rate limit error or we've exhausted retries, throw
        throw error;
      }
    }
    
    throw new Error(`Failed after ${maxRetries} attempts`);
  }

  /**
   * Queries contract events in batches for improved efficiency
   * @param contract - Contract instance to query
   * @param eventNames - Array of event names to query
   * @param fromBlock - Starting block number
   * @param toBlock - Ending block number
   * @returns Flattened array of all events
   */
  private async queryContractEvents(
    contract: ethers.Contract,
    eventNames: string[],
    fromBlock: number,
    toBlock: number,
  ): Promise<ethers.Log[]> {
    try {
      // Execute event queries sequentially with rate limiting to avoid CU/second limits
      // Each eth_getLogs costs 60 CUs, so we need to be careful with parallel requests
      const allEvents: ethers.Log[] = [];
      
      for (const eventName of eventNames) {
        try {
          const filter = contract.filters[eventName];
          if (typeof filter === 'function') {
            // Retry with exponential backoff for rate limiting
            const events = await this.retryWithBackoff(async () => {
              return await contract.queryFilter(filter(), fromBlock, toBlock);
            }, eventName);
            
            allEvents.push(...events);
            
            // Add delay between requests to respect rate limits (60 CUs each)
            // Small delay to stay under CU/second capacity
            if (eventNames.indexOf(eventName) < eventNames.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 150)); // 150ms delay
            }
          }
        } catch (error) {
          this.logger.warn(
            `Failed to query ${eventName} events after retries: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      
      return allEvents;
    } catch (error) {
      this.logger.error('Error in batch event querying:', {
        error: error instanceof Error ? error.message : String(error),
        contractAddress: await contract.getAddress(),
        eventNames,
        fromBlock,
        toBlock,
      });
      return [];
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
    try {
      this.logger.info(`Processing blocks ${fromBlock} to ${toBlock}`);

      // Query events in batches for better efficiency
      const [lstContractEvents, stakerContractEvents] = await Promise.all([
        this.queryContractEvents(
          this.lstContract,
          [
            'Staked',
            'StakedWithAttribution',
            'Unstaked',
            'DepositInitialized',
            'DepositUpdated',
            'DepositSubsidized',
          ],
          fromBlock,
          toBlock,
        ),
        this.queryContractEvents(
          this.contract,
          [
            'StakeDeposited',
            'StakeWithdrawn',
            'DelegateeAltered',
            'ClaimerAltered',
            'RewardClaimed',
            'EarningPowerBumped',
            'RewardNotified',
          ],
          fromBlock,
          toBlock,
        ),
      ]);

      // Helper function to filter events by topic hash
      const filterEventsByTopic = (
        events: ethers.Log[],
        eventSignature: string,
      ): ethers.Log[] => {
        const topic = ethers.id(eventSignature);
        return events.filter((log) => log.topics[0] === topic);
      };

      // Filter LST contract events by type
      const lstDepositEvents = filterEventsByTopic(
        lstContractEvents,
        'Staked(address,uint256)',
      );
      const stakedWithAttributionEvents = filterEventsByTopic(
        lstContractEvents,
        'StakedWithAttribution(address,uint256,uint256)',
      );
      const unstakedEvents = filterEventsByTopic(
        lstContractEvents,
        'Unstaked(address,uint256)',
      );
      const depositInitializedEvents = filterEventsByTopic(
        lstContractEvents,
        'DepositInitialized(uint256,address)',
      );
      const depositUpdatedEvents = filterEventsByTopic(
        lstContractEvents,
        'DepositUpdated(uint256,uint256,uint256)',
      );
      const depositSubsidizedEvents = filterEventsByTopic(
        lstContractEvents,
        'DepositSubsidized(uint256,uint256)',
      );

      // Filter Staker contract events by type
      const depositedEvents = filterEventsByTopic(
        stakerContractEvents,
        'StakeDeposited(address,uint256,uint256)',
      );
      const withdrawnEvents = filterEventsByTopic(
        stakerContractEvents,
        'StakeWithdrawn(uint256,uint256,uint256)',
      );
      const alteredEvents = filterEventsByTopic(
        stakerContractEvents,
        'DelegateeAltered(uint256,address)',
      );
      const claimerAlteredEvents = filterEventsByTopic(
        stakerContractEvents,
        'ClaimerAltered(uint256,address)',
      );
      const rewardClaimedEvents = filterEventsByTopic(
        stakerContractEvents,
        'RewardClaimed(uint256,address,uint256)',
      );
      const earningPowerBumpedEvents = filterEventsByTopic(
        stakerContractEvents,
        'EarningPowerBumped(uint256,uint256,uint256)',
      );
      const rewardNotifiedEvents = filterEventsByTopic(
        stakerContractEvents,
        'RewardNotified(uint256,uint256,uint256)',
      );

      this.logger.info('Events found:', {
        lstDeposit: lstDepositEvents.length,
        deposited: depositedEvents.length,
        withdrawn: withdrawnEvents.length,
        altered: alteredEvents.length,
        stakedWithAttribution: stakedWithAttributionEvents.length,
        unstaked: unstakedEvents.length,
        depositInitialized: depositInitializedEvents.length,
        depositUpdated: depositUpdatedEvents.length,
        claimerAltered: claimerAlteredEvents.length,
        rewardClaimed: rewardClaimedEvents.length,
        depositSubsidized: depositSubsidizedEvents.length,
        earningPowerBumped: earningPowerBumpedEvents.length,
        rewardNotified: rewardNotifiedEvents.length,
      });

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
        claimerAltered: sortEvents(claimerAlteredEvents),
        rewardClaimed: sortEvents(rewardClaimedEvents),
        depositSubsidized: sortEvents(depositSubsidizedEvents),
        earningPowerBumped: sortEvents(earningPowerBumpedEvents),
        rewardNotified: sortEvents(rewardNotifiedEvents),
      };

      const eventsByTx = new Map<string, EventGroup>();

      // Group all events by transaction hash
      const addEventsToGroup = (
        events: ethers.Log[],
        key: keyof EventGroup,
      ) => {
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
      addEventsToGroup(sortedEvents.claimerAltered, 'claimerAltered');
      addEventsToGroup(sortedEvents.rewardClaimed, 'rewardClaimed');
      addEventsToGroup(sortedEvents.depositSubsidized, 'depositSubsidized');
      addEventsToGroup(sortedEvents.earningPowerBumped, 'earningPowerBumped');

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
            events.claimerAltered?.blockNumber ||
            events.rewardClaimed?.blockNumber ||
            events.depositSubsidized?.blockNumber ||
            events.earningPowerBumped?.blockNumber ||
            0,
        }))
        .sort((a, b) => a.blockNumber - b.blockNumber);

      await this.processTransactions(txEntries);
      await this.processStandaloneEvents(sortedEvents);
    } catch (error) {
      this.logger.error('Error processing block range:', {
        error,
        fromBlock,
        toBlock,
      });

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'process-block-range',
          fromBlock,
          toBlock,
        });
      }

      throw new MonitorError(
        `Failed to process block range ${fromBlock}-${toBlock}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { fromBlock, toBlock },
        true, // This error is retryable
      );
    }
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

      // Process deposit subsidy events
      if (events.depositSubsidized) {
        const event = events.depositSubsidized;
        const { depositId, amount } = event.args;
        await this.handleDepositSubsidized({
          depositId: depositId.toString(),
          amount,
          blockNumber: event.blockNumber!,
          transactionHash: event.transactionHash!,
        });
      }

      // Process claimer altered events
      if (events.claimerAltered) {
        const event = events.claimerAltered;
        const { depositId, oldClaimer, newClaimer, earningPower } = event.args;
        await this.handleClaimerAltered({
          depositId: depositId.toString(),
          oldClaimer,
          newClaimer,
          earningPower,
          blockNumber: event.blockNumber!,
          transactionHash: event.transactionHash!,
        });
      }

      // Process reward claimed events
      if (events.rewardClaimed) {
        const event = events.rewardClaimed;
        const { depositId, claimer, amount, earningPower } = event.args;
        await this.handleRewardClaimed({
          depositId: depositId.toString(),
          claimer,
          amount,
          earningPower,
          blockNumber: event.blockNumber!,
          transactionHash: event.transactionHash!,
        });
      }

      // Process earning power bumped events
      if (events.earningPowerBumped) {
        const event = events.earningPowerBumped;
        const {
          depositId,
          1: oldEarningPower,
          2: newEarningPower,
          3: bumper,
          4: tipReceiver,
          5: tipAmount,
        } = event.args;
        await this.handleEarningPowerBumped({
          depositId: depositId.toString(),
          oldEarningPower,
          newEarningPower,
          bumper,
          tipReceiver,
          tipAmount,
          blockNumber: event.blockNumber!,
          transactionHash: event.transactionHash!,
        });
      }

      // Process reward notified events
      if (events.rewardNotified) {
        const event = events.rewardNotified;
        const { amount, notifier } = event.args;
        this.logger.info('Reward notification detected', {
          amount: amount.toString(),
          notifier,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
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

        // Verify owner address against contract data to ensure accuracy
        try {
          if (this.contract && typeof this.contract.deposits === 'function') {
            const contractData = await this.contract.deposits(depositIdString);
            if (contractData && contractData[0]) {
              // Use the owner from the contract if available
              const contractOwner = contractData[0];
              if (contractOwner !== ownerAddress) {
                this.logger.info(
                  `Correcting owner address for deposit ${depositIdString}`,
                  {
                    eventOwner: ownerAddress,
                    contractOwner,
                  },
                );
                await this.handleStakeDeposited({
                  depositId: depositIdString,
                  ownerAddress: contractOwner,
                  delegateeAddress,
                  depositorAddress,
                  amount,
                  blockNumber: depositEvent.blockNumber!,
                  transactionHash: depositEvent.transactionHash!,
                });
                return;
              }
            }
          }
        } catch (error) {
          this.logger.warn(
            `Could not verify owner for deposit ${depositIdString}`,
            { error },
          );
          // Continue with event data if contract check fails
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
   * Fetches deposit data from the contract and syncs it to the database.
   * Returns the deposit data if successful.
   *
   * @param depositId - The ID of the deposit to fetch and sync
   * @returns The deposit data from the database after syncing
   */
  private async fetchAndSyncDeposit(
    depositId: string,
  ): Promise<Deposit | null> {
    try {
      if (!this.contract || typeof this.contract.deposits !== 'function') {
        throw new Error(
          'Contract not properly initialized or missing deposits method',
        );
      }

      // Get deposit data from contract
      const depositData = await this.contract.deposits(depositId);
      if (!depositData || !depositData[0]) {
        throw new Error(`No deposit found on-chain for ID ${depositId}`);
      }

      const { owner, amount, earningPower, delegatee } = depositData;

      // Create or update the deposit in the database
      const depositRecord = {
        deposit_id: depositId,
        owner_address: owner,
        depositor_address: owner, // Use owner as depositor since we don't have the original
        delegatee_address: delegatee || DEFAULT_DELEGATEE_ADDRESS,
        amount: amount?.toString() || '0',
        earning_power: earningPower?.toString() || '0',
        updated_at: new Date().toISOString(),
      };

      const existingDeposit = await this.db.getDeposit(depositId);
      if (existingDeposit) {
        await this.db.updateDeposit(depositId, depositRecord);
        this.logger.info('Updated deposit from contract data', {
          depositId,
          owner,
          balance: amount?.toString(),
        });
      } else {
        await this.db.createDeposit({
          ...depositRecord,
          created_at: new Date().toISOString(),
        });
        this.logger.info('Created new deposit from contract data', {
          depositId,
          owner,
          balance: amount?.toString(),
        });
      }

      return await this.db.getDeposit(depositId);
    } catch (error) {
      this.logger.error('Error fetching and syncing deposit from contract:', {
        error,
        depositId,
      });
      throw error;
    }
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
        let deposit = await this.db.getDeposit(event.depositId);

        // If deposit not found, try to fetch from contract
        if (!deposit) {
          this.logger.info(
            'Deposit not found in database, fetching from contract',
            {
              depositId: event.depositId,
            },
          );
          deposit = await this.fetchAndSyncDeposit(event.depositId);
        }

        if (!deposit) {
          throw new EventProcessingError(
            EVENT_TYPES.STAKE_WITHDRAWN,
            new Error(
              `Failed to process StakeWithdrawn event - deposit ${event.depositId} not found`,
            ),
            { event },
          );
        }

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

        let deposit = await this.db.getDeposit(event.depositId);

        // If deposit not found, try to fetch from contract
        if (!deposit) {
          this.logger.info(
            'Deposit not found in database, fetching from contract',
            {
              depositId: event.depositId,
            },
          );
          deposit = await this.fetchAndSyncDeposit(event.depositId);
        }

        if (!deposit) {
          throw new EventProcessingError(
            EVENT_TYPES.DELEGATEE_ALTERED,
            new Error(
              `Failed to process DelegateeAltered event - deposit ${event.depositId} not found`,
            ),
            { event },
          );
        }

        const result = await this.eventProcessor.processDelegateeAltered(event);
        if (result.success || !result.retryable) {
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
      try {
        // Check if deposit exists
        const existingDeposit = await this.db.getDeposit(event.depositId);

        // If deposit doesn't exist, create a basic entry
        if (!existingDeposit) {
          await this.db.createDeposit({
            deposit_id: event.depositId,
            owner_address: event.delegatee,
            depositor_address: event.delegatee,
            delegatee_address: event.delegatee,
            amount: '0', // Initial amount is 0
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });

          this.logger.info('Created new deposit for initialization', {
            depositId: event.depositId,
            delegatee: event.delegatee,
          });
        }

        this.emit(MONITOR_EVENTS.DEPOSIT_INITIALIZED, event);
      } catch (error) {
        if (error instanceof MonitorError) throw error;
        throw new EventProcessingError(
          EVENT_TYPES.DEPOSIT_INITIALIZED,
          error as Error,
          { event },
        );
      }
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
   * Handles a DepositSubsidized event.
   * Creates or updates a deposit record for subsidized deposits.
   */
  private async handleDepositSubsidized(
    event: DepositSubsidizedEvent,
  ): Promise<void> {
    await this.withRetry(async () => {
      try {
        let deposit = await this.db.getDeposit(event.depositId);

        // If deposit not found, try to fetch from contract
        if (!deposit) {
          this.logger.info(
            'Deposit not found in database, fetching from contract',
            {
              depositId: event.depositId,
            },
          );
          deposit = await this.fetchAndSyncDeposit(event.depositId);
        }

        if (!deposit) {
          throw new EventProcessingError(
            EVENT_TYPES.DEPOSIT_SUBSIDIZED,
            new Error(
              `Failed to process DepositSubsidized event - deposit ${event.depositId} not found`,
            ),
            { event },
          );
        }

        // Update existing deposit with new amount
        const newAmount =
          BigInt(deposit.amount) + BigInt(event.amount.toString());
        await this.db.updateDeposit(event.depositId, {
          amount: newAmount.toString(),
          updated_at: new Date().toISOString(),
        });

        this.logger.info('Updated subsidized deposit', {
          depositId: event.depositId,
          newAmount: newAmount.toString(),
        });

        this.emit(MONITOR_EVENTS.DEPOSIT_SUBSIDIZED, event);
        return {
          success: true,
          blockNumber: event.blockNumber,
          eventHash: event.transactionHash,
          retryable: false,
        };
      } catch (error) {
        if (error instanceof MonitorError) throw error;
        throw new EventProcessingError(
          EVENT_TYPES.DEPOSIT_SUBSIDIZED,
          error as Error,
          { event },
        );
      }
    }, 'process DepositSubsidized event');
  }

  /**
   * Handles a ClaimerAltered event.
   * Updates the deposit record with new claimer information.
   */
  private async handleClaimerAltered(
    event: ClaimerAlteredEvent,
  ): Promise<void> {
    await this.withRetry(async () => {
      try {
        let deposit = await this.db.getDeposit(event.depositId);

        // If deposit not found, try to fetch from contract
        if (!deposit) {
          this.logger.info(
            'Deposit not found in database, fetching from contract',
            {
              depositId: event.depositId,
            },
          );
          deposit = await this.fetchAndSyncDeposit(event.depositId);
        }

        if (!deposit) {
          throw new EventProcessingError(
            EVENT_TYPES.CLAIMER_ALTERED,
            new Error(
              `Failed to process ClaimerAltered event - deposit ${event.depositId} not found`,
            ),
            { event },
          );
        }

        // Update existing deposit with earning power
        await this.db.updateDeposit(event.depositId, {
          earning_power: event.earningPower.toString(),
          updated_at: new Date().toISOString(),
        });

        this.logger.info('Updated deposit after claimer altered', {
          depositId: event.depositId,
          oldClaimer: event.oldClaimer,
          newClaimer: event.newClaimer,
        });

        this.emit(MONITOR_EVENTS.CLAIMER_ALTERED, event);
        return {
          success: true,
          blockNumber: event.blockNumber,
          eventHash: event.transactionHash,
          retryable: false,
        };
      } catch (error) {
        if (error instanceof MonitorError) throw error;
        throw new EventProcessingError(
          EVENT_TYPES.CLAIMER_ALTERED,
          error as Error,
          { event },
        );
      }
    }, 'process ClaimerAltered event');
  }

  /**
   * Handles a RewardClaimed event.
   * Updates the deposit record with current earning power.
   */
  private async handleRewardClaimed(event: RewardClaimedEvent): Promise<void> {
    await this.withRetry(async () => {
      try {
        let deposit = await this.db.getDeposit(event.depositId);

        // If deposit not found, try to fetch from contract
        if (!deposit) {
          this.logger.info(
            'Deposit not found in database, fetching from contract',
            {
              depositId: event.depositId,
            },
          );
          deposit = await this.fetchAndSyncDeposit(event.depositId);
        }

        if (!deposit) {
          throw new EventProcessingError(
            EVENT_TYPES.REWARD_CLAIMED,
            new Error(
              `Failed to process RewardClaimed event - deposit ${event.depositId} not found`,
            ),
            { event },
          );
        }

        // Update existing deposit with current earning power
        await this.db.updateDeposit(event.depositId, {
          earning_power: event.earningPower.toString(),
          updated_at: new Date().toISOString(),
        });

        this.logger.info('Updated deposit after reward claimed', {
          depositId: event.depositId,
          claimer: event.claimer,
          amount: event.amount.toString(),
        });

        this.emit(MONITOR_EVENTS.REWARD_CLAIMED, event);
        return {
          success: true,
          blockNumber: event.blockNumber,
          eventHash: event.transactionHash,
          retryable: false,
        };
      } catch (error) {
        if (error instanceof MonitorError) throw error;
        throw new EventProcessingError(
          EVENT_TYPES.REWARD_CLAIMED,
          error as Error,
          { event },
        );
      }
    }, 'process RewardClaimed event');
  }

  /**
   * Handles an EarningPowerBumped event.
   * Updates the deposit record with the new earning power.
   */
  private async handleEarningPowerBumped(
    event: EarningPowerBumpedEvent,
  ): Promise<void> {
    await this.withRetry(async () => {
      try {
        let deposit = await this.db.getDeposit(event.depositId);

        // If deposit not found, try to fetch from contract
        if (!deposit) {
          this.logger.info(
            'Deposit not found in database, fetching from contract',
            {
              depositId: event.depositId,
            },
          );
          deposit = await this.fetchAndSyncDeposit(event.depositId);
        }

        if (!deposit) {
          throw new EventProcessingError(
            EVENT_TYPES.EARNING_POWER_BUMPED,
            new Error(
              `Failed to process EarningPowerBumped event - deposit ${event.depositId} not found`,
            ),
            { event },
          );
        }

        // Update existing deposit with new earning power
        await this.db.updateDeposit(event.depositId, {
          earning_power: event.newEarningPower.toString(),
          updated_at: new Date().toISOString(),
        });

        this.logger.info('Updated deposit after earning power bump', {
          depositId: event.depositId,
          oldEarningPower: event.oldEarningPower.toString(),
          newEarningPower: event.newEarningPower.toString(),
          bumper: event.bumper,
          tipReceiver: event.tipReceiver,
          tipAmount: event.tipAmount.toString(),
        });

        // Emit the event for other components to handle
        this.emit(MONITOR_EVENTS.EARNING_POWER_BUMPED, event);

        return {
          success: true,
          blockNumber: event.blockNumber,
          eventHash: event.transactionHash,
          retryable: false,
        };
      } catch (error) {
        if (error instanceof MonitorError) throw error;
        throw new EventProcessingError(
          EVENT_TYPES.EARNING_POWER_BUMPED,
          error as Error,
          { event },
        );
      }
    }, 'process EarningPowerBumped event');
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
   * Discovers deposits directly by querying the contract
   * This method helps identify deposits that might have been missed due to event filtering issues
   */
  async discoverMissingDeposits(): Promise<void> {
    if (this.depositScanInProgress) {
      this.logger.info('Deposit discovery already in progress, skipping');
      return;
    }

    try {
      this.depositScanInProgress = true;
      this.logger.info('Starting deposit discovery process');

      // Get existing deposits from database
      const existingDepositIds = new Set<string>();
      const deposits = await this.db.getAllDeposits();
      deposits.forEach((deposit) => existingDepositIds.add(deposit.deposit_id));

      this.logger.info(`Found ${existingDepositIds.size} deposits in database`);

      // Get predicted scan limit to reduce API calls
      const predictedScanLimit = await this.depositPredictor.getPredictedScanLimit();
      const stats = this.depositPredictor.getStats();
      
      this.logger.info(`🔮 Deposit prediction stats`, {
        predictedLimit: predictedScanLimit,
        lastKnownMax: stats.lastKnownMax,
        avgGrowthPerMin: stats.avgGrowthPerMinute.toFixed(2),
        sampleCount: stats.samples,
        lastSampleMinutesAgo: stats.lastSampleMinutesAgo.toFixed(1)
      });

      // Process sequentially starting from deposit ID 1, but limit scan range
      let currentId = 1;
      let emptyCounter = 0;
      const MAX_EMPTY_TO_STOP = 10; // Very conservative - only stop after many empty deposits

      this.logger.info(`Starting sequential deposit scan from ID ${currentId} to ~${predictedScanLimit}`);

      // Keep scanning until we find many consecutive completely empty deposits OR reach predicted limit
      while (emptyCounter < MAX_EMPTY_TO_STOP && currentId <= predictedScanLimit) {
        try {
          if (!this.contract || typeof this.contract.deposits !== 'function') {
            throw new Error(
              'Contract not properly initialized or missing deposits method',
            );
          }

          // Get deposit data from contract
          const deposit = await this.contract.deposits(currentId);

          // Extract all fields from the deposit data, always using fallbacks
          const owner = deposit[0] || ethers.ZeroAddress;
          const amount = deposit[1] || BigInt(0);
          const earningPower = deposit[2] || BigInt(0);
          const delegatee = deposit[3] || ethers.ZeroAddress;
          const claimer = deposit[4] || owner;

          // Convert to strings for logging and storage
          const amountStr = amount.toString();
          const earningPowerStr = earningPower.toString();

          // Log the deposit data for debugging
          this.logger.info(`Deposit ${currentId} data:`, {
            owner,
            amount: amountStr,
            earningPower: earningPowerStr,
            delegatee,
            claimer,
          });

          // Check if this is a completely empty deposit or has zero addresses for important fields
          const isCompletelyEmpty =
            owner === ethers.ZeroAddress &&
            amountStr === '0' &&
            earningPowerStr === '0' &&
            delegatee === ethers.ZeroAddress;

          if (isCompletelyEmpty) {
            emptyCounter++;
            this.logger.info(
              `Empty deposit at ID ${currentId}, counter: ${emptyCounter}/${MAX_EMPTY_TO_STOP}`,
            );
          } else {
            // Reset counter when we find a non-empty deposit
            emptyCounter = 0;

            // Only add valid deposits - skip deposits with zero owner AND zero delegatee
            const isValidDeposit = !(
              owner === ethers.ZeroAddress && delegatee === ethers.ZeroAddress
            );

            if (isValidDeposit) {
              // ALWAYS save/update the deposit if it's valid
              const depositIdStr = currentId.toString();

              if (!existingDepositIds.has(depositIdStr)) {
                // Create new deposit record
                await this.db.createDeposit({
                  deposit_id: depositIdStr,
                  owner_address: owner,
                  depositor_address: owner, // Use owner as depositor
                  delegatee_address: delegatee,
                  amount: amountStr,
                  earning_power: earningPowerStr,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                });

                this.logger.info(
                  `Added deposit ID ${depositIdStr} to database`,
                );
              } else {
                // Always update existing deposits to ensure we have latest data
                const existingDeposit = await this.db.getDeposit(depositIdStr);

                if (existingDeposit) {
                  await this.db.updateDeposit(depositIdStr, {
                    owner_address: owner,
                    depositor_address: owner,
                    delegatee_address: delegatee,
                    amount: amountStr,
                    earning_power: earningPowerStr,
                    updated_at: new Date().toISOString(),
                  });

                  this.logger.info(
                    `Updated deposit ID ${depositIdStr} in database`,
                  );
                }
              }
            } else {
              this.logger.info(
                `Skipping deposit ID ${currentId} - invalid zero addresses for both owner and delegatee`,
              );
            }
          }
        } catch (error) {
          this.logger.error(`Error processing deposit ID ${currentId}:`, {
            error,
          });
          // Still increment counter on errors - might be a non-existent deposit
          emptyCounter++;
        }

        // Always move to next deposit ID
        currentId++;

        // Add a small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      this.logger.info(
        `Deposit discovery completed, processed IDs 1-${currentId - 1}`,
      );
    } catch (error) {
      this.logger.error('Error in deposit discovery:', { error });
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: 'discover-missing-deposits',
        });
      }
    } finally {
      this.depositScanInProgress = false;
    }
  }
}
