import { Logger } from '@/monitor/logging';
import { Defender } from '@openzeppelin/defender-sdk';
import { RelayerTransactionState } from '../interfaces/types';
import { ethers } from 'ethers';
import { CONFIG } from '@/configuration';
import { RelayerTransaction, RelayerTransactionPayload } from '@openzeppelin/defender-sdk-relay-signer-client';

// Add transaction state tracking
export type TransactionStateMap = {
  [hash: string]: {
    status: 'pending' | 'cancelled' | 'included' | 'replaced' | 'unknown';
    nonce: number;
    lastChecked: number;
    replacementHash?: string;
    attempts: number;
  }
};

// Add type for Defender transaction response
type DefenderTransaction = RelayerTransaction & {
  createdAt?: string;
};

// Add type for Flashbots response
type FlashbotsResponse = {
  status: string;
  hash: string;
  maxBlockNumber?: number;
  transaction?: {
    nonce: string;
    from: string;
    to: string;
  };
};

/**
 * Inspect the Defender relayer for any on-chain *pending* transactions. If any are found we
 * proactively replace each of them with a minimal 0-value NOOP so that they are effectively
 * cancelled. This helps us keep only a single in-flight transaction at any time and prevents
 * spamming the mempool. The method returns **true** when at least one pending transaction was
 * detected (regardless of whether replacement succeeded for every tx) so that callers can take
 * the appropriate action (e.g. early-exit from `executeTransaction`).
 */
export async function handlePendingRelayerTransactions(
  defenderClient: Defender | null,
  logger: Logger,
  govLstAddress: string,
): Promise<boolean> {
  // If the client is not available (should never happen), just bail.
  if (!defenderClient) return false;

  try {
    // Retrieve the latest pending transactions (newest first, max 50 to stay well under rate-limits)
    const pending = await defenderClient.relaySigner.list({
      status: 'pending',
      limit: 50,
      sort: 'desc',
    } as any);

    if (!pending || pending.length === 0) return false;

    logger.info('Pending relayer transactions detected', {
      count: pending.length,
    });

    // Prepare a generic NOOP replacement payload as recommended by OZ docs
    const baseReplacement = {
      to: govLstAddress,
      value: '0x00',
      data: '0x',
      speed: 'fastest',
      validUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes
      gasLimit: 21000,
    } as const;

    for (const tx of pending) {
      try {
        // Replace by ID keeps the same nonce but cancels the transaction.
        await defenderClient.relaySigner.replaceTransactionById(
          // `transactionId` is guaranteed on items returned by `list()`
          (tx as any).transactionId,
          baseReplacement,
        );

        logger.info('Replaced pending transaction', {
          transactionId: (tx as any).transactionId,
          nonce: tx.nonce,
        });
      } catch (replaceErr) {
        logger.error('Failed to replace pending transaction', {
          transactionId: (tx as any).transactionId,
          error:
            replaceErr instanceof Error
              ? replaceErr.message
              : String(replaceErr),
        });
      }
    }

    // Return true *even if* some replacements errored — what matters is that we found pending txs.
    return true;
  } catch (err) {
    logger.error('handlePendingRelayerTransactions error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Clean up stale transactions from the pending transactions map
 */
export async function cleanupStaleTransactions(
  pendingTransactions: Map<string, RelayerTransactionState>,
  txTimeout: number,
  defenderClient: Defender | null,
  govLstAddress: string,
  logger: Logger,
): Promise<void> {
  try {
    const now = Date.now();
    const staleIds: string[] = [];
    const transactionStates: TransactionStateMap = {};

    // First, get all pending transactions from Defender
    const pendingDefenderTxs = defenderClient ? await defenderClient.relaySigner.list({
      status: 'pending',
      limit: 50,
      sort: 'asc', // Get oldest first
    } as any).then((txs: unknown) => (txs as any[]).map(tx => ({
      nonce: Number(tx.nonce),
      hash: String(tx.hash),
      transactionId: String(tx.transactionId),
      status: String(tx.status),
    }))) : [];

    logger.info('Current pending transactions state:', {
      inMemoryCount: pendingTransactions.size,
      defenderPendingCount: pendingDefenderTxs.length,
    });

    // Map out all transaction states
    for (const [id, state] of pendingTransactions.entries()) {
      const isStale = now - state.submittedAt > txTimeout;
      
      if (isStale) {
        staleIds.push(id);
      }

      // Check Flashbots status for each transaction
      try {
        const response = await fetch(`https://protect.flashbots.net/tx/${state.hash}`);
        const data = await response.json() as FlashbotsResponse;
        
        // Get nonce from Defender transaction if available
        const defenderTx = pendingDefenderTxs.find((tx: DefenderTransaction) => tx.hash === state.hash);
        
        const txStatus = ((data.status || 'unknown').toLowerCase()) as TransactionStateMap[string]['status'];
        if (state.hash) {
          transactionStates[state.hash] = {
            status: txStatus,
            nonce: defenderTx?.nonce || 0,
            lastChecked: now,
            attempts: state.retryCount || 0,
          };
        }

        logger.info('Transaction state:', {
          hash: state.hash,
          status: data.status,
          nonce: defenderTx?.nonce || 'unknown',
          age: Math.floor((now - state.submittedAt) / 1000) + 's',
          isStale,
        });
      } catch (error) {
        logger.error('Failed to check transaction status:', {
          hash: state.hash,
          error: error instanceof Error ? error.message : String(error),
        });
        
        // Add unknown state for failed checks
        if (state.hash) {
          transactionStates[state.hash] = {
            status: 'unknown',
            nonce: 0,
            lastChecked: now,
            attempts: state.retryCount || 0,
          };
        }
      }
    }

    if (staleIds.length === 0) {
      logger.info('No stale transactions found', {
        totalTracked: pendingTransactions.size,
        states: Object.values(transactionStates).reduce((acc, curr) => {
          const status = curr.status;
          acc[status] = (acc[status] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
      });
      return;
    }

    if (!defenderClient) {
      logger.warn('Defender client not available for cleanup', {
        staleCount: staleIds.length,
      });
      return;
    }

    // Group transactions by nonce
    const byNonce = Object.entries(transactionStates).reduce((acc, [hash, state]) => {
      const nonce = state.nonce;
      if (!acc[nonce]) {
        acc[nonce] = [];
      }
      acc[nonce].push({ hash, ...state });
      return acc;
    }, {} as Record<number, Array<{ hash: string; status: string; nonce: number; attempts: number }>>);

    logger.info('Transaction nonce distribution:', {
      nonceGroups: Object.keys(byNonce).length,
      nonceDetails: Object.entries(byNonce).map(([nonce, txs]) => ({
        nonce,
        count: txs.length,
        statuses: txs.map(tx => tx.status),
      })),
    });

    // Process each stale transaction
    for (const id of staleIds) {
      const state = pendingTransactions.get(id);
      if (!state?.hash) continue;

      try {
        // Only replace if transaction is not already included or replaced
        const txState = transactionStates[state.hash];
        if (txState && (txState.status === 'included' || txState.status === 'replaced')) {
          logger.info('Skipping already processed transaction:', {
            hash: state.hash,
            status: txState.status,
          });
          continue;
        }

        const replacement = {
          to: govLstAddress,
          value: '0x00',
          data: '0x',
          speed: 'fastest',
          validUntil: new Date(now + 1000 * 60 * 15).toISOString(),
          gasLimit: 21000,
        };

        logger.info('Attempting to replace stale transaction:', {
          hash: state.hash,
          id,
          age: Math.floor((now - state.submittedAt) / 1000) + 's',
        });

        const result = await defenderClient.relaySigner.replaceTransactionById(
          state.transactionId || state.hash,
          replacement,
        );

        logger.info('Successfully replaced stale transaction:', {
          originalHash: state.hash,
          newHash: result.hash,
          nonce: result.nonce,
        });

        // Update state tracking
        transactionStates[state.hash] = {
          status: 'replaced',
          nonce: result.nonce,
          lastChecked: now,
          attempts: (txState?.attempts || 0) + 1,
          replacementHash: result.hash,
        };

        transactionStates[result.hash] = {
          status: 'pending',
          nonce: result.nonce,
          lastChecked: now,
          attempts: 0,
        };
      } catch (error) {
        logger.error('Failed to replace stale transaction:', {
          id,
          hash: state.hash,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      pendingTransactions.delete(id);
    }

    // Final state report
    logger.info('Cleanup cycle completed:', {
      processedCount: staleIds.length,
      remainingCount: pendingTransactions.size,
      statesSummary: Object.values(transactionStates).reduce((acc, curr) => {
        const status = curr.status;
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      nonceGroups: Object.keys(byNonce).length,
    });
  } catch (error) {
    logger.error('Error in cleanup:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

/**
 * Check if a transaction has been cancelled in Flashbots simulation and handle replacement if needed
 */
export async function handleFlashbotsSimulationAndReplacement(
  hash: string,
  defenderClient: Defender | null,
  rewardTokenAddress: string,
  govLstAddress: string,
  logger: Logger,
): Promise<{ isIncluded: boolean; replacementHash?: string }> {
  try {
    // Check Flashbots simulation status
    const response = await fetch(`https://protect.flashbots.net/tx/${hash}`);
    const data = await response.json();

    logger.info('Flashbots simulation status:', {
      hash,
      status: data.status,
    });

    // If transaction is CANCELLED, we need to replace it with an approve
    if (data.status === 'CANCELLED') {
      if (!defenderClient) {
        throw new Error('Defender client not available for replacement');
      }

      // Get the transaction to find its nonce
      const tx = await defenderClient.relaySigner.getTransaction(hash);
      if (!tx) {
        throw new Error(`Transaction ${hash} not found`);
      }

      // Create token contract interface for approve
      const tokenAbi = [
        'function approve(address spender, uint256 amount) returns (bool)',
      ] as const;

      // Create token contract instance to encode approve call
      const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);
      const tokenContract = new ethers.Contract(
        rewardTokenAddress,
        tokenAbi,
        provider,
      );

      // Encode approve function call with max uint256 value
      const maxApproval = ethers.MaxUint256;
      const approveData = tokenContract.interface.encodeFunctionData('approve', [
        govLstAddress,
        maxApproval,
      ]);

      // Prepare replacement transaction with approve call
      const replacement = {
        to: rewardTokenAddress,
        value: '0x00',
        data: approveData,
        speed: 'fastest',
        validUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        gasLimit: 60000,
      };

      // Replace the transaction
      const result = await defenderClient.relaySigner.replaceTransactionById(
        tx.transactionId,
        replacement,
      );

      logger.info('Replaced cancelled transaction with approve:', {
        originalHash: hash,
        newHash: result.hash,
        nonce: result.nonce,
      });

      // Wait for replacement to be included
      let isIncluded = false;
      let retries = 0;
      const maxRetries = 10;

      while (!isIncluded && retries < maxRetries) {
        const replacementStatus = await fetch(`https://protect.flashbots.net/tx/${result.hash}`);
        const replacementData = await replacementStatus.json();

        if (replacementData.status === 'INCLUDED') {
          isIncluded = true;
          logger.info('Replacement approve transaction included', {
            hash: result.hash,
          });
          return { isIncluded: true, replacementHash: result.hash };
        }

        // Wait 3 seconds between checks
        await new Promise(resolve => setTimeout(resolve, 3000));
        retries++;
      }

      return { isIncluded: false, replacementHash: result.hash };
    }

    // If transaction is INCLUDED, we're good to go
    if (data.status === 'INCLUDED') {
      return { isIncluded: true };
    }

    // For any other status, return not included
    return { isIncluded: false };
  } catch (error) {
    logger.error('Error checking Flashbots simulation status:', {
      error: error instanceof Error ? error.message : String(error),
      hash,
    });
    throw error;
  }
}

/**
 * Check transaction status using Flashbots Protect API
 */
async function checkFlashbotsStatus(hash: string): Promise<FlashbotsResponse> {
  const response = await fetch(`https://protect.flashbots.net/tx/${hash}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch Flashbots status: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Startup cleanup function to handle old pending/cancelled transactions
 */
export async function handleStartupCleanup(
  defenderClient: Defender | null,
  rewardTokenAddress: string,
  govLstAddress: string,
  logger: Logger,
  ageThresholdMs: number = 60 * 60 * 1000, // 1 hour default
): Promise<void> {
  try {
    // Initialize Defender client if not provided
    const client = new Defender({
      relayerApiKey: CONFIG.defender.apiKey,
      relayerApiSecret: CONFIG.defender.secretKey,
    });

    if (!client) {
      logger.warn('Defender client not available for startup cleanup');
      return;
    }

    // Get all pending transactions from Defender
    const pendingTxsResponse = await client.relaySigner.listTransactions({
      status: 'pending',
      limit: 50,
      sort: 'desc',
    });

    // Handle both array and paginated response types
    const pendingTxs = (Array.isArray(pendingTxsResponse) 
      ? pendingTxsResponse 
      : pendingTxsResponse.items || []) as DefenderTransaction[];

    if (pendingTxs.length === 0) {
      logger.info('No pending transactions found during startup');
      return;
    }

    logger.info('Found pending transactions during startup:', {
      count: pendingTxs.length,
    });

    // Group transactions by nonce
    const byNonce = pendingTxs.reduce((acc: Record<number, DefenderTransaction[]>, tx: DefenderTransaction) => {
      const nonce = tx.nonce;
      acc[nonce] = acc[nonce] || [];
      acc[nonce].push(tx);
      return acc;
    }, {} as Record<number, DefenderTransaction[]>);

    // Process each nonce group, starting from lowest nonce
    const nonces = Object.keys(byNonce).map(Number).sort((a, b) => a - b);
    
    logger.info('Processing nonce groups:', {
      nonceCount: nonces.length,
      nonces: nonces.join(', '),
    });

    for (const nonce of nonces) {
      const transactions = byNonce[nonce] || [];
      logger.info(`Processing transactions for nonce ${nonce}:`, {
        count: transactions.length,
        hashes: transactions.map((tx: DefenderTransaction) => tx.hash).join(', '),
      });

      // Check each transaction's status
      for (const tx of transactions) {
        try {
          const status = await checkFlashbotsStatus(tx.hash);
          const createdAt = tx.createdAt ? new Date(tx.createdAt).getTime() : Date.now() - ageThresholdMs - 1;
          const age = Date.now() - createdAt;

          logger.info('Transaction status:', {
            hash: tx.hash,
            status: status.status,
            age: Math.floor(age / 1000 / 60) + ' minutes',
            nonce,
          });

          // Only process old transactions that are pending or cancelled
          if (age > ageThresholdMs && 
             (status.status === 'PENDING' || status.status === 'CANCELLED')) {
            logger.info('Replacing old transaction:', {
              hash: tx.hash,
              status: status.status,
              age: Math.floor(age / 1000 / 60) + ' minutes',
              nonce,
            });

            // Create token contract interface for approve
            const tokenAbi = [
              'function approve(address spender, uint256 amount) returns (bool)',
            ] as const;

            // Create token contract instance to encode approve call
            const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);
            const tokenContract = new ethers.Contract(
              rewardTokenAddress,
              tokenAbi,
              provider,
            );

            // Encode approve function call with max uint256 value
            const maxApproval = ethers.MaxUint256;
            const approveData = tokenContract.interface.encodeFunctionData('approve', [
              govLstAddress,
              maxApproval,
            ]);

            // Prepare replacement transaction
            const replacement: RelayerTransactionPayload = {
              to: rewardTokenAddress,
              value: '0x00',
              data: approveData,
              speed: 'fastest',
              validUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
              gasLimit: 60000,
            };

            // Replace the transaction
            const result = await client.relaySigner.replaceTransactionById(
              tx.transactionId,
              replacement,
            );

            logger.info('Successfully replaced transaction:', {
              originalHash: tx.hash,
              newHash: result.hash,
              nonce: result.nonce,
            });

            // Wait for replacement to be included
            let isIncluded = false;
            let retries = 0;
            const maxRetries = 10;

            while (!isIncluded && retries < maxRetries) {
              const replacementStatus = await checkFlashbotsStatus(result.hash);
              
              if (replacementStatus.status === 'INCLUDED') {
                isIncluded = true;
                logger.info('Replacement transaction included:', {
                  hash: result.hash,
                  nonce: result.nonce,
                });
                break;
              }

              // Wait 3 seconds between checks
              await new Promise(resolve => setTimeout(resolve, 3000));
              retries++;
            }

            if (!isIncluded) {
              logger.warn('Replacement transaction not included after max retries:', {
                hash: result.hash,
                nonce: result.nonce,
              });
            }

            // Break after processing one transaction per nonce
            break;
          }
        } catch (error) {
          logger.error('Error processing transaction:', {
            hash: tx.hash,
            nonce,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    logger.info('Startup cleanup completed');
  } catch (error) {
    logger.error('Error in startup cleanup:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
} 