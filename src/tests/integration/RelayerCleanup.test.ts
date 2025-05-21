import { Defender } from '@openzeppelin/defender-sdk'
import { RelayerTransaction, RelayerTransactionPayload } from '@openzeppelin/defender-sdk-relay-signer-client'
import { ethers } from 'ethers'
import { CONFIG } from '../../configuration'
import { ConsoleLogger as Logger } from '../../monitor/logging'
import { jest } from '@jest/globals';
import { RelayerStatus } from '@openzeppelin/defender-sdk-relay-signer-client';
import * as fs from 'fs';

// This test interacts with an actual OpenZeppelin Defender relayer. It will be **skipped** automatically
// when the required credentials are not present in the environment to avoid failing CI in unsupported
// environments.

describe('Relayer Cleanup', () => {
  let client: Defender
  const logger = new Logger('info', { prefix: '[RelayerCleanup]' })

  beforeAll(() => {
    // Skip test if Defender credentials are not configured
    if (!CONFIG.defender.apiKey || !CONFIG.defender.secretKey) {
      logger.warn('Skipping test - Defender credentials not configured')
      return
    }

    client = new Defender({
      relayerApiKey: CONFIG.defender.apiKey,
      relayerApiSecret: CONFIG.defender.secretKey,
    })

    // Allow plenty of time for network requests
    jest.setTimeout(180_000) // 3 minutes
  })

  it('should replace the pending transaction with lowest nonce using an approve call', async () => {
    // Increase timeout to 2 minutes
    jest.setTimeout(120000)

    try {
      // Get list of pending transactions
      const pendingResponse = await client.relaySigner.listTransactions({
        status: 'pending',
        limit: 50,
        sort: 'desc',
      })

      // Handle both array and paginated response types
      const pending = Array.isArray(pendingResponse) 
        ? pendingResponse 
        : pendingResponse.items || []

      logger.info('Found pending transactions:', {
        count: pending.length,
      })

      if (pending.length === 0) {
        logger.info('No pending transactions found')
        return
      }

      // Find transaction with lowest nonce
      const tx = pending.reduce((lowest: RelayerTransaction | null, current: RelayerTransaction) => 
        !lowest || current.nonce < lowest.nonce ? current : lowest
      , null) as RelayerTransaction

      if (!tx) {
        logger.error('Failed to find transaction with lowest nonce')
        return
      }

      logger.info('Found transaction with lowest nonce:', {
        transactionId: tx.transactionId,
        hash: tx.hash,
        nonce: tx.nonce,
      })

      // Create token contract interface for approve
      const tokenAbi = [
        'function approve(address spender, uint256 amount) returns (bool)',
      ] as const

      // Get the reward token address from config
      const rewardTokenAddress = CONFIG.profitability.rewardTokenAddress
      if (!rewardTokenAddress) {
        throw new Error('Reward token address not configured')
      }

      // Create token contract instance
      const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl)
      const tokenContract = new ethers.Contract(
        rewardTokenAddress,
        tokenAbi,
        provider
      )

      // Encode approve function call with max uint256 value
      const maxApproval = ethers.MaxUint256
      const approveData = tokenContract.interface.encodeFunctionData('approve', [
        CONFIG.govlst.address, // spender address
        maxApproval // amount
      ])

      // Prepare replacement transaction with approve call
      const replacement: RelayerTransactionPayload = {
        to: rewardTokenAddress, // send to token contract
        value: '0x00',
        data: approveData,
        speed: 'fastest',
        validUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes
        gasLimit: 60000, // Standard gas limit for approve
      }

      // Replace the transaction by ID
      const result = await client.relaySigner.replaceTransactionById(
        tx.transactionId,
        replacement,
      )

      logger.info('Successfully submitted replacement approve transaction:', {
        originalTxId: tx.transactionId,
        newTxHash: result.hash,
        nonce: result.nonce,
      })

      // Monitor the replacement transaction
      const receipt = await provider.waitForTransaction(result.hash, 1, 120000) // Wait up to 2 minutes
      
      if (receipt) {
        logger.info('Replacement approve transaction confirmed:', {
          hash: receipt.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          status: receipt.status === 1 ? 'success' : 'failed',
        })

        if (receipt.status === 0) {
          // Check logs for any error messages
          const logs = receipt.logs
          logger.info('Transaction logs:', { logs })
        }
      } else {
        logger.error('Replacement transaction not confirmed within timeout')
      }

    } catch (error) {
      logger.error('Failed to replace transaction:', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }, 120000) // Add timeout parameter to test

  it('lists and cleans up pending transactions on the relayer', async () => {
    // Increase timeout to 2 minutes
    jest.setTimeout(120000)

    try {
      // Get the relayer status which includes pending transactions count
      const status = await client.relaySigner.getRelayerStatus() as RelayerStatus
      logger.info('Initial relayer status:', { ...status } as Record<string, unknown>)

      // Get all pending transactions using the transactions method
      const pendingTransactionsResponse = await client.relaySigner.listTransactions({
        since: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
        status: 'pending',
        limit: 50
      })

      // Handle both array and paginated response types
      const pendingTransactions = Array.isArray(pendingTransactionsResponse) 
        ? pendingTransactionsResponse 
        : pendingTransactionsResponse.items || []

      console.log('Found pending transactions:', pendingTransactions.length)

      // Sort transactions by nonce and create CSV output
      const sortedTransactions = [...pendingTransactions].sort((a, b) => Number(a.nonce) - Number(b.nonce))
      
      // Create CSV header and rows
      const csvHeader = 'nonce,hash,status,transactionId,to,value,data,speed,gasLimit,type,gasDetails,sentAt'
      const csvRows = sortedTransactions.map(tx => {
        // Determine transaction type and gas details
        const isEIP1559 = 'maxFeePerGas' in tx
        const type = isEIP1559 ? 'EIP1559' : 'Legacy'
        const gasDetails = isEIP1559 
          ? `maxFeePerGas=${(tx as any).maxFeePerGas},maxPriorityFeePerGas=${(tx as any).maxPriorityFeePerGas}`
          : `gasPrice=${(tx as any).gasPrice}`

        return [
          tx.nonce,
          tx.hash,
          tx.status,
          tx.transactionId,
          tx.to,
          tx.value,
          tx.data,
          tx.speed,
          tx.gasLimit,
          type,
          gasDetails,
          tx.sentAt
        ].join(',')
      })

      // Combine header and rows
      const csvContent = [csvHeader, ...csvRows].join('\n')
      
      // Write to file and log to console
      fs.writeFileSync('pending-transactions.csv', csvContent)
      console.log('\nPending transactions in CSV format:')
      console.log(csvContent)

      // If nothing is pending the test succeeds trivially
      if (!pendingTransactions.length) {
        expect(pendingTransactions.length).toBe(0)
        return
      }

      // Replace each pending transaction with a minimal gas transaction
      const replacementPayload: RelayerTransactionPayload = {
        to: status.address, // Send to self - RelayerStatus has address property
        value: '0x0', // 0 ETH
        data: '0x', // Empty data
        speed: 'fastest',
        gasLimit: '21000', // Minimum gas for ETH transfer
        isPrivate: true, // Keep using private transactions
        validUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes from now
      }

      console.log('\nReplacing pending transactions...')
      
      for (const tx of pendingTransactions as RelayerTransaction[]) {
        if (tx.status !== 'pending') {
          console.log(`Skipping non-pending transaction ${tx.transactionId}`)
          continue
        }
        console.log(`Replacing transaction ${tx.transactionId} (nonce ${tx.nonce})`)
        await client.relaySigner.replaceTransactionById(tx.transactionId, replacementPayload)
      }

      // Verify transactions were replaced
      const finalStatus = await client.relaySigner.getRelayerStatus() as RelayerStatus
      console.log('Final relayer status:', finalStatus)

      // Get final pending transactions
      const finalPendingResponse = await client.relaySigner.listTransactions({
        since: new Date(Date.now() - 24 * 60 * 1000), // Last minute
        status: 'pending',
        limit: 50
      })

      // Handle both array and paginated response types
      const finalPendingTransactions = Array.isArray(finalPendingResponse)
        ? finalPendingResponse
        : finalPendingResponse.items || []

      console.log('Final pending transactions:', finalPendingTransactions.length)

      // We expect no pending transactions to remain
      const remainingPending = (finalPendingTransactions as RelayerTransaction[]).filter(tx => tx.status === 'pending')
      expect(remainingPending.length).toBe(0)
    } catch (error) {
      logger.error('Failed to clean up transactions:', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }, 120000) // Add timeout parameter to test
}) 