# Staker Profitability Monitor

A service that monitors staking deposits and executes profitable earning power bump transactions.

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
- Execute profitable transactions automatically
- Log all activities to the console

To stop the service gracefully, press Ctrl+C.

## Configuration

The service can be configured through the following parameters in `main.ts`:

- Poll interval: How often to check for profitable opportunities (default: 15s)
- Minimum profit margin: Minimum expected profit to execute a transaction (default: 0.001 ETH)
- Gas price buffer: Additional buffer on gas price estimates (default: 20%)
- Wallet minimum balance: Minimum wallet balance to maintain (default: 0.1 ETH)
- Maximum pending transactions: Maximum number of pending transactions (default: 5)
- Gas boost percentage: Percentage to boost gas price by (default: 10%)
- Concurrent transactions: Number of transactions to execute concurrently (default: 3)

## Database

The service uses a JSON file database by default (`staker-monitor-db.json`). This can be changed to use Supabase by modifying the database configuration in `main.ts`.