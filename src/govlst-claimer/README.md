# GovLst Rewards Claimer Component

The GovLst Rewards Claimer component is responsible for monitoring and claiming rewards from GovLst contracts. It analyzes deposits, calculates unclaimed rewards, optimizes batch claims for profitability, and executes claims through the transaction executor.

## Overview

The GovLst Rewards Claimer integrates with GovLst contracts to:
- Monitor deposits owned by GovLst contracts
- Calculate unclaimed rewards for deposits
- Optimize batch claims for maximum profitability
- Execute claims through the transaction executor
- Track claim history and deposit status

## Architecture

### Queue-Based Processing System

The claimer implements a periodic processing system that:

1. **Contract Monitoring**: Monitors configured GovLst contracts
2. **Reward Analysis**: Calculates unclaimed rewards for deposits
3. **Batch Optimization**: Groups deposits into profitable batches
4. **Claim Execution**: Submits claims through the executor component

```
┌─────────────┐    Analyze   ┌─────────────┐   Batch    ┌─────────────┐  Execute   ┌─────────────┐
│   GovLst    │──Rewards───▶│   Reward    │──Claims───▶│   Batch     │──Claims───▶│  Executor   │
│  Contracts  │             │  Calculator  │           │  Optimizer  │            │  Component  │
└─────────────┘             └─────────────┘           └─────────────┘            └─────────────┘
       ▲                           │                         │                          │
       │                           │                         │                          │
       └───────────────────────────┴─────────────────────────┴──────────────────────────┘
                                    Status Updates
```

### Components

#### GovLstClaimerWrapper

- Main entry point for reward claiming functionality
- Manages periodic processing of GovLst contracts
- Coordinates with executor for claim submission
- Implements strategy pattern for different claiming methods
- Tracks claimer state and processing statistics

#### BaseGovLstClaimer

- Default claimer implementation
- Verifies deposit ownership
- Calculates unclaimed rewards
- Performs batch optimization
- Implements gas cost analysis for profitability

## Database Integration

The component uses the following database tables:

- **govlst_deposits**: Tracks deposits owned by GovLst contracts
  - `deposit_id`: Unique identifier for the deposit
  - `govlst_address`: Address of the GovLst contract
  - `last_reward_check`: Timestamp of last reward check
  - `last_unclaimed_reward`: Amount of unclaimed rewards

- **govlst_claim_history**: Records claim execution history
  - `govlst_address`: Address of the GovLst contract
  - `deposit_ids`: Array of claimed deposit IDs
  - `claimed_reward`: Total claimed reward amount
  - `payout_amount`: GovLst payout amount at time of claim
  - `profit`: Net profit from the claim

## Configuration

The claimer can be configured with:

```typescript
type GovLstClaimerConfig = {
  addresses: string[]; // List of GovLst contract addresses
  payoutAmount: bigint; // Current payout amount for claims
  minProfitMargin: bigint; // Minimum profit margin required
  maxBatchSize: number; // Maximum deposits per claim
  claimInterval: number; // Check interval in seconds
  gasPriceBuffer: number; // Buffer for gas price volatility
  tipReceiver?: string; // Address to receive tips
};
```

## Usage

### Initializing the Claimer

```typescript
const claimer = new GovLstClaimerWrapper(
  database,
  provider,
  executor,
  {
    addresses: ['0x...', '0x...'], // GovLst addresses
    payoutAmount: BigInt(1e18), // 1 token
    minProfitMargin: BigInt(1e16), // 0.01 token
    maxBatchSize: 10,
    claimInterval: 3600, // 1 hour
    gasPriceBuffer: 20, // 20% buffer
  },
);

// Start the claimer
await claimer.start();
```

### Analyzing Rewards

```typescript
const analysis = await claimer.analyzeRewards(govLstAddress);
console.log('Total deposits:', analysis.totalDeposits);
console.log('Claimable rewards:', analysis.totalClaimableRewards.toString());
console.log('Profitable deposits:', analysis.profitableDeposits);
console.log('Optimal batches:', analysis.optimalBatches.length);
```

### Executing Claims

```typescript
const result = await claimer.executeClaimBatch(govLstAddress, batch);
console.log('Claim success:', result.success);
console.log('Transaction ID:', result.transactionId);
```

### Monitoring Status

```typescript
const status = await claimer.getStatus();
console.log('Claimer running:', status.isRunning);
console.log('Monitors:', status.monitors);
```

## Integration Points

- Executor component for transaction submission
- GovLst contracts for reward calculation
- Staker contract for deposit verification
- Database for deposit tracking and claim history
- Price feed for profitability calculation

## Error Handling

- Validates contract interfaces
- Implements gas price buffering
- Handles failed claim executions
- Provides detailed error logging
- Persists claim history for auditing

## Health Monitoring

The claimer includes built-in status monitoring:

- Running state
- Last check timestamps
- Deposit counts per GovLst
- Pending claim counts
- Claim success/failure rates

## Backup Processing

A periodic backup process ensures no deposits are missed:

1. Verifies deposit ownership
2. Updates unclaimed reward amounts
3. Retries failed claims
4. Maintains claim history
