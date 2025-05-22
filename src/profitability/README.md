# GovLst Profitability Engine

The Profitability Engine analyzes GovLst deposits to determine optimal grouping and profitability metrics for reward claiming. It provides detailed analysis of deposit groups, considering gas costs, reward rates, and market conditions.

---

## State Diagram

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Analyzing: New deposit/event
    Analyzing --> Caching: Update deposit/gas cache
    Caching --> BatchOptimization: Optimize batches
    BatchOptimization --> Queueing: Queue profitable claims
    Queueing --> Idle
    Queueing --> [*]: On unrecoverable error
```

---

## Sequence Diagram: Batch Profitability Analysis

```mermaid
sequenceDiagram
    participant Monitor
    participant ProfitabilityEngine
    participant Database
    participant Executor

    Monitor->>ProfitabilityEngine: Notify deposit update
    ProfitabilityEngine->>Database: Read deposits
    ProfitabilityEngine->>ProfitabilityEngine: Analyze profitability
    alt Profitable
        ProfitabilityEngine->>Executor: Queue claim tx
        Executor-->>ProfitabilityEngine: Ack
    end
    ProfitabilityEngine->>Database: Update analysis/queue
```

---

## Core Features

- Single-bin accumulation strategy for optimal deposit grouping
- Real-time profitability analysis with advanced gas cost estimation
- Dynamic profit margin scaling based on deposit count
- Simulation-based gas estimation with fallback
- Batch processing of unclaimed rewards
- Automatic threshold optimization
- Resilient error handling and retry mechanisms

## Architecture Overview

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Analyzing: New deposits
    Analyzing --> GasEstimation: Process deposits
    GasEstimation --> BinAccumulation: Estimate costs
    BinAccumulation --> ThresholdCheck: Add to bin
    ThresholdCheck --> Queueing: Threshold met
    ThresholdCheck --> BinAccumulation: Continue accumulating
    Queueing --> Idle
```

## Single-Bin Accumulation Algorithm

The engine implements a novel single-bin accumulation strategy that:

1. Maintains one active bin for collecting deposits
2. Sorts deposits by reward amount in descending order
3. Uses simulation-based gas estimation when available
4. Accumulates deposits until reaching optimal threshold
5. Automatically queues full bins for execution

### Optimization Parameters

- **Optimal Threshold**: Dynamic based on deposit count and gas costs
- **Gas Cost Buffer**: Configurable safety margin for gas estimates
- **Batch Size**: 100 deposits per processing batch
- **Profit Margin**: Dynamic scaling based on deposit count (0.05% per deposit)
- **Maximum Profit Margin**: Capped at 15% (1500 basis points)

### Profitability Calculation

The engine calculates profitability using:

```typescript
// Calculate base amount
baseAmount = payoutAmount + (includeGasCost ? gasCost : 0n);

// Scale profit margin based on deposit count
depositScalingBasisPoints = min(20, depositCount * 5); // 0.05% per deposit
scaledMargin = min(1500, baseMarginBps + depositScalingBasisPoints);

// Calculate minimum expected reward
profitMarginAmount = (baseAmount * scaledMarginBps) / 10000n;
minExpectedReward = baseAmount + profitMarginAmount;

// Final profitability check
isProfileable = totalRewards >= minExpectedReward;
```

Where:

- `payoutAmount`: Base payout from contract
- `gasCost`: Estimated gas cost (from simulation or fallback)
- `depositCount`: Number of deposits in batch
- `baseMarginBps`: Base profit margin in basis points
- `scaledMarginBps`: Final margin after deposit count scaling

## Gas Estimation

The engine now supports two methods of gas estimation:

1. **Simulation-Based Estimation**

   - Uses Tenderly simulation when available
   - Provides more accurate gas estimates
   - Handles complex contract interactions

2. **Fallback Estimation**
   - Uses historical gas data
   - Applies configurable safety buffer
   - Cached with TTL for efficiency

## Error Handling

Implements a robust error handling system:

- Automatic retries for transient failures
- Exponential backoff for RPC calls
- Detailed error context and logging
- Graceful degradation on partial failures
- Simulation fallback mechanisms

## Performance Optimizations

1. **Caching System**

   - Gas price caching with TTL
   - Reward calculation memoization
   - Batch processing of RPC calls
   - Simulation results caching

2. **Smart Batching**
   - Parallel reward fetching
   - Sorted deposit processing
   - Dynamic threshold calculation
   - Simulation-aware batch sizing

## Configuration

```typescript
interface ProfitabilityConfig {
  rewardTokenAddress: string;
  minProfitMargin: number;
  gasPriceBuffer: number;
  maxBatchSize: number;
  defaultTipReceiver: string;
  includeGasCost: boolean;
  priceFeed: {
    cacheDuration: number;
  };
}
```

## Usage Example

```typescript
const engine = new GovLstProfitabilityEngine(
  govLstContract,
  stakerContract,
  provider,
  {
    rewardTokenAddress: '0x...',
    minProfitMargin: 1, // 1% base margin
    gasPriceBuffer: 20, // 20% buffer
    maxBatchSize: 50,
    defaultTipReceiver: '0x...',
    includeGasCost: true,
    priceFeed: {
      cacheDuration: 300_000, // 5 minutes
    },
  },
  simulationService, // Optional simulation service
);

// Start the engine
await engine.start();

// Analyze deposits
const analysis = await engine.analyzeAndGroupDeposits(deposits);

// Check if bin is ready
const isReady = await engine.isActiveBinReady();
```

## Monitoring

The engine provides detailed monitoring capabilities:

- Real-time bin status
- Gas price trends and simulation results
- Processing metrics
- Error rates and types
- Profitability statistics
- Simulation success rates

## Error Types

```typescript
-ProfitabilityError - // Base error class
  GasEstimationError - // Gas calculation issues
  SimulationError - // Simulation failures
  BatchFetchError - // Batch processing failures
  QueueProcessingError; // Queue operation errors
```

## Future Improvements

1. Machine learning for gas price prediction
2. Multi-bin optimization strategies
3. Advanced profit maximization algorithms
4. Enhanced monitoring and alerting systems
5. Improved simulation integration
6. Dynamic gas cost modeling

## See Also

- [Contract Documentation](./docs/contracts.md)
- [API Reference](./docs/api.md)
- [Configuration Guide](./docs/config.md)

## Inputs & Outputs

- **Inputs**: Deposit data, config, price feeds, gas prices
- **Outputs**: Profitability analysis, batch queue, claim recommendations

---

## Error Handling

- Early returns for invalid/missing data
- Retries for transient errors
- Logs and propagates context-rich errors

---

## Monitoring

- Health/status via `getStatus()`
- Metrics: queue size, cache hit rate, last update, profit stats

---

## See root README for system-level diagrams and configuration.

## System Architecture

```mermaid
graph TD
    A[Deposits] --> B[Profitability Engine]
    B --> C[Deposit Cache]
    B --> D[Gas Price Cache]
    B --> E[Processing Queue]
    B --> F[Analysis Output]

    subgraph "Engine Components"
        B
        C
        D
        E
    end
```

### Key Components

#### ProfitabilityEngineWrapper

- Main orchestrator for profitability analysis
- Manages deposit caching and queue processing
- Handles batch optimization and analysis

#### GovLstProfitabilityEngine

- Core profitability calculation logic
- Gas cost estimation
- Share and reward calculations
- Batch optimization algorithms

## Inputs

### 1. Configuration (ProfitabilityConfig)

```typescript
{
  rewardTokenAddress: string,     // Reward token contract address
  minProfitMargin: bigint,       // Minimum acceptable profit
  gasPriceBuffer: number,        // Gas price safety buffer (%)
  maxBatchSize: number,          // Maximum deposits per batch
  defaultTipReceiver: string,    // Default tip receiver address
  priceFeed: {
    cacheDuration: number        // Price cache duration (ms)
  }
}
```

### 2. Deposit Data (GovLstDeposit)

```typescript
{
  deposit_id: bigint,            // Unique deposit identifier
  owner_address: string,         // Deposit owner address
  delegatee_address: string | null, // Optional delegatee
  amount: bigint,               // Deposit amount
  shares_of: bigint,            // Current share allocation
  payout_amount: bigint         // Expected payout amount
}
```

### 3. External Dependencies

- Ethereum Provider (RPC connection)
- GovLst Contract Instance
- Price Feed Service
- Database Connection
- Logging Service

## Outputs

### 1. Profitability Analysis (GovLstProfitabilityCheck)

```typescript
{
  is_profitable: boolean,        // Overall profitability flag
  constraints: {
    has_enough_shares: boolean,  // Share threshold check
    meets_min_reward: boolean,   // Minimum reward check
    is_profitable: boolean       // Profit after gas check
  },
  estimates: {
    total_shares: bigint,       // Group's total shares
    payout_amount: bigint,      // Expected payout
    gas_estimate: bigint,       // Estimated gas cost
    expected_profit: bigint     // Net profit after gas
  }
}
```

### 2. Batch Analysis (GovLstBatchAnalysis)

```typescript
{
  deposit_groups: [             // Array of profitable groups
    {
      deposit_ids: bigint[],    // Group member IDs
      total_shares: bigint,     // Group's total shares
      total_payout: bigint,     // Group's total payout
      expected_profit: bigint,  // Group's net profit
      gas_estimate: bigint      // Group's gas cost
    }
  ],
  total_gas_estimate: bigint,   // Total gas for all groups
  total_expected_profit: bigint,// Total net profit
  total_deposits: number        // Total deposits analyzed
}
```

### 3. Engine Status

```typescript
{
  isRunning: boolean,           // Engine state
  lastGasPrice: bigint,        // Latest gas price
  lastUpdateTimestamp: number,  // Last update time
  queueSize: number,           // Current queue size
  groupCount: number           // Active group count
}
```

## Performance Optimizations

### 1. Caching System

- **Deposit Cache**

  - TTL: 5 minutes
  - Reduces database load
  - Quick access to frequent deposits

- **Gas Price Cache**
  - Updates every minute
  - Includes price buffer
  - Reduces RPC calls

### 2. Batch Processing

- Groups deposits by profitability
- Optimizes gas usage
- Maintains processing queue
- Handles requeuing on restarts

## Error Handling

### Error Types

```typescript
-ProfitabilityError - // Base error class
  DepositNotFoundError - // Missing deposit
  InvalidDepositDataError - // Malformed data
  GasEstimationError - // Gas calculation issues
  QueueProcessingError; // Queue operation failures
```

### Error Recovery

- Automatic retry mechanism
- Configurable retry limits
- Error context preservation
- Detailed error logging

## Usage Examples

### Initialize Engine

```typescript
const engine = new GovLstProfitabilityEngineWrapper(
  database,
  govLstContract,
  provider,
  logger,
  priceFeed,
  {
    rewardTokenAddress: '0x...',
    minProfitMargin: BigInt(1e16),
    gasPriceBuffer: 20,
    maxBatchSize: 50,
    defaultTipReceiver: '0x...',
    priceFeed: {
      cacheDuration: 300_000,
    },
  },
);
```

### Check Group Profitability

```typescript
const profitability = await engine.checkGroupProfitability(deposits);
if (profitability.is_profitable) {
  console.log(`Expected profit: ${profitability.estimates.expected_profit}`);
}
```

### Analyze Deposits

```typescript
const analysis = await engine.analyzeAndGroupDeposits(deposits);
console.log(`Found ${analysis.deposit_groups.length} profitable groups`);
console.log(`Total profit: ${analysis.total_expected_profit}`);
```

## Monitoring

### Health Metrics

- Engine running state
- Queue processing rate
- Cache hit rates
- Gas price trends
- Profitability statistics

### Performance Metrics

- Processing latency
- Queue backlog size
- Cache efficiency
- Error rates
- Profit margins

## Database Schema

### Processing Queue

```sql
CREATE TABLE processing_queue (
  deposit_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  last_attempt TIMESTAMP,
  error TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Profitability Results

```sql
CREATE TABLE profitability_results (
  group_id TEXT PRIMARY KEY,
  deposit_ids TEXT[],
  total_shares NUMERIC,
  expected_profit NUMERIC,
  gas_estimate NUMERIC,
  analyzed_at TIMESTAMP DEFAULT NOW()
);
```

## Testing

### Unit Tests

- Profitability calculations
- Gas estimation
- Batch optimization
- Error handling
- Cache management

### Integration Tests

- Database operations
- Contract interactions
- Price feed integration
- Queue processing
- End-to-end flows

## Future Improvements

1. Dynamic batch size optimization
2. Machine learning for gas prediction
3. Advanced profit optimization strategies
4. Real-time market condition adaptation
5. Enhanced monitoring and alerting
