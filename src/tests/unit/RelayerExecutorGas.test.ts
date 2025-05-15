import { ethers } from 'ethers'
import { RelayerExecutor } from '@/executor/strategies/RelayerExecutor'
import { GasCostEstimator } from '@/prices/GasCostEstimator'
import { CONFIG } from '@/configuration'
import { TransactionStatus, QueuedTransaction } from '@/executor/interfaces/types'

// Create test class to access protected methods
class TestRelayerExecutor extends RelayerExecutor {
  public async testExecuteTransaction(tx: QueuedTransaction): Promise<void> {
    return this.executeTransaction(tx);
  }
}

// Mock GasCostEstimator
jest.mock('@/prices/GasCostEstimator', () => {
  return {
    GasCostEstimator: jest.fn().mockImplementation(() => ({
      estimateGasCostInRewardToken: jest.fn(),
    })),
  }
})

// Mock CONFIG
jest.mock('@/configuration', () => ({
  CONFIG: {
    profitability: {
      includeGasCost: true,
      minProfitMargin: 10, // 10%
    },
    executor: {
      approvalAmount: '1000000000000000000', // 1 token
    },
    tenderly: {
      networkId: '1',
    },
  },
}))

// Mock Defender SDK
jest.mock('@openzeppelin/defender-relay-client/lib/ethers', () => {
  return {
    DefenderRelayProvider: jest.fn().mockImplementation(() => ({
      getBalance: jest.fn().mockResolvedValue(ethers.parseEther('1.0')),
      getFeeData: jest.fn().mockResolvedValue({
        gasPrice: ethers.parseUnits('20', 'gwei'),
        maxFeePerGas: ethers.parseUnits('25', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
      }),
      getBlockNumber: jest.fn().mockResolvedValue(1000),
      getTransactionReceipt: jest.fn().mockResolvedValue({
        status: 1,
        blockNumber: 1000,
        gasUsed: ethers.parseUnits('200000', 'wei'),
      }),
      estimateGas: jest.fn().mockImplementation(async (tx) => {
        // Return simulated gas limit if provided in tx, otherwise return initial estimate
        return tx.gasLimit || BigInt(300000)
      }),
      call: jest.fn().mockImplementation(async (tx) => {
        // Mock REWARD_TOKEN call
        if (tx.data?.includes('REWARD_TOKEN')) {
          return ethers.AbiCoder.defaultAbiCoder().encode(['address'], ['0x5678'])
        }
        return '0x'
      }),
    })),
    DefenderRelaySigner: jest.fn().mockImplementation(() => ({
      getAddress: jest.fn().mockResolvedValue('0x1234'),
      connect: jest.fn().mockReturnThis(),
      provider: {
        getBalance: jest.fn().mockResolvedValue(ethers.parseEther('1.0')),
        getFeeData: jest.fn().mockResolvedValue({
          gasPrice: ethers.parseUnits('20', 'gwei'),
          maxFeePerGas: ethers.parseUnits('25', 'gwei'),
          maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
        }),
        getBlockNumber: jest.fn().mockResolvedValue(1000),
        getTransactionReceipt: jest.fn().mockResolvedValue({
          status: 1,
          blockNumber: 1000,
          gasUsed: ethers.parseUnits('200000', 'wei'),
        }),
        estimateGas: jest.fn().mockImplementation(async (tx) => {
          // Return simulated gas limit if provided in tx, otherwise return initial estimate
          return tx.gasLimit || BigInt(300000)
        }),
        call: jest.fn().mockImplementation(async (tx) => {
          // Mock REWARD_TOKEN call
          if (tx.data?.includes('REWARD_TOKEN')) {
            return ethers.AbiCoder.defaultAbiCoder().encode(['address'], ['0x5678'])
          }
          return '0x'
        }),
      },
    })),
  }
})

describe('RelayerExecutor Gas Handling', () => {
  let executor: TestRelayerExecutor
  let mockLstContract: any
  let mockProvider: any
  let mockGasCostEstimator: jest.Mocked<GasCostEstimator>
  
  beforeEach(() => {
    jest.clearAllMocks()
    
    // Create contract interface with required functions
    const contractInterface = new ethers.Interface([
      'function claimAndDistributeReward(address recipient, uint256 minExpectedReward, uint256[] depositIds) returns (bool)',
      'function payoutAmount() view returns (uint256)',
      'function REWARD_TOKEN() view returns (address)',
    ])
    
    // Mock provider with same fee data
    mockProvider = {
      getBalance: jest.fn().mockResolvedValue(ethers.parseEther('1.0')),
      getFeeData: jest.fn().mockResolvedValue({
        gasPrice: ethers.parseUnits('20', 'gwei'),
        maxFeePerGas: ethers.parseUnits('25', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
      }),
      getBlockNumber: jest.fn().mockResolvedValue(1000),
      getTransactionReceipt: jest.fn().mockResolvedValue({
        status: 1,
        blockNumber: 1000,
        gasUsed: ethers.parseUnits('200000', 'wei'),
      }),
      estimateGas: jest.fn().mockImplementation(async (tx) => {
        // Return simulated gas limit if provided in tx, otherwise return initial estimate
        return tx.gasLimit || BigInt(300000)
      }),
      call: jest.fn().mockImplementation(async (tx) => {
        // Mock REWARD_TOKEN call
        if (tx.data?.includes('REWARD_TOKEN')) {
          return ethers.AbiCoder.defaultAbiCoder().encode(['address'], ['0x5678'])
        }
        return '0x'
      }),
    }
    
    // Mock contract with proper interface and runner
    mockLstContract = {
      target: '0x1234567890123456789012345678901234567890',
      interface: contractInterface,
      claimAndDistributeReward: jest.fn().mockImplementation(async (recipient, minExpectedReward, depositIds, overrides) => {
        return {
          hash: '0x123',
          wait: jest.fn().mockResolvedValue({
            status: 1,
            blockNumber: 1000,
            gasUsed: overrides.gasLimit,
          }),
          gasLimit: overrides.gasLimit,
          maxFeePerGas: overrides.maxFeePerGas,
          maxPriorityFeePerGas: overrides.maxPriorityFeePerGas,
        }
      }),
      payoutAmount: jest.fn(),
      REWARD_TOKEN: jest.fn().mockImplementation(async () => {
        return '0x5678'
      }),
      runner: {
        provider: mockProvider,
        call: jest.fn().mockImplementation(async (tx) => {
          // Mock REWARD_TOKEN call
          if (tx.data?.includes('REWARD_TOKEN')) {
            return ethers.AbiCoder.defaultAbiCoder().encode(['address'], ['0x5678'])
          }
          return '0x'
        }),
      },
      connect: jest.fn().mockReturnThis(),
      estimateGas: jest.fn().mockImplementation(async (tx) => {
        // Return simulated gas limit if provided in tx, otherwise return initial estimate
        return tx.gasLimit || BigInt(300000)
      }),
    }
    
    // Create executor instance using TestRelayerExecutor instead
    executor = new TestRelayerExecutor(mockLstContract, mockProvider, {
      address: '0x1234',
      apiKey: 'key',
      apiSecret: 'secret',
      minBalance: BigInt(1),
      maxPendingTransactions: 1,
      minProfitMargin: 10,
      maxQueueSize: 100,
      minConfirmations: 1,
      maxRetries: 3,
      retryDelayMs: 1000,
      gasPolicy: {
        maxFeePerGas: ethers.parseUnits('30', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('3', 'gwei'),
      },
      transferOutThreshold: BigInt('1000000000000000000'),
      gasBoostPercentage: 20,
      concurrentTransactions: 1,
      defaultTipReceiver: '0x1234567890123456789012345678901234567890',
    })
    
    mockGasCostEstimator = new GasCostEstimator() as jest.Mocked<GasCostEstimator>
  })
  
  it('should use simulated gas limit when available', async () => {
    const payoutAmount = ethers.parseUnits('100', 18)
    const initialGasEstimate = BigInt(300000)
    const simulatedGasLimit = BigInt(250000) // Lower than initial
    const gasCostInTokens = ethers.parseUnits('5', 18)
    
    // Mock contract calls
    mockLstContract.payoutAmount.mockResolvedValue(payoutAmount)
    mockLstContract.REWARD_TOKEN.mockResolvedValue('0x5678')
    
    // Mock gas cost estimation
    mockGasCostEstimator.estimateGasCostInRewardToken.mockResolvedValue(gasCostInTokens)
    
    // Mock estimateGas to return simulated gas limit
    mockProvider.estimateGas = jest.fn().mockResolvedValue(simulatedGasLimit)
    mockLstContract.estimateGas = jest.fn().mockResolvedValue(simulatedGasLimit)
    
    const tx: QueuedTransaction = {
      id: '1',
      depositIds: [1n],
      status: TransactionStatus.PENDING,
      createdAt: new Date(),
      profitability: {
        is_profitable: true,
        estimates: {
          gas_estimate: initialGasEstimate,
          expected_profit: ethers.parseUnits('120', 18),
          payout_amount: payoutAmount,
          total_shares: BigInt(1000),
          gas_cost: gasCostInTokens,
        },
        constraints: {
          has_enough_shares: true,
          meets_min_reward: true,
          meets_min_profit: true,
        },
        deposit_details: [
          {
            depositId: 1n,
            rewards: ethers.parseUnits('120', 18),
          }
        ],
      },
    }
    
    // Execute transaction using test method
    await executor.testExecuteTransaction(tx)
    
    // Verify gas parameters used in contract call
    expect(mockLstContract.claimAndDistributeReward).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(BigInt),
      expect.any(Array),
      expect.objectContaining({
        gasLimit: simulatedGasLimit,
        maxFeePerGas: ethers.parseUnits('30', 'gwei'), // From config
        maxPriorityFeePerGas: ethers.parseUnits('3', 'gwei'), // From config
      }),
    )
  }, 10000) // Increase timeout to 10 seconds
  
  it('should use network gas prices when config not provided', async () => {
    const payoutAmount = ethers.parseUnits('100', 18)
    const initialGasEstimate = BigInt(300000)
    const gasCostInTokens = ethers.parseUnits('5', 18)
    
    // Create executor without gas policy using TestRelayerExecutor
    const executorWithoutGasPolicy = new TestRelayerExecutor(mockLstContract, mockProvider, {
      address: '0x1234',
      apiKey: 'key',
      apiSecret: 'secret',
      minBalance: BigInt(1),
      maxPendingTransactions: 1,
      minProfitMargin: 10,
      maxQueueSize: 100,
      minConfirmations: 1,
      maxRetries: 3,
      retryDelayMs: 1000,
      transferOutThreshold: BigInt('1000000000000000000'),
      gasBoostPercentage: 20,
      concurrentTransactions: 1,
      defaultTipReceiver: '0x1234567890123456789012345678901234567890',
    })
    
    // Mock contract calls
    mockLstContract.payoutAmount.mockResolvedValue(payoutAmount)
    mockLstContract.REWARD_TOKEN.mockResolvedValue('0x5678')
    
    // Mock gas cost estimation
    mockGasCostEstimator.estimateGasCostInRewardToken.mockResolvedValue(gasCostInTokens)
    
    // Mock estimateGas to return initial gas estimate
    mockProvider.estimateGas = jest.fn().mockResolvedValue(initialGasEstimate)
    mockLstContract.estimateGas = jest.fn().mockResolvedValue(initialGasEstimate)
    
    const tx: QueuedTransaction = {
      id: '1',
      depositIds: [1n],
      status: TransactionStatus.PENDING,
      createdAt: new Date(),
      profitability: {
        is_profitable: true,
        estimates: {
          gas_estimate: initialGasEstimate,
          expected_profit: ethers.parseUnits('120', 18),
          payout_amount: payoutAmount,
          total_shares: BigInt(1000),
          gas_cost: gasCostInTokens,
        },
        constraints: {
          has_enough_shares: true,
          meets_min_reward: true,
          meets_min_profit: true,
        },
        deposit_details: [
          {
            depositId: 1n,
            rewards: ethers.parseUnits('120', 18),
          }
        ],
      },
    }
    
    // Execute transaction using test method
    await executorWithoutGasPolicy.testExecuteTransaction(tx)
    
    // Verify network gas prices were used
    expect(mockLstContract.claimAndDistributeReward).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(BigInt),
      expect.any(Array),
      expect.objectContaining({
        gasLimit: expect.any(BigInt),
        maxFeePerGas: ethers.parseUnits('25', 'gwei'), // From network
        maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'), // From network
      }),
    )
  }, 10000) // Increase timeout to 10 seconds
}) 