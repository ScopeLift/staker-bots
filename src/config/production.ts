import { ethers } from 'ethers'

export const PRODUCTION_CONFIG = {
  profitability: {
    checkInterval: 300, // 5 minutes
    maxBatchSize: 50,
    minProfitMargin: 0.15, // 15%
    gasPriceBuffer: 1.2, // 20% buffer for gas price fluctuations
    retryDelay: 60, // 1 minute
    maxRetries: 3
  },
  monitor: {
    confirmations: 12,
    maxBlockRange: 5000,
    pollInterval: 13, // seconds
    healthCheckInterval: 60, // 1 minute
    maxReorgDepth: 100
  },
  executor: {
    queuePollInterval: 60, // seconds
    minExecutorBalance: ethers.parseEther('0.001'), // Changed from 0.1 to 0.001
    maxPendingTransactions: 10,
    gasLimitBuffer: 1.3, // 30% buffer for gas limit
    maxBatchSize: 50,
    retryDelay: 60, // 1 minute
    maxRetries: 3
  },
  // ... rest of the config ...
}
