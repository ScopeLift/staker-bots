# Executor Component

The Executor component is responsible for managing and executing profitable bump transactions in a controlled, efficient manner. It handles wallet management, transaction queueing, execution, and tip collection.

## Core Features

### 1. Wallet Management

- Secure private key handling
- Balance monitoring with minimum thresholds
- Automatic tip collection when threshold reached
- Gas price optimization with configurable boost

### 2. Transaction Queue

- FIFO (First In, First Out) processing
- Configurable queue size limits
- Concurrent transaction execution
- Transaction status tracking (QUEUED → PENDING → CONFIRMED/FAILED)
- Automatic retry mechanism for failed transactions

### 3. Transaction Execution

- Gas price optimization with configurable boost percentage
- Confirmation monitoring with configurable confirmations
- Error handling and logging
- Transaction receipt tracking

### 4. Tip Management

- Automatic transfer of accumulated tips to configured receiver
- Configurable transfer threshold
- Gas cost calculation and optimization

## Usage

```typescript
import { ExecutorWrapper } from './executor';

// Initialize with custom configuration
const executor = new ExecutorWrapper(stakerContract, provider, {
  wallet: {
    privateKey: process.env.PRIVATE_KEY,
    minBalance: ethers.parseEther('0.1'), // 0.1 ETH
    maxPendingTransactions: 5,
  },
  maxQueueSize: 100,
  minConfirmations: 2,
  maxRetries: 3,
  retryDelayMs: 5000,
  transferOutThreshold: ethers.parseEther('0.5'), // 0.5 ETH
  gasBoostPercentage: 10, // 10%
  concurrentTransactions: 3,
});

// Start the executor
await executor.start();

// Queue a transaction
const tx = await executor.queueTransaction(depositId, profitabilityCheck);

// Monitor transaction status
const status = await executor.getTransaction(tx.id);

// Get queue statistics
const stats = await executor.getQueueStats();

// Transfer accumulated tips
await executor.transferOutTips();

// Stop the executor
await executor.stop();
```

## Configuration

| Parameter                       | Description                                    | Default  |
| ------------------------------- | ---------------------------------------------- | -------- |
| `wallet.privateKey`             | Private key for transaction signing            | Required |
| `wallet.minBalance`             | Minimum balance to maintain                    | 0.1 ETH  |
| `wallet.maxPendingTransactions` | Maximum concurrent pending transactions        | 5        |
| `maxQueueSize`                  | Maximum size of transaction queue              | 100      |
| `minConfirmations`              | Required confirmations for transactions        | 2        |
| `maxRetries`                    | Maximum retry attempts for failed transactions | 3        |
| `retryDelayMs`                  | Delay between retry attempts                   | 5000     |
| `transferOutThreshold`          | Balance threshold for tip transfer             | 0.5 ETH  |
| `gasBoostPercentage`            | Percentage to boost gas price                  | 10       |
| `concurrentTransactions`        | Maximum concurrent transactions                | 3        |

## Architecture

The component follows a modular architecture with clear separation of concerns:

```
executor/
├── interfaces/         # Type definitions and interfaces
├── strategies/         # Implementation strategies
├── constants.ts        # Default configuration
├── ExecutorWrapper.ts  # Main wrapper class
└── index.ts           # Public exports
```

## Error Handling

The executor implements robust error handling:

- Transaction failures are logged and retried
- Queue limits are enforced
- Wallet balance is monitored
- Gas price spikes are handled with configurable boost
- Network issues are caught and logged

## Testing

A comprehensive test suite is included in `test-executor.ts` that verifies:

- Queue management
- Transaction execution
- Status monitoring
- Error handling
- Tip transfers

### Test Setup

1. Place your staker contract ABI in `src/tests/abis/staker.json`
2. Set required environment variables:
   ```
   TEST_PRIVATE_KEY=your_test_wallet_private_key
   STAKER_CONTRACT_ADDRESS=your_contract_address
   RPC_URL=your_rpc_url
   TIP_RECEIVER=your_tip_receiver_address
   ```
3. Run the test: `npx tsx src/tests/test-executor.ts`

## Using RelayerExecutor with OpenZeppelin Defender

The RelayerExecutor allows you to send transactions via an OpenZeppelin Defender Relayer instead of using a local wallet. This provides better security, reliability, and gas management features.

### Setup

First, install the required dependencies:

```bash
pnpm add @openzeppelin/defender-sdk web3
```

### Configuration

To use the RelayerExecutor, you need an OpenZeppelin Defender account and a Relayer setup. Configure the executor with your Relayer credentials:

```typescript
import { ethers } from 'ethers';
import { ExecutorWrapper, ExecutorType } from './src/executor';

// Create provider
const provider = new ethers.JsonRpcProvider('https://mainnet.infura.io/v3/YOUR_INFURA_KEY');

// Load contract
const stakerAbi = [...]; // Contract ABI
const stakerAddress = '0x...'; // Contract address
const stakerContract = new ethers.Contract(stakerAddress, stakerAbi, provider);

// Configure executor with Relayer
const executor = new ExecutorWrapper(
  stakerContract,
  provider,
  ExecutorType.RELAYER, // Specify RelayerExecutor strategy
  {
    relayer: {
      apiKey: 'YOUR_DEFENDER_API_KEY',
      apiSecret: 'YOUR_DEFENDER_API_SECRET',
      minBalance: ethers.parseEther('0.1'),
      maxPendingTransactions: 5,
      gasPolicy: {
        maxFeePerGas: ethers.parseGwei('100'),
        maxPriorityFeePerGas: ethers.parseGwei('2')
      }
    },
    // Other options
    maxQueueSize: 100,
    minConfirmations: 2,
    concurrentTransactions: 5
  }
);

// Start executor
await executor.start();

// Queue a transaction
const depositId = BigInt(123);
const profitabilityCheck = {
  isEligible: true,
  estimates: {
    optimalTip: ethers.parseEther('0.01'),
    expectedProfit: ethers.parseEther('0.05')
  }
};

await executor.queueTransaction(depositId, profitabilityCheck);
```

### Benefits of Using RelayerExecutor

1. **Improved Security**: No private keys stored in your application
2. **Transaction Management**: Automatic gas price adjustments and transaction resubmission
3. **Monitoring**: Built-in monitoring and notification capabilities through Defender
4. **Reliability**: Higher transaction success rate with optimized gas pricing
5. **Scalability**: Easily create and manage multiple relayers for different chains

### Differences from BaseExecutor

- The RelayerExecutor doesn't require you to manage private keys in your application
- Gas settings can be managed through the OpenZeppelin Defender dashboard
- The RelayerExecutor doesn't implement transferOutTips() as relayers manage their own funds
- Transaction retry logic is handled by the Defender service
