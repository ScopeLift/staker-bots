# Profitability Engine Component

The Profitability Engine component is responsible for analyzing and determining whether deposits can be profitably bumped, considering calculator eligibility, reward constraints, gas costs, and batch optimization.

## Overview

The profitability engine integrates with the [Staker Contract](https://github.com/withtally/staker/blob/main/src/Staker.sol) to determine initial bump eligibility and calculates optimal tips and batch sizes for profitable bump operations.

## Architecture

### Queue-Based Processing System

The profitability engine implements a queue-based system that responds to score events from the calculator component:

1. **Score Event Handling**: When delegatee scores change, the calculator notifies the profitability engine
2. **Deposit Queueing**: All deposits associated with the updated delegatee are added to a processing queue
3. **Batch Processing**: Deposits are processed in batches to optimize gas usage
4. **Transaction Execution**: Profitable deposits are forwarded to the executor component

This event-driven architecture ensures that deposits are only processed when they might have become profitable due to score changes, rather than checking all deposits periodically.

### Processing Flow

```
┌─────────────┐    Score    ┌─────────────┐   Queue   ┌─────────────┐  Transaction  ┌─────────────┐
│  Calculator │───Event────▶│Profitability│───Item───▶│ Processing  │───Request────▶│  Executor   │
│  Component  │             │   Engine    │           │    Queue    │               │  Component  │
└─────────────┘             └─────────────┘           └─────────────┘               └─────────────┘
                                   ▲                                                      │
                                   │                                                      │
                                   └──────────────────Transaction─Status─────────────────┘
```

### Components

#### ProfitabilityEngineWrapper

- Main entry point for profitability analysis functionality
- Manages the processing and transaction queues
- Responds to score events from calculator component
- Coordinates with executor for transaction submission
- Implements strategy pattern to support different profitability calculation methods
- Tracks engine state, queue sizes, and processing statistics

#### BaseProfitabilityEngine

- Default profitability engine implementation
- Validates bump requirements using calculator
- Calculates optimal tips based on gas costs
- Performs batch analysis and optimization
- Implements gas price buffering for volatility

## Database Integration

The queue-based system persists queue state in the database for resilience:

- **Processing Queue**: Tracks deposits that need profitability checks
- **Transaction Queue**: Tracks deposits that have been submitted for execution

Each queue item maintains:

- Current status (pending, processing, completed, failed)
- Attempt count for retry logic
- Error information for troubleshooting
- Timestamps for monitoring

## Configuration

The engine can be configured with the following parameters:

```typescript
type ProfitabilityConfig = {
  minProfitMargin: bigint; // Minimum profit margin in base units
  maxBatchSize: number; // Maximum number of deposits to process in a batch
  gasPriceBuffer: number; // Buffer percentage for gas price volatility
  rewardTokenAddress: string; // Address of the reward token
  defaultTipReceiver: string; // Default tip receiver address
  priceFeed: {
    cacheDuration: number; // Price feed cache duration in milliseconds
  };
};
```

## Usage

### Initializing the Engine

```typescript
const engine = new ProfitabilityEngineWrapper(
  database,
  provider,
  stakerAddress,
  logger,
  {
    minProfitMargin: BigInt(1e16), // 0.01 ETH
    maxBatchSize: 10,
    gasPriceBuffer: 20, // 20% buffer
    rewardTokenAddress: rewardTokenAddress,
    defaultTipReceiver: tipReceiverAddress,
    priceFeed: {
      cacheDuration: 10 * 60 * 1000, // 10 minutes
    },
  },
);

// Set up connections between components
calculator.setProfitabilityEngine(engine);
engine.setExecutor(executor);

// Start the engine
await engine.start();
```

### Triggering Score Events

Score events are normally triggered by the calculator component when it detects changes in delegatee scores. For testing, you can trigger them manually:

```typescript
await engine.onScoreEvent(delegateeAddress, newScore);
```

### Checking Single Deposit Profitability

```typescript
const profitability = await engine.checkProfitability(deposit);
console.log('Can bump:', profitability.canBump);
console.log('Optimal tip:', profitability.estimates.optimalTip.toString());
console.log(
  'Expected profit:',
  profitability.estimates.expectedProfit.toString(),
);
```

### Analyzing Batch Profitability

```typescript
const batchAnalysis = await engine.analyzeBatchProfitability(deposits);
console.log('Recommended batch size:', batchAnalysis.recommendedBatchSize);
console.log(
  'Total expected profit:',
  batchAnalysis.totalExpectedProfit.toString(),
);
```

### Monitoring Queue Status

```typescript
const status = await engine.getStatus();
console.log('Engine running:', status.isRunning);
console.log('Queue size:', status.queueSize);
console.log('Delegatee count:', status.delegateeCount);

const queueStats = await engine.getQueueStats();
console.log('Pending items:', queueStats.pendingCount);
console.log('Processing items:', queueStats.processingCount);
console.log('Completed items:', queueStats.completedCount);
console.log('Failed items:', queueStats.failedCount);
```

## Integration Points

- BinaryEligibilityCalculator for bump eligibility checks and score event notifications
- Executor component for transaction submission
- Staker contract for reward and tip constraints
- Price feed for cost estimation
- Database for deposit information and queue persistence

## Error Handling

- Validates contract interfaces
- Implements gas price buffering
- Handles failed profitability checks gracefully
- Provides queue item retry logic
- Persists error information for troubleshooting
- Provides detailed error logging

## Health Monitoring

The engine includes built-in status monitoring:

- Running state
- Last gas price
- Last update timestamp
- Queue sizes and processing statistics
- Delegatee breakdown
- Transaction success/failure rates

## Backup Processing

In addition to the event-driven queue, a periodic backup process runs to ensure no deposits are missed:

1. Checks for deposits not currently in the queue
2. Triggers score events for their delegatees
3. Runs at a lower frequency than the main queue processor
4. Provides redundancy in case of missed events
