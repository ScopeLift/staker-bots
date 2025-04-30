# Arbitrum Staker Bot

A service that monitors staking deposits, calculates profitability, and executes profitable transactions on the Arbitrum network.

## System Architecture

The Arbitrum staker bot follows a modular, component-based architecture designed for flexibility, reliability, and maintainability. The system consists of the following core components:

### Monitor Component
Tracks on-chain events related to staking activities.
- Polls the blockchain for new events at configurable intervals
- Processes stake deposits/withdrawals and delegatee changes
- Maintains processing checkpoints for resilience against restarts
- Handles network reorgs and disruptions

### Calculator Component
Processes delegate scores and triggers profitability checks.
- Analyzes delegatee scores from on-chain events
- Identifies deposits eligible for earning power bumps
- Uses a queue-based system for reliable processing

### Profitability Engine
Analyzes deposits to determine if actions would be profitable.
- Calculates gas costs and potential profits
- Applies configurable profitability thresholds
- Uses price feeds for token valuations
- Queues profitable transactions for execution

### Executor Component
Executes on-chain transactions.
- Supports both direct wallet and OpenZeppelin Defender relayer execution
- Manages a transaction queue with retry logic
- Handles gas optimization
- Reports transaction outcomes

### Database Component
Provides persistent storage for system state.
- Stores deposits, events, checkpoints
- Manages processing and transaction queues
- Supports both JSON and Supabase backends

### Configuration Component
Manages application settings with a focus on type safety and validation.
- Environment variable handling
- Default configuration values with validation
- Component-specific configuration options

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Configure environment variables:
   Copy `.env.example` to `.env` and fill in the required values:

- `RPC_URL`: Your Ethereum RPC URL (e.g. from Alchemy or Infura)
- `STAKER_CONTRACT_ADDRESS`: The address of the Staker contract
- `PRIVATE_KEY`: Your wallet's private key (if using wallet executor)
- `DEFENDER_API_KEY` and `DEFENDER_API_SECRET`: If using Defender Relayer
- `SUPABASE_URL` and `SUPABASE_KEY`: If using Supabase database
- `COMPONENTS`: Comma-separated list of components to run (e.g., `monitor,profitability,executor`)

## Running the Service

1. Build the TypeScript code:

```bash
pnpm build
```

2. Start the service:

```bash
# Run all components
pnpm start

# Or run specific components
COMPONENTS=monitor,profitability,executor pnpm start

# For development with auto-restart
pnpm dev
```

The service will:
- Monitor deposits in the database
- Analyze profitability of earning power bumps
- Execute profitable transactions automatically
- Log all activities to the console

To stop the service gracefully, press Ctrl+C.

## Configuration Options

The service can be configured through environment variables or by modifying the configuration files in `src/configuration/`:

### General Settings
- `POLL_INTERVAL_MS`: How often to check for profitable opportunities (default: 15000ms)
- `LOG_LEVEL`: Logging verbosity (default: 'info')

### Profitability Settings
- `MIN_PROFIT_MARGIN`: Minimum expected profit to execute a transaction (in wei)
- `GAS_PRICE_BUFFER`: Additional buffer on gas price estimates (percentage)
- `GAS_BOOST_PERCENTAGE`: Percentage to boost gas price by for faster confirmations

### Executor Settings
- `EXECUTOR_TYPE`: Type of executor to use ('wallet' or 'relayer')
- `MAX_PENDING_TXS`: Maximum number of pending transactions
- `CONCURRENT_TXS`: Number of transactions to execute concurrently
- `MIN_CONFIRMATIONS`: Minimum confirmations before considering transaction final
- `RETRY_DELAY_MS`: Delay between transaction retries
- `MAX_RETRIES`: Maximum number of retry attempts for failed transactions

### Database Settings
- `DATABASE_TYPE`: Type of database to use ('json' or 'supabase')
- `JSON_DB_PATH`: Path to JSON database file (if using JSON database)

## Database Schema

The system uses the following database tables/collections:

1. **deposits**: Stores deposit information
   - `deposit_id`: Unique identifier
   - `owner_address`: Address of the deposit owner
   - `delegatee_address`: Address of the delegatee
   - `amount`: Amount staked

2. **processing_checkpoints**: Tracks component processing state
   - `component_type`: Type of component
   - `last_block_number`: Last processed block
   - `block_hash`: Hash of the last block
   - `last_update`: Timestamp of last update

3. **score_events**: Stores delegatee score events
   - `delegatee`: Delegatee address
   - `score`: Score value
   - `block_number`: Block number of the event

4. **processing_queue**: Manages processing queue items
   - Tracks deposit processing status
   - Stores profitability check results

5. **transaction_queue**: Manages transaction execution queue
   - Tracks transaction execution status
   - Stores transaction details

## Health Checks and Monitoring

The service exposes the following methods for health checking:

1. **Component Status**
   - Provides status information for each active component
   - Shows processing statistics and error counts

2. **Database Health**
   - Verifies database connectivity
   - Provides counts of records in key tables

3. **Transaction Statistics**
   - Shows counts of pending, processed, and failed transactions
   - Provides gas usage and profitability metrics

## Troubleshooting

Common issues and their solutions:

1. **Service fails to start**
   - Check environment variables are correctly set
   - Verify RPC endpoint is accessible
   - Ensure database connection is valid

2. **No transactions being executed**
   - Check profitability thresholds in configuration
   - Verify gas price settings
   - Ensure wallet has sufficient balance for transactions

3. **Database errors**
   - For JSON database: check file permissions
   - For Supabase: verify connection URL and API key

## Development

For local development:

1. Clone the repository
2. Install dependencies with `pnpm install`
3. Create a `.env.local` file with development settings
4. Run `pnpm dev` to start the service with auto-restart

### Running Tests

```bash
# Run all tests
pnpm test

# Run specific tests
pnpm test:integration
```

## License

ISC