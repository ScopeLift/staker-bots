import { ethers } from 'ethers'
import { RelayerExecutor } from './RelayerExecutor'
import { FlashbotsExecutorStrategy } from './FlashbotsExecutorStrategy'
import { QueuedTransaction, TransactionStatus, RelayerExecutorConfig } from '../interfaces/types'
import { pollForReceipt } from '@/configuration/helpers'
import { ErrorLogger } from '@/configuration/errorLogger'

/**
 * Extended configuration for RelayerExecutorWithMEV
 */
export interface MEVRelayerExecutorConfig extends RelayerExecutorConfig {
  useMevProtection: boolean
  errorLogger?: ErrorLogger
  flashbots?: {
    rpcUrl?: string
    chainId?: number
    fast?: boolean
  }
  wallet?: {
    privateKey?: string
  }
}

/**
 * RelayerExecutorWithMEV - Extends RelayerExecutor to add MEV protection with Flashbots
 * This allows transactions to be sent directly to miners/validators instead of
 * through the public mempool, preventing frontrunning attacks.
 */
export class RelayerExecutorWithMEV extends RelayerExecutor {
  protected flashbotsStrategy: FlashbotsExecutorStrategy | null = null
  protected useMevProtection: boolean
  protected privateWallet: ethers.Wallet | null = null
  protected readonly provider: ethers.Provider
  
  constructor(
    lstContract: ethers.Contract,
    provider: ethers.Provider,
    config: MEVRelayerExecutorConfig
  ) {
    super(lstContract, provider, config)
    
    // Store provider reference
    this.provider = provider;
    
    // Default to true if not specified
    this.useMevProtection = config.useMevProtection !== false
    
    // Initialize private wallet for Flashbots if needed
    if (this.useMevProtection) {
      if (config.wallet?.privateKey) {
        this.privateWallet = new ethers.Wallet(
          config.wallet.privateKey, 
          provider
        )
        
        // Initialize Flashbots strategy
        this.flashbotsStrategy = new FlashbotsExecutorStrategy(
          provider,
          this.privateWallet,
          this.logger,
          config.errorLogger,
          config.maxRetries || 3,
          config.flashbots
        )
        
        this.logger.info('MEV protection initialized with Flashbots and private wallet')
      } else {
        this.logger.warn(
          'MEV protection requested but no private key provided in config.wallet.privateKey. ' +
          'MEV protection will be disabled.'
        )
        this.useMevProtection = false
      }
    } else {
      this.logger.info('MEV protection disabled')
    }
  }
  
  /**
   * Override executeTransaction to use Flashbots if MEV protection is enabled
   */
  protected async executeTransaction(tx: QueuedTransaction): Promise<void> {
    // If MEV protection is disabled or not properly initialized, fall back to standard execution
    if (!this.useMevProtection || !this.flashbotsStrategy || !this.privateWallet) {
      return super.executeTransaction(tx)
    }
    
    // Update status to pending
    tx.status = TransactionStatus.PENDING
    
    try {
      // Extract deposit IDs and prepare transaction data
      const depositIds = tx.depositIds
      
      // Check if private wallet has enough balance
      const privateWalletAddress = this.privateWallet.address
      const balance = await this.provider.getBalance(privateWalletAddress)
      
      const gasLimit = tx.profitability.estimates.gas_estimate || BigInt(300000)
      const feeData = await this.provider.getFeeData()
      const gasPrice = feeData.gasPrice || ethers.parseUnits('30', 'gwei')
      const requiredBalance = gasPrice * gasLimit
      
      if (balance < requiredBalance) {
        this.logger.warn(
          'Insufficient balance in private wallet for Flashbots transaction',
          {
            address: privateWalletAddress,
            balance: ethers.formatEther(balance),
            required: ethers.formatEther(requiredBalance),
          }
        )
        
        // Fall back to standard execution
        return super.executeTransaction(tx)
      }
      
      // Get payout amount from contract for claim threshold calculation
      const payoutAmount = await this.lstContract.payoutAmount()
      
      // Calculate profit margin and optimal threshold
      const profitMargin = this.config.minProfitMargin || 10
      const includeGasCost = true // Default to including gas cost in threshold
      const profitMarginBasisPoints = BigInt(Math.floor(profitMargin * 100))
      
      // Base amount includes payout amount and gas cost
      const gasCost = gasPrice * gasLimit
      const baseAmount = payoutAmount + (includeGasCost ? gasCost : 0n)
      
      // Add profit margin
      const profitMarginAmount = (baseAmount * profitMarginBasisPoints) / 10000n
      const finalThreshold = baseAmount + profitMarginAmount
      
      // Encode transaction data for claim function
      const data = this.lstContract.interface.encodeFunctionData(
        'claimAndDistributeReward',
        [privateWalletAddress, finalThreshold, depositIds]
      )
      
      // Prepare transaction
      const transaction: ethers.TransactionRequest = {
        to: this.lstContract.target as string,
        data,
        gasLimit,
        gasPrice,
        from: privateWalletAddress,
      }
      
      // Try to submit via Flashbots
      this.logger.info('Attempting to submit transaction via Flashbots')
      const txHash = await this.flashbotsStrategy.submitTransaction(transaction)
      
      if (txHash) {
        this.logger.info('Transaction submitted via Flashbots', { txHash })
        
        // Update transaction hash
        tx.hash = txHash
        
        // Wait for confirmation
        try {
          const receipt = await pollForReceipt(
            txHash,
            this.provider,
            this.logger,
            this.config.minConfirmations || 1
          )
          
          // Update transaction status based on receipt
          if (receipt && receipt.status === 1) {
            tx.status = TransactionStatus.CONFIRMED
            this.logger.info('Transaction confirmed via Flashbots', {
              txHash,
              blockNumber: receipt.blockNumber,
            })
            
            // Clean up queue items
            if (this.db) {
              try {
                await this.cleanupQueueItems(tx, txHash)
              } catch (cleanupError) {
                this.logger.error('Failed to clean up queue items after successful transaction', {
                  error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                  txHash,
                })
              }
            }
            
            return
          } else {
            tx.status = TransactionStatus.FAILED
            tx.error = new Error('Transaction reverted or failed')
            this.logger.error('Transaction failed or reverted', { txHash })
          }
        } catch (waitError) {
          this.logger.error('Failed to confirm transaction', {
            error: waitError instanceof Error ? waitError.message : String(waitError),
            txHash,
          })
          
          // Set to failed and fall back to standard execution
          tx.status = TransactionStatus.FAILED
          tx.error = waitError instanceof Error ? waitError : new Error('Failed to confirm transaction')
        }
      }
      
      // If we get here, Flashbots submission failed or transaction failed
      this.logger.info('Flashbots submission unsuccessful, falling back to standard execution')
    } catch (error) {
      this.logger.error('Error with Flashbots submission:', { 
        error: error instanceof Error ? error.message : String(error) 
      })
    }
    
    // Fall back to standard Defender Relayer execution
    return super.executeTransaction(tx)
  }
  
  /**
   * Helper method to clean up queue items
   */
  private async cleanupQueueItems(tx: QueuedTransaction, txHash: string): Promise<void> {
    if (!this.db) return
    
    // Use the appropriate method to clean up queue items
    if (typeof (this as any).cleanupQueueItems === 'function') {
      await (this as any).cleanupQueueItems(tx, txHash)
    } else {
      // Fallback implementation if the parent class doesn't have this method
      const depositIds = tx.depositIds
      if (depositIds && depositIds.length > 0) {
        for (const depositId of depositIds) {
          const depositIdStr = depositId.toString()
          try {
            // Try to clean up any queue items for this deposit
            const queueItem = await this.db.getTransactionQueueItemByDepositId(depositIdStr)
            if (queueItem) {
              await this.db.deleteTransactionQueueItem(queueItem.id)
              this.logger.info(`Cleaned up queue item for deposit ${depositIdStr}`)
            }
          } catch (error) {
            this.logger.warn(`Failed to clean up queue item for deposit ${depositIdStr}`, {
              error: error instanceof Error ? error.message : String(error)
            })
          }
        }
      }
    }
  }
} 