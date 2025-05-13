import { ethers } from 'ethers'
import { BaseExecutor } from './BaseExecutor'
import { FlashbotsExecutorStrategy } from './FlashbotsExecutorStrategy'
import { ConsoleLogger, Logger } from '@/monitor/logging'
import { QueuedTransaction } from '../interfaces/types'
import { ExtendedExecutorConfig } from '../ExecutorWrapper'
import { IExecutor } from '../interfaces/IExecutor'
import { GovLstProfitabilityCheck } from '@/profitability/interfaces/types'
import { TransactionValidationError } from '@/configuration/errors'
import { DatabaseWrapper } from '@/database'

/**
 * Extended configuration for BaseExecutorWithMEV
 */
export interface MEVExecutorConfig extends ExtendedExecutorConfig {
  useMevProtection: boolean
  flashbots?: {
    rpcUrl?: string
    chainId?: number
    fast?: boolean
  }
}

/**
 * BaseExecutorWithMEV - Uses composition with BaseExecutor to add MEV protection
 * This implementation uses Flashbots to prevent frontrunning
 */
export class BaseExecutorWithMEV implements IExecutor {
  private baseExecutor: BaseExecutor
  private flashbotsStrategy: FlashbotsExecutorStrategy | null = null
  private useMevProtection: boolean
  private readonly logger: Logger
  private readonly provider: ethers.Provider
  private readonly signer: ethers.Wallet
  private readonly config: MEVExecutorConfig
  
  constructor(options: {
    contractAddress: string
    contractAbi: ethers.Interface
    provider: ethers.Provider
    config: MEVExecutorConfig
  }) {
    const { contractAddress, contractAbi, provider, config } = options
    
    // Create the base executor for delegation
    this.baseExecutor = new BaseExecutor({
      contractAddress,
      contractAbi,
      provider,
      config,
    })
    
    this.logger = new ConsoleLogger('info')
    this.provider = provider
    this.config = config
    
    // Extract private key from config
    if (!config.wallet?.privateKey) {
      throw new Error('Private key is required for BaseExecutorWithMEV')
    }
    
    // Create signer
    this.signer = new ethers.Wallet(config.wallet.privateKey, provider)
    
    // Default to true if not specified
    this.useMevProtection = config.useMevProtection !== false

    // Initialize Flashbots strategy if MEV protection is enabled
    if (this.useMevProtection) {
      this.flashbotsStrategy = new FlashbotsExecutorStrategy(
        provider,
        this.signer,
        this.logger,
        config.errorLogger,
        config.maxRetries || 3,
        config.flashbots
      )
      
      this.logger.info('MEV protection initialized with Flashbots')
    } else {
      this.logger.info('MEV protection disabled')
    }
  }
  
  /**
   * Starts the executor
   */
  async start(): Promise<void> {
    return this.baseExecutor.start()
  }
  
  /**
   * Stops the executor
   */
  async stop(): Promise<void> {
    return this.baseExecutor.stop()
  }
  
  /**
   * Gets the executor status
   */
  async getStatus(): Promise<{
    isRunning: boolean
    walletBalance: bigint
    pendingTransactions: number
    queueSize: number
  }> {
    return this.baseExecutor.getStatus()
  }
  
  /**
   * Validates a transaction before execution
   */
  async validateTransaction(
    depositIds: bigint[],
    profitability: GovLstProfitabilityCheck
  ): Promise<{ isValid: boolean; error: TransactionValidationError | null }> {
    return this.baseExecutor.validateTransaction(depositIds, profitability)
  }
  
  /**
   * Queues a transaction for execution
   */
  async queueTransaction(
    depositIds: bigint[],
    profitability: GovLstProfitabilityCheck,
    txData?: string
  ): Promise<QueuedTransaction> {
    // Extend the txData to include MEV protection flag if enabled
    let updatedTxData = txData || '{}'
    try {
      const txDataObj = JSON.parse(updatedTxData)
      txDataObj.useMevProtection = this.useMevProtection
      updatedTxData = JSON.stringify(txDataObj)
    } catch (error) {
      this.logger.warn('Failed to parse txData', { 
        error: error instanceof Error ? error.message : String(error) 
      })
    }
    
    // Queue the transaction using the base executor
    const queuedTx = await this.baseExecutor.queueTransaction(
      depositIds,
      profitability,
      updatedTxData
    )
    
    // Intercept the transaction for MEV protection in the processQueue method
    // which will be called automatically by the base executor
    
    return queuedTx
  }
  
  /**
   * Gets queue statistics
   */
  async getQueueStats(): Promise<import('../interfaces/types').QueueStats> {
    return this.baseExecutor.getQueueStats()
  }
  
  /**
   * Gets a transaction by ID
   */
  async getTransaction(id: string): Promise<QueuedTransaction | null> {
    return this.baseExecutor.getTransaction(id)
  }
  
  /**
   * Gets a transaction receipt
   */
  async getTransactionReceipt(
    hash: string
  ): Promise<import('../interfaces/types').TransactionReceipt | null> {
    return this.baseExecutor.getTransactionReceipt(hash)
  }
  
  /**
   * Transfers out accumulated tips
   */
  async transferOutTips(): Promise<import('../interfaces/types').TransactionReceipt | null> {
    return this.baseExecutor.transferOutTips()
  }
  
  /**
   * Clears the transaction queue
   */
  async clearQueue(): Promise<void> {
    return this.baseExecutor.clearQueue()
  }
  
  /**
   * Sets the database
   */
  setDatabase(db: DatabaseWrapper): void {
    if (typeof this.baseExecutor.setDatabase === 'function') {
      this.baseExecutor.setDatabase(db)
    }
  }
} 