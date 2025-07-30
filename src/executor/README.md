# Executor Module

## Overview

The Executor module manages the submission and monitoring of profitable reward claim transactions. It provides multiple execution strategies (direct wallet, OpenZeppelin Defender) with comprehensive gas management, simulation, and error recovery capabilities.

## Architecture

```mermaid
graph TB
    subgraph "External Services"
        BLOCKCHAIN[Blockchain RPC]
        DEFENDER[OpenZeppelin Defender]
        TENDERLY[Tenderly Simulation]
    end

    subgraph "Executor Module"
        WRAPPER[ExecutorWrapper]
        IFACE[IExecutor Interface]

        subgraph "Implementations"
            BASE[BaseExecutor]
            RELAYER[RelayerExecutor]
        end

        subgraph "Helpers"
            SIM_HELP[simulation-helpers.ts]
            DEF_HELP[defender-helpers.ts]
            GAS_HELP[helpers.ts]
            SWAP_HELP[token-swap-helpers.ts]
        end

        subgraph "Core Components"
            QUEUE[Transaction Queue]
            GAS_MGR[Gas Manager]
            SIM_MGR[Simulation Manager]
            SWAP_MGR[Swap Strategy]
        end
    end

    subgraph "Consumers"
        PROFIT[Profitability Module]
        MONITOR[Monitor Module]
    end

    WRAPPER --> IFACE
    WRAPPER --> BASE
    WRAPPER --> RELAYER
    BASE -.-> RELAYER

    BASE --> QUEUE
    BASE --> GAS_MGR
    BASE --> SIM_MGR
    RELAYER --> DEFENDER

    GAS_MGR --> GAS_HELP
    SIM_MGR --> SIM_HELP
    SIM_MGR --> TENDERLY
    RELAYER --> DEF_HELP

    BASE --> BLOCKCHAIN
    SWAP_MGR --> SWAP_HELP

    PROFIT --> WRAPPER
    MONITOR --> WRAPPER
```

## Transaction Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Validation
    Validation --> Queued: Valid
    Validation --> Rejected: Invalid

    Queued --> Simulation
    Simulation --> GasEstimation: Success
    Simulation --> Failed: Failure

    GasEstimation --> Submission
    Submission --> Pending: Submitted
    Submission --> Failed: Error

    Pending --> Monitoring
    Monitoring --> Confirmed: Mined
    Monitoring --> Failed: Reverted
    Monitoring --> Replacement: Stuck

    Replacement --> Pending: Resubmitted

    Confirmed --> [*]
    Failed --> [*]
    Rejected --> [*]
```

## Components

### 1. ExecutorWrapper

**Purpose**: Factory and manager for executor implementations.

**Responsibilities**:

- Creates appropriate executor instance based on configuration
- Provides unified interface
- Manages executor lifecycle

### 2. BaseExecutor

**Purpose**: Direct wallet-based transaction execution.

**Key Features**:

- In-memory transaction queue
- Gas price optimization
- Transaction simulation
- Automatic retry logic
- Tip accumulation and transfer

**Process Flow**:

```mermaid
sequenceDiagram
    participant Client
    participant Executor
    participant Simulation
    participant Blockchain
    participant Database

    Client->>Executor: queueTransaction()
    Executor->>Executor: Validate transaction
    Executor->>Database: Create queue item

    loop Process Queue
        Executor->>Simulation: Simulate transaction
        Simulation-->>Executor: Gas estimate
        Executor->>Executor: Calculate gas parameters
        Executor->>Blockchain: Submit transaction
        Blockchain-->>Executor: Transaction hash
        Executor->>Database: Update status
        Executor->>Blockchain: Monitor receipt
        Blockchain-->>Executor: Confirmation
        Executor->>Database: Mark confirmed
    end
```

### 3. RelayerExecutor

**Purpose**: OpenZeppelin Defender-based execution.

**Key Features**:

- Managed gas pricing
- Private mempool options
- MEV protection
- Enhanced monitoring
- Automatic balance management

**Defender Integration**:

```mermaid
graph LR
    EXEC[RelayerExecutor] --> API[Defender API]
    API --> RELAYER[Relayer Service]
    RELAYER --> MEMPOOL{Mempool Type}
    MEMPOOL -->|Public| PUBLIC[Standard Pool]
    MEMPOOL -->|Private| PRIVATE[Flashbots]
    PUBLIC --> BLOCKCHAIN
    PRIVATE --> BLOCKCHAIN
```

### 4. Transaction Queue

**States**:

- `QUEUED`: Awaiting processing
- `PENDING`: Submitted to network
- `CONFIRMED`: Successfully mined
- `FAILED`: Execution failed
- `REPLACED`: Resubmitted with higher gas

**Queue Processing**:

```typescript
// Process every 3 seconds
setInterval(() => processQueue(), 3000)

// Priority order:
1. Failed transactions (retry)
2. Queued transactions (new)
3. Stuck transactions (replace)
```

### 5. Gas Management

**Gas Estimation Flow**:

```mermaid
flowchart TD
    A[Start] --> B{Simulation Available?}
    B -->|Yes| C[Run Tenderly Simulation]
    B -->|No| D[Use Fallback Estimate]
    C --> E{Success?}
    E -->|Yes| F[Use Simulated Gas + 30%]
    E -->|No| D
    D --> G[Base + Deposits * PerDeposit]
    F --> H[Apply Gas Price Buffer]
    G --> H
    H --> I[Final Gas Parameters]
```

**Gas Calculation**:

```typescript
// Base calculation
gasLimit = BASE_GAS + depositCount * GAS_PER_DEPOSIT;

// With reentrancy protection (20+ deposits)
if (depositCount >= 20) {
  gasLimit *= 1.25; // 25% additional buffer
}

// Price calculation
gasPrice = currentGasPrice * (1 + buffer);
maxFeePerGas = baseFee * 2 + priorityFee;
```

### 6. Simulation Integration

**Purpose**: Pre-execution validation and accurate gas estimation.

**Process**:

1. Encode transaction data
2. Set simulation parameters
3. Run Tenderly simulation
4. Extract gas usage
5. Apply safety buffer

**Benefits**:

- Prevents failed transactions
- Accurate gas estimates
- Error detection before submission
- Cost optimization

## Error Handling

### Retry Strategy

```mermaid
graph TD
    ERROR[Transaction Error] --> ANALYZE{Error Type}
    ANALYZE -->|Gas Too Low| INCREASE[Increase Gas]
    ANALYZE -->|Nonce Issue| RESET[Reset Nonce]
    ANALYZE -->|Network Error| WAIT[Wait & Retry]
    ANALYZE -->|Contract Error| FAIL[Mark Failed]

    INCREASE --> RETRY[Retry Transaction]
    RESET --> RETRY
    WAIT --> RETRY
    RETRY --> CHECK{Attempts < Max?}
    CHECK -->|Yes| SUBMIT[Resubmit]
    CHECK -->|No| FAIL
```

### Error Types

1. **ValidationError**: Invalid transaction parameters
2. **GasEstimationError**: Failed to estimate gas
3. **InsufficientBalanceError**: Wallet balance too low
4. **TransactionExecutionError**: Submission failed
5. **SimulationError**: Tenderly simulation failed

## Configuration

### Wallet Executor

```typescript
{
  privateKey: string,
  minBalance: bigint,        // Minimum wallet balance
  maxPendingTransactions: 5, // Concurrent tx limit
  transferOutThreshold: 0.5, // ETH threshold for tips
  gasBoostPercentage: 25,    // Gas price buffer %
  minProfitMargin: 10        // Minimum profit %
}
```

### Relayer Executor

```typescript
{
  apiKey: string,
  apiSecret: string,
  isPrivate: boolean,        // Use Flashbots
  gasPolicy: {
    maxFeePerGas: bigint,
    maxPriorityFeePerGas: bigint
  }
}
```

## Transaction Validation

### Pre-submission Checks

1. **Sufficient Rewards**: Total rewards > payout + gas + margin
2. **Valid Deposits**: All deposits exist and qualify
3. **Gas Estimation**: Successful simulation or fallback
4. **Balance Check**: Executor has sufficient ETH
5. **Queue Limits**: Not exceeding max queue size

### Post-submission Monitoring

1. **Receipt Polling**: Check transaction status
2. **Timeout Detection**: Identify stuck transactions
3. **Replacement Logic**: Resubmit with higher gas
4. **Success Verification**: Validate execution results

## Best Practices

1. **Always Simulate**: Use Tenderly when available
2. **Monitor Gas Prices**: Adjust buffers for volatility
3. **Set Appropriate Limits**: Balance speed vs cost
4. **Handle Failures Gracefully**: Implement retry logic
5. **Track Metrics**: Monitor success rates and costs

## Common Issues and Solutions

### Issue: Transaction Stuck

**Solution**: Automatic replacement after timeout with higher gas

### Issue: Simulation Failures

**Solution**: Fallback to conservative gas estimates

### Issue: Insufficient Balance

**Solution**: Alert and pause execution until funded

### Issue: High Failure Rate

**Solution**: Circuit breaker activates after threshold

## Performance Metrics

- **Queue Processing**: Every 3 seconds
- **Transaction Timeout**: 5 minutes
- **Max Retries**: 3 attempts
- **Simulation Success Rate**: >95%
- **Transaction Success Rate**: >98%

## Integration Points

- **Profitability Module**: Receives profitable batches
- **Database Module**: Persists transaction state
- **Simulation Module**: Validates transactions
- **Price Module**: Gas cost calculations
- **Monitor Module**: Triggers execution

This module ensures reliable and cost-effective execution of reward claims while protecting against common blockchain transaction failures.
