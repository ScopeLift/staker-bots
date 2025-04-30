# Staker Monitor

A robust monitoring system for tracking staking events on the blockchain. This system monitors stake deposits, withdrawals, and delegatee changes in real-time while maintaining data consistency and handling network interruptions gracefully.

## Overview

The Staker Monitor is designed to:

- Track staking events from a specified smart contract
- Process and store events in a database (Supabase or JSON)
- Handle network reorgs and connection issues
- Provide real-time monitoring status and health checks
- Support graceful shutdowns and error recovery

## Architecture

### Core Components

1. **StakerMonitor**: The main orchestrator that:

   - Manages the event processing lifecycle
   - Handles blockchain polling and event filtering
   - Maintains processing checkpoints
   - Provides monitoring status and health checks

2. **EventProcessor**: Processes individual blockchain events:

   - StakeDeposited
   - StakeWithdrawn
   - DelegateeAltered

3. **Database Interface**: Supports multiple database backends:
   - Supabase (default)
   - JSON file storage

### Key Features

- **Checkpoint System**: Tracks last processed block to resume after interruptions
- **Retry Logic**: Implements exponential backoff for failed event processing
- **Health Monitoring**: Regular status checks and lag reporting
- **Graceful Shutdown**: Proper cleanup on process termination

## Configuration

Configuration is managed through environment variables:

```
RPC_URL= # Blockchain RPC endpoint
STAKER_CONTRACT_ADDRESS= # Address of the staker contract
SUPABASE_URL= # Supabase project URL
SUPABASE_KEY= # Supabase API key
CHAIN_ID=42161 # Chain ID (default: Arbitrum One)
START_BLOCK=0 # Starting block number
LOG_LEVEL=info # Logging level (debug|info|warn|error)
DATABASE_TYPE=supabase # Database type (supabase|json)
POLL_INTERVAL=15 # Polling interval in seconds
MAX_BLOCK_RANGE=2000 # Maximum blocks to process in one batch
MAX_RETRIES=5 # Maximum retry attempts for failed events
REORG_DEPTH=64 # Number of blocks to check for reorgs
CONFIRMATIONS=20 # Required block confirmations
HEALTH_CHECK_INTERVAL=60 # Health check interval in seconds
```

## Usage

1. Set up environment variables
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Start the monitor:
   ```bash
   pnpm run dev
   ```

## Error Handling

The monitor implements comprehensive error handling:

- Automatic retries with exponential backoff
- Graceful shutdown on SIGTERM/SIGINT
- Uncaught exception handling
- Network disconnection recovery
- Database operation retries

## Monitoring and Maintenance

The system provides real-time status information including:

- Current processing lag
- Last processed block
- Network connection status
- Processing health metrics

Monitor the logs for operational status and any warning/error conditions.
