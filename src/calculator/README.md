# Calculator Component

The Calculator component is responsible for monitoring and processing delegatee score updates from the Reward Calculator contract.

## Overview

The calculator monitors the `DelegateeScoreUpdated` events emitted by the Reward Calculator contract at `${CONFIG.monitor.rewardCalculatorAddress}`. These events are emitted whenever a delegatee's score is updated.

## Components

### CalculatorWrapper

- Main entry point for the calculator functionality
- Implements strategy pattern to support different calculation methods
- Manages calculator state (running/stopped)
- Tracks last processed block

### BinaryEligibilityOracleEarningPowerCalculator

- Default calculator strategy implementation
- Monitors `DelegateeScoreUpdated` events
- Calculates earning power based on stake amount and delegatee score
- Maintains a score cache for quick lookups

## Event Structure

```solidity
event DelegateeScoreUpdated(
    address indexed delegatee,  // The delegatee whose score was updated
    uint256 oldScore,          // Previous score
    uint256 newScore           // New score
);
```

## Database Schema

Score events are stored in the database with the following structure:

```typescript
type ScoreEvent = {
  delegatee: string; // Delegatee address
  score: string; // Current score (stored as string due to bigint)
  block_number: number; // Block where the event occurred
  created_at?: string; // Timestamp of database entry
  updated_at?: string; // Last update timestamp
};
```

## Usage

### Running the Calculator

```bash
# Run only the calculator
npm run start:calculator

# Run with monitor
npm run start:all
```

### Environment Variables

- `REWARD_CALCULATOR_ADDRESS`: Address of the reward calculator contract
- `START_BLOCK`: Starting block number for event processing
- `POLL_INTERVAL`: How often to check for new events (in seconds)
- `MAX_BLOCK_RANGE`: Maximum number of blocks to process in one batch
- `CONFIRMATIONS`: Number of block confirmations to wait before processing

### Health Checks

The calculator includes built-in health monitoring:

- Processing status (running/stopped)
- Last processed block
- Processing lag (current chain height - last processed block)
- Event processing statistics

## Error Handling

- Automatic retries for failed event processing
- Checkpoint system to resume from last processed block
- Detailed error logging for debugging
- Score caching to reduce contract calls
