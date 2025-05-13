import { ethers } from "ethers";
import { EventEmitter } from "events";
import { IDatabase } from "@/database";
import { EventProcessor } from "./EventProcessor";
import { ConsoleLogger, Logger } from "./logging";
import {
  MonitorConfig,
  MonitorStatus,
  StakeDepositedEvent,
  StakeWithdrawnEvent,
  DelegateeAlteredEvent,
  EarningPowerBumpedEvent,
} from "./types";
import { MONITOR_EVENTS, PROCESSING_COMPONENT } from "./constants";
import { MonitorError } from "./errors";
import { ErrorLogger } from "@/configuration/errorLogger";
import { stakerAbi } from "@/configuration/abis";

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
  private readonly logger: Logger;
  private readonly errorLogger?: ErrorLogger;
  private readonly eventProcessor: EventProcessor;
  private readonly config: MonitorConfig;
  private isRunning: boolean;
  private processingPromise?: Promise<void>;
  private lastProcessedBlock: number;

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
    this.logger = new ConsoleLogger(config.logLevel);
    this.eventProcessor = new EventProcessor(
      this.db,
      this.logger,
      this.errorLogger,
    );
    this.isRunning = false;
    this.lastProcessedBlock = config.startBlock;

    // Verify the contract ABI contains EarningPowerBumped
    const contractInterface = this.contract.interface;
    const eventFragments = Object.values(contractInterface.fragments).filter(
      (fragment) => fragment.type === "event",
    );

    this.logger.info("StakerMonitor initialized with contract interface", {
      contractAddress: config.stakerAddress,
      eventCount: eventFragments.length,
      eventTypes: eventFragments.map((f) => f.format()),
      hasEarningPowerBumped: eventFragments.some((f) =>
        f.format().includes("EarningPowerBumped"),
      ),
      filters: Object.keys(this.contract.filters),
    });

    // Check if the ABI fragment for EarningPowerBumped exists
    const earningPowerBumpedFragment = eventFragments.find((fragment) =>
      fragment.format().includes("EarningPowerBumped"),
    );

    if (!earningPowerBumpedFragment) {
      this.logger.warn("EarningPowerBumped event not found in contract ABI", {
        availableEvents: eventFragments.map((f) => f.format()),
      });
    } else {
      this.logger.info("EarningPowerBumped event found in contract ABI", {
        fragment: earningPowerBumpedFragment.format(),
        eventSignature: earningPowerBumpedFragment
          .format()
          .replace("event ", ""),
      });
    }
  }

  /**
   * Starts the monitor process. If already running, logs a warning and returns.
   * Resumes from last checkpoint if available, otherwise starts from configured block.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("Monitor is already running");
      return;
    }

    try {
      this.isRunning = true;
      this.logger.info("Looking up checkpoint for component type:", {
        componentType: PROCESSING_COMPONENT.TYPE,
      });

      const checkpoint = await this.db.getCheckpoint(PROCESSING_COMPONENT.TYPE);
      this.logger.info("Checkpoint lookup result:", {
        hasCheckpoint: !!checkpoint,
        checkpoint: checkpoint,
        componentType: PROCESSING_COMPONENT.TYPE,
      });

      if (checkpoint) {
        this.lastProcessedBlock = checkpoint.last_block_number;
        this.logger.info("Resuming from checkpoint", {
          blockNumber: this.lastProcessedBlock,
          blockHash: checkpoint.block_hash,
          lastUpdate: checkpoint.last_update,
        });
      } else {
        this.logger.warn("No checkpoint found, initializing with start block", {
          startBlock: this.config.startBlock,
          componentType: PROCESSING_COMPONENT.TYPE,
          config: {
            ...this.config,
            provider: "<provider>", // Don't log the full provider
            database: "<database>", // Don't log the full database
          },
        });

        // Initialize with start block if no checkpoint exists
        this.lastProcessedBlock = this.config.startBlock;
        await this.db.updateCheckpoint({
          component_type: PROCESSING_COMPONENT.TYPE,
          last_block_number: this.config.startBlock,
          block_hash: PROCESSING_COMPONENT.INITIAL_BLOCK_HASH,
          last_update: new Date().toISOString(),
        });
        this.logger.info("Created initial checkpoint", {
          blockNumber: this.lastProcessedBlock,
          componentType: PROCESSING_COMPONENT.TYPE,
        });
      }

      this.processingPromise = this.processLoop();
    } catch (error) {
      this.logger.error("Failed to start monitor:", { error });
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: "monitor-start",
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
      this.logger.info("Staker Monitor stopped");
    } catch (error) {
      this.logger.error("Error stopping monitor:", { error });
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: "monitor-stop",
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
      const processingLag = await this.getProcessingLag();
      const checkpoint = await this.db.getCheckpoint(PROCESSING_COMPONENT.TYPE);

      return {
        isRunning: this.isRunning,
        lastProcessedBlock: this.lastProcessedBlock,
        currentChainBlock: currentBlock,
        processingLag,
        lastCheckpoint: checkpoint!,
        networkStatus: {
          chainId: this.config.chainId,
          networkName: this.config.networkName,
          isConnected: true,
        },
      };
    } catch (error) {
      this.logger.error("Error getting monitor status:", { error });
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: "get-monitor-status",
        });
      }
      throw error;
    }
  }

  /**
   * Gets the current block number from the provider
   */
  async getCurrentBlock(): Promise<number> {
    try {
      return await this.provider.getBlockNumber();
    } catch (error) {
      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: "get-current-block",
        });
      }
      throw new MonitorError(
        "Failed to get current block number",
        { error },
        true,
      );
    }
  }

  /**
   * Gets the last processed block number
   */
  async getLastProcessedBlock(): Promise<number> {
    return this.lastProcessedBlock;
  }

  /**
   * Calculates the processing lag (difference between current chain block and last processed block)
   */
  async getProcessingLag(): Promise<number> {
    const currentBlock = await this.getCurrentBlock();
    return currentBlock - this.lastProcessedBlock;
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
        this.logger.error("Error in processing loop", {
          error,
          lastProcessedBlock: this.lastProcessedBlock,
        });

        if (this.errorLogger) {
          await this.errorLogger.error(error as Error, {
            context: "processing-loop",
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
   * Processes events within a specified block range.
   * Fetches and processes StakeDeposited, StakeWithdrawn, DelegateeAltered, and EarningPowerBumped events.
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
      // One-time diagnostic query for any EarningPowerBumped events in a large range
      // Only do this once per run for diagnostic purposes
      if (fromBlock === this.config.startBlock + 1) {
        try {
          this.logger.info(
            "Running one-time diagnostic query for EarningPowerBumped events...",
          );

          // Get event signature from ABI
          const earningPowerBumpedFragment =
            this.contract.interface.fragments.find(
              (f) =>
                f.type === "event" && f.format().includes("EarningPowerBumped"),
            );

          if (earningPowerBumpedFragment) {
            const eventSignature = earningPowerBumpedFragment
              .format()
              .replace("event ", "");
            const earningPowerBumpedTopic = ethers.id(eventSignature);

            // Query for a large recent range of blocks
            const diagnosticFromBlock = Math.max(
              1,
              this.config.startBlock - 1000000,
            );
            const diagnosticToBlock = this.config.startBlock + 10000;

            this.logger.info(
              "Wide-range diagnostic query for EarningPowerBumped events",
              {
                fromBlock: diagnosticFromBlock,
                toBlock: diagnosticToBlock,
                range: diagnosticToBlock - diagnosticFromBlock,
                topic: earningPowerBumpedTopic,
              },
            );

            try {
              // Query in smaller chunks to avoid timeout
              const chunkSize = 100000;
              let foundEventsCount = 0;

              for (
                let start = diagnosticFromBlock;
                start < diagnosticToBlock;
                start += chunkSize
              ) {
                const end = Math.min(start + chunkSize - 1, diagnosticToBlock);

                this.logger.info(`Querying chunk ${start}-${end}...`);

                const logs = await this.provider.getLogs({
                  address: this.contract.target,
                  topics: [earningPowerBumpedTopic],
                  fromBlock: BigInt(start),
                  toBlock: BigInt(end),
                });

                foundEventsCount += logs.length;

                if (logs.length > 0) {
                  this.logger.info(
                    `Found ${logs.length} logs in chunk ${start}-${end}`,
                  );
                }
              }

              this.logger.info(
                `Diagnostic search complete. Found ${foundEventsCount} total logs.`,
              );
            } catch (wideRangeError) {
              this.logger.error("Error in wide-range diagnostic query", {
                error: wideRangeError,
              });
            }
          }
        } catch (diagnosticError) {
          this.logger.error("Error in diagnostic query", {
            error: diagnosticError,
          });
        }
      }

      try {
        // Query all events in parallel
        const [depositedEvents, withdrawnEvents, alteredEvents] =
          await Promise.all([
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
          ]);

        // Also query for EarningPowerBumped events
        const earningPowerBumpedFragment =
          this.contract.interface.fragments.find(
            (f) =>
              f.type === "event" && f.format().includes("EarningPowerBumped"),
          );

        let bumpedEvents: Array<ethers.Log> = [];

        if (earningPowerBumpedFragment) {
          // Get the exact event signature from the ABI
          const eventSignature = earningPowerBumpedFragment
            .format()
            .replace("event ", "");
          const earningPowerBumpedTopic = ethers.id(eventSignature);

          // Direct logs query for EarningPowerBumped events
          const logs = await this.provider.getLogs({
            address: this.contract.target,
            topics: [earningPowerBumpedTopic],
            fromBlock: BigInt(fromBlock),
            toBlock: BigInt(toBlock),
          });

          // Log the raw logs for debugging if any found
          if (logs.length > 0) {
            const firstLog = logs[0];
            if (firstLog) {
              this.logger.info("Raw EarningPowerBumped log details:", {
                blockNumber: firstLog.blockNumber,
                transactionHash: firstLog.transactionHash,
                topicsCount: firstLog.topics?.length || 0,
                dataLength: firstLog.data?.length || 0,
              });
            }
          } else {
            // For debugging, try to find any events with a more generic query
            try {
              const allLogs = await this.provider.getLogs({
                address: this.contract.target,
                fromBlock: BigInt(fromBlock),
                toBlock: BigInt(toBlock),
              });

              if (allLogs.length > 0) {
                const firstLog = allLogs[0];
                if (firstLog && firstLog.topics && firstLog.topics.length > 0) {
                  this.logger.info("Found other events on the contract:", {
                    count: allLogs.length,
                    firstLogTopicHex: firstLog.topics[0],
                    topicType: "Looking up event signature...",
                  });

                  // Try to identify the event from the topic
                  try {
                    for (const fragment of this.contract.interface.fragments) {
                      if (fragment.type === "event") {
                        const eventSig = fragment
                          .format()
                          .replace("event ", "");
                        const topic = ethers.id(eventSig);
                        if (topic === firstLog.topics[0]) {
                          this.logger.info("Identified event type:", {
                            eventSignature: eventSig,
                            eventFormat: fragment.format(),
                          });
                          break;
                        }
                      }
                    }
                  } catch (idError) {
                    this.logger.warn("Error identifying event type", {
                      error: idError,
                    });
                  }
                } else {
                  this.logger.info(
                    "Found logs but missing topics information:",
                    {
                      count: allLogs.length,
                    },
                  );
                }
              }
            } catch (error) {
              this.logger.warn("Error when querying for all logs", { error });
            }
          }

          // Process logs if any found
          if (logs.length > 0) {
            bumpedEvents = logs
              .map((log) => {
                try {
                  // Parse the log using the contract interface
                  const parsedLog = this.contract.interface.parseLog({
                    topics: log.topics as string[],
                    data: log.data,
                  });

                  if (!parsedLog) {
                    this.logger.warn(
                      "Failed to parse log with contract interface",
                      {
                        transactionHash: log.transactionHash,
                        topics: log.topics,
                      },
                    );
                    return null;
                  }

                  // Create a synthetic event log that matches ethers.Log structure
                  return {
                    ...log,
                    args: parsedLog.args,
                    eventName: parsedLog.name,
                    fragment: parsedLog.fragment,
                  } as unknown as ethers.Log;
                } catch (err) {
                  this.logger.error("Failed to parse EarningPowerBumped log", {
                    error: err,
                    logData: {
                      blockNumber: log.blockNumber,
                      transactionHash: log.transactionHash,
                      topics: log.topics,
                      data: log.data,
                    },
                  });
                  return null;
                }
              })
              .filter(Boolean) as ethers.Log[];
          }
        } else {
          this.logger.warn(
            "EarningPowerBumped event not found in contract ABI, skipping query",
          );
        }

        // If we found any events, fetch and log the full blocks
        const eventBlocks = new Set([
          ...depositedEvents.map((e) => e.blockNumber),
          ...withdrawnEvents.map((e) => e.blockNumber),
          ...alteredEvents.map((e) => e.blockNumber),
          ...bumpedEvents.map((e) => e.blockNumber),
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

          this.logger.info("Full block details for block with events:", {
            blockNumber,
            blockHash: block.hash,
            timestamp: block.timestamp,
            transactions: txs.filter((tx) => tx !== null),
          });
        }

        // Process events by transaction
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
          this.logger.debug(
            "Adding StakeDeposited event to transaction group",
            {
              txHash: typedEvent.transactionHash,
              depositId: typedEvent.args.depositId.toString(),
              blockNumber: typedEvent.blockNumber,
              hasExistingAltered: !!existing.altered,
            },
          );
          eventsByTx.set(typedEvent.transactionHash, {
            ...existing,
            deposited: typedEvent,
          });
        }

        // Group DelegateeAltered events
        for (const event of alteredEvents) {
          const typedEvent = event as ethers.EventLog;
          const existing = eventsByTx.get(typedEvent.transactionHash) || {};
          this.logger.debug(
            "Adding DelegateeAltered event to transaction group",
            {
              txHash: typedEvent.transactionHash,
              depositId: typedEvent.args.depositId.toString(),
              blockNumber: typedEvent.blockNumber,
              hasExistingDeposit: !!existing.deposited,
              oldDelegatee: typedEvent.args.oldDelegatee,
              newDelegatee: typedEvent.args.newDelegatee,
            },
          );
          eventsByTx.set(typedEvent.transactionHash, {
            ...existing,
            altered: typedEvent,
          });
        }

        // Process grouped events first
        for (const [txHash, events] of eventsByTx.entries()) {
          if (events.deposited) {
            // Process deposit first
            const { depositId, owner, delegatee, amount } = events.deposited.args;
            const depositEvent: StakeDepositedEvent = {
              depositId: depositId.toString(),
              ownerAddress: owner,
              delegateeAddress: delegatee,
              amount,
              blockNumber: events.deposited.blockNumber!,
              transactionHash: txHash,
            };
            await this.handleStakeDeposited(depositEvent);

            // If there's a DelegateeAltered event in the same tx, process it
            if (events.altered) {
              const { depositId: alteredDepositId, oldDelegatee, newDelegatee } = events.altered.args;
              const alteredEvent: DelegateeAlteredEvent = {
                depositId: alteredDepositId.toString(),
                oldDelegatee,
                newDelegatee,
                blockNumber: events.altered.blockNumber!,
                transactionHash: txHash,
              };
              await this.handleDelegateeAltered(alteredEvent);
            }
          }
        }

        // Process standalone StakeWithdrawn events
        for (const event of withdrawnEvents) {
          const { depositId, amount } = (event as ethers.EventLog).args;
          const withdrawnEvent: StakeWithdrawnEvent = {
            depositId: depositId.toString(),
            withdrawnAmount: amount,
            blockNumber: event.blockNumber!,
            transactionHash: event.transactionHash!,
          };
          await this.handleStakeWithdrawn(withdrawnEvent);
        }

        // Process standalone DelegateeAltered events (ones not part of a deposit tx)
        const processedTxHashes = new Set(eventsByTx.keys());
        for (const event of alteredEvents) {
          const txHash = event.transactionHash!;
          // Skip if this tx was already processed in the grouped events
          if (processedTxHashes.has(txHash)) {
            this.logger.debug("Skipping already processed DelegateeAltered event", {
              txHash,
              depositId: (event as ethers.EventLog).args.depositId.toString(),
            });
            continue;
          }

          const { depositId, oldDelegatee, newDelegatee } = (
            event as ethers.EventLog
          ).args;
          const alteredEvent: DelegateeAlteredEvent = {
            depositId: depositId.toString(),
            oldDelegatee,
            newDelegatee,
            blockNumber: event.blockNumber!,
            transactionHash: txHash,
          };
          await this.handleDelegateeAltered(alteredEvent);
        }

        // Process EarningPowerBumped events
        if (bumpedEvents.length > 0) {
          this.logger.info(
            `Processing ${bumpedEvents.length} EarningPowerBumped events`,
          );

          for (const event of bumpedEvents) {
            try {
              const typedEvent = event as ethers.EventLog;

              // Extract event data from args
              const eventArgs = typedEvent.args;
              if (!eventArgs) {
                this.logger.error("Missing args in EarningPowerBumped event", {
                  blockNumber: typedEvent.blockNumber,
                  transactionHash: typedEvent.transactionHash,
                });
                continue;
              }

              const depositId = eventArgs.depositId.toString();
              const oldEarningPower = eventArgs.oldEarningPower;
              const newEarningPower = eventArgs.newEarningPower;
              const bumper = eventArgs.bumper;
              const tipReceiver = eventArgs.tipReceiver;
              const tipAmount = eventArgs.tipAmount;

              const bumpedEvent: EarningPowerBumpedEvent = {
                depositId,
                oldEarningPower,
                newEarningPower,
                bumper,
                tipReceiver,
                tipAmount,
                blockNumber: typedEvent.blockNumber!,
                transactionHash: typedEvent.transactionHash!,
              };

              await this.handleEarningPowerBumped(bumpedEvent);
            } catch (eventError) {
              this.logger.error(
                "Error processing individual EarningPowerBumped event",
                {
                  error: eventError,
                  eventInfo: {
                    blockNumber: event.blockNumber,
                    transactionHash: event.transactionHash,
                  },
                },
              );
            }
          }
        }
      } catch (err) {
        this.logger.error("Error processing events in block range", {
          error: err,
          fromBlock,
          toBlock,
        });
        throw err;
      }
    } catch (error) {
      this.logger.error("Error processing block range", {
        error,
        fromBlock,
        toBlock,
      });

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: "process-block-range",
          fromBlock,
          toBlock,
        });
      }

      throw error;
    }
  }

  /**
   * Handles StakeDeposited event processing
   * @param event - The StakeDeposited event to process
   */
  private async handleStakeDeposited(
    event: StakeDepositedEvent,
  ): Promise<void> {
    try {
      await this.eventProcessor.processStakeDeposited(event);
      this.emit(MONITOR_EVENTS.DEPOSIT_CREATED, {
        depositId: event.depositId,
        ownerAddress: event.ownerAddress,
        delegateeAddress: event.delegateeAddress,
        amount: event.amount.toString(),
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      });
    } catch (error) {
      this.logger.error("Failed to handle StakeDeposited event", {
        error,
        depositId: event.depositId,
      });

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: "handle-stake-deposited",
          depositId: event.depositId,
        });
      }

      throw error;
    }
  }

  /**
   * Handles StakeWithdrawn event processing
   * @param event - The StakeWithdrawn event to process
   */
  private async handleStakeWithdrawn(
    event: StakeWithdrawnEvent,
  ): Promise<void> {
    try {
      await this.eventProcessor.processStakeWithdrawn(event);
      this.emit(MONITOR_EVENTS.DEPOSIT_WITHDRAWN, {
        depositId: event.depositId,
        withdrawnAmount: event.withdrawnAmount.toString(),
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      });
    } catch (error) {
      this.logger.error("Failed to handle StakeWithdrawn event", {
        error,
        depositId: event.depositId,
      });

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: "handle-stake-withdrawn",
          depositId: event.depositId,
        });
      }

      throw error;
    }
  }

  /**
   * Handles DelegateeAltered event processing
   * @param event - The DelegateeAltered event to process
   */
  private async handleDelegateeAltered(
    event: DelegateeAlteredEvent,
  ): Promise<void> {
    try {
      await this.eventProcessor.processDelegateeAltered(event);
      this.emit(MONITOR_EVENTS.DELEGATEE_CHANGED, {
        depositId: event.depositId,
        oldDelegatee: event.oldDelegatee,
        newDelegatee: event.newDelegatee,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      });
    } catch (error) {
      this.logger.error("Failed to handle DelegateeAltered event", {
        error,
        depositId: event.depositId,
      });

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: "handle-delegatee-altered",
          depositId: event.depositId,
        });
      }

      throw error;
    }
  }

  /**
   * Handles EarningPowerBumped event processing
   * @param event - The EarningPowerBumped event to process
   */
  private async handleEarningPowerBumped(
    event: EarningPowerBumpedEvent,
  ): Promise<void> {
    this.logger.info("Processing EarningPowerBumped event", {
      depositId: event.depositId,
      oldEarningPower: event.oldEarningPower.toString(),
      newEarningPower: event.newEarningPower.toString(),
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
    });

    try {
      // First check if the deposit exists
      const deposit = await this.db.getDeposit(event.depositId);

      if (!deposit) {
        this.logger.warn("Deposit not found for EarningPowerBumped event", {
          depositId: event.depositId,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
        });
        return;
      }

      // Process the event - this will update the score in the database
      await this.eventProcessor.processEarningPowerBumped(event);

      this.logger.info("Successfully processed EarningPowerBumped event", {
        depositId: event.depositId,
        delegatee: deposit.delegatee_address || deposit.owner_address,
        newEarningPower: event.newEarningPower.toString(),
      });

      // Emit the event
      this.emit(MONITOR_EVENTS.EARNING_POWER_BUMPED, {
        depositId: event.depositId,
        oldEarningPower: event.oldEarningPower.toString(),
        newEarningPower: event.newEarningPower.toString(),
        bumper: event.bumper,
        tipReceiver: event.tipReceiver,
        tipAmount: event.tipAmount.toString(),
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      });
    } catch (error) {
      this.logger.error("Failed to handle EarningPowerBumped event", {
        error,
        depositId: event.depositId,
        newEarningPower: event.newEarningPower.toString(),
      });

      if (this.errorLogger) {
        await this.errorLogger.error(error as Error, {
          context: "handle-earning-power-bumped",
          depositId: event.depositId,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
        });
      }

      throw error;
    }
  }
}
