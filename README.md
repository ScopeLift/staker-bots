# Staker Profitability Monitor

A service that monitors staking deposits, executes profitable earning power bump transactions, and claims GovLst rewards.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment variables:
   Copy `.env.example` to `.env` and fill in the required values:

- `RPC_URL`: Your Ethereum RPC URL (e.g. from Alchemy or Infura)
- `STAKER_CONTRACT_ADDRESS`: The address of the Staker contract
- `PRIVATE_KEY`: Your wallet's private key (without 0x prefix)
- `GOVLST_ADDRESSES`: Comma-separated list of GovLst contract addresses

## Error Handling

The service implements a comprehensive error handling system:

### Component-Specific Error Classes

Each component has dedicated error classes that provide:
- Detailed error context
- Retry status indicators
- Type-safe error handling
- Automatic error logging

Example using the executor component:

```typescript
try {
  await executor.queueTransaction(depositIds, profitability)
} catch (error) {
  if (error instanceof ExecutorError) {
    console.error('Executor error:', {
      message: error.message,
      context: error.context,
      isRetryable: error.isRetryable
    })

    if (error.isRetryable) {
      // Handle retryable errors
    }
  }
}
```

### Error Categories

- **Validation Errors**: Non-retryable errors from invalid inputs or states
- **Network Errors**: Retryable errors from RPC or network issues
- **Contract Errors**: Method-specific errors from contract interactions
- **Resource Errors**: Balance or gas-related errors
- **Queue Errors**: Transaction queue management errors

### Error Logging

All errors are logged with:
- Error type and message
- Full error context
- Stack trace (when available)
- Component-specific details
- Retry status

Logs are written to:
- `output.log`: General operation logs
- `errors.log`: Detailed error logs with context

## Running the Service

1. Build the TypeScript code:

```bash
npm run build
```

2. Start the service:

```bash
npm start
```

The service will:

- Monitor deposits in the database
- Analyze profitability of earning power bumps
- Monitor and claim GovLst rewards
- Execute profitable transactions automatically
- Log all activities to the console

To stop the service gracefully, press Ctrl+C.

## Running Tests

The project includes comprehensive tests for all components and their integrations.

### Running All Tests

To run all tests sequentially:

```bash
npm test
```

### Running Individual Component Tests

```bash
npm run test:monitor       # Test monitor component
npm run test:govlst        # Test GovLst claimer component
npm run test:profitability # Test profitability engine
npm run test:executor      # Test executor component
```

### Running Integration Tests

```bash
npm run test:monitor-govlst                # Test monitor + GovLst integration
npm run test:monitor-govlst-profitability  # Test monitor + GovLst + profitability
npm run test:full                          # Test full integration of all components
```

All test results are logged to `output.log` and errors to `errors.log`.

## Configuration

The service can be configured through the following parameters in `config.ts`:

### Monitor Configuration
- Poll interval: How often to check for profitable opportunities (default: 15s)
- Gas price buffer: Additional buffer on gas price estimates (default: 20%)

### Profitability Configuration
- Minimum profit margin: Minimum expected profit to execute a transaction (default: 0.001 ETH)
- Maximum batch size: Maximum number of deposits to process in a batch (default: 10)

### Executor Configuration
- Wallet minimum balance: Minimum wallet balance to maintain (default: 0.1 ETH)
- Maximum pending transactions: Maximum number of pending transactions (default: 5)
- Gas boost percentage: Percentage to boost gas price by (default: 10%)
- Concurrent transactions: Number of transactions to execute concurrently (default: 3)

### GovLst Configuration
- Claim interval: How often to check for claimable rewards (default: 1 hour)
- Minimum profit margin: Minimum profit required for claims (default: 0.01 ETH)
- Maximum batch size: Maximum deposits per claim (default: 10)
- Gas price buffer: Buffer for gas price volatility (default: 20%)

## Database

The service uses a JSON file database by default (`staker-monitor-db.json`). This can be changed to use Supabase by modifying the database configuration in `config.ts`.

### Database Tables

- **deposits**: Tracks staking deposits
- **processing_checkpoints**: Tracks component processing state
- **govlst_deposits**: Tracks GovLst-owned deposits
- **govlst_claim_history**: Records GovLst claim executions
