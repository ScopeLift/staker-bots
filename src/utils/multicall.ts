import { ethers } from 'ethers';
import { Logger } from '@/monitor/logging';
import { CUMonitor } from './CUMonitor';
import { SimplifiedLogger } from './SimplifiedLogger';

// Multicall3 contract address (deployed on all major networks)
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

// Multicall3 ABI - minimal interface for aggregate3
const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)'
];

/**
 * Utility class for batch contract calls using multicall pattern
 */
export class MulticallBatcher {
  private readonly provider: ethers.Provider;
  private readonly logger: Logger;
  private readonly simpleLogger: SimplifiedLogger;
  private readonly maxConcurrentCalls: number;
  private readonly delayBetweenBatches: number;
  private readonly multicall3Contract: ethers.Contract;
  private readonly useNativeMulticall: boolean;
  private readonly cuMonitor?: CUMonitor;

  constructor(
    provider: ethers.Provider,
    logger: Logger,
    maxConcurrentCalls = 10,
    delayBetweenBatches = 100,
    useNativeMulticall = true,
    cuMonitor?: CUMonitor
  ) {
    this.provider = provider;
    this.logger = logger;
    this.simpleLogger = new SimplifiedLogger(logger, 'Multicall');
    this.maxConcurrentCalls = maxConcurrentCalls;
    this.delayBetweenBatches = delayBetweenBatches;
    this.useNativeMulticall = useNativeMulticall;
    this.cuMonitor = cuMonitor;
    this.multicall3Contract = new ethers.Contract(
      MULTICALL3_ADDRESS,
      MULTICALL3_ABI,
      provider
    );
  }

  /**
   * Batches multiple contract calls using Multicall3 for maximum CU efficiency
   * @param calls Array of contract calls to batch
   * @returns Array of decoded results
   */
  async batchCalls<T>(
    calls: Array<{
      contract: ethers.Contract;
      method: string;
      params: unknown[];
      resultDecoder: (data: string) => T;
    }>,
  ): Promise<Array<T | null>> {
    if (calls.length === 0) return [];

    if (this.useNativeMulticall && calls.length > 1) {
      return this.batchCallsWithMulticall3(calls);
    } else {
      return this.batchCallsIndividually(calls);
    }
  }

  /**
   * Uses Multicall3 contract for true batching - saves significant CUs
   * Multiple eth_calls become 1 eth_call = ~26 CUs instead of 26*N CUs
   */
  private async batchCallsWithMulticall3<T>(
    calls: Array<{
      contract: ethers.Contract;
      method: string;
      params: unknown[];
      resultDecoder: (data: string) => T;
    }>,
  ): Promise<Array<T | null>> {
    try {
      // Prepare multicall data
      const multicallData = await Promise.all(
        calls.map(async (call) => ({
          target: await call.contract.getAddress(),
          allowFailure: true,
          callData: call.contract.interface.encodeFunctionData(
            call.method,
            call.params
          )
        }))
      );

      // Execute single multicall

      const results = await this.multicall3Contract.aggregate3?.(multicallData);

      // Process results
      const decodedResults = results.map((result: any, index: number) => {
        if (!result.success) {
          this.logger.warn('Individual call failed in multicall batch', {
            method: calls[index]?.method,
            index
          });
          return null;
        }

        try {
          return calls[index]?.resultDecoder(result.returnData);
        } catch (error) {
          this.logger.warn('Failed to decode multicall result', {
            method: calls[index]?.method,
            index,
            error: error instanceof Error ? error.message : String(error)
          });
          return null;
        }
      });

      // Track CU usage with accurate calculation
      if (this.cuMonitor) {
        this.cuMonitor.trackBatchOperation('multicall_batch', calls.length, true);
      }
      
      const successCount = decodedResults.filter((r: any) => r !== null).length;
      this.simpleLogger.trackBatch('multicall3', calls.length, true);
      
      // No logging for partial failures

      return decodedResults;
    } catch (error) {
      // Silently fallback to individual calls - no logging needed
      return this.batchCallsIndividually(calls);
    }
  }

  /**
   * Fallback method using individual calls with rate limiting
   */
  private async batchCallsIndividually<T>(
    calls: Array<{
      contract: ethers.Contract;
      method: string;
      params: unknown[];
      resultDecoder: (data: string) => T;
    }>,
  ): Promise<Array<T | null>> {
    try {
      // Create individual call promises
      const callPromises = calls.map(async (call) => {
        try {
          // Encode the function call
          const callData = call.contract.interface.encodeFunctionData(
            call.method,
            call.params,
          );

          // Execute the call
          const result = await this.provider.call({
            to: await call.contract.getAddress(),
            data: callData,
          });

          // Decode the result
          return call.resultDecoder(result);
        } catch (error) {
          // Only log individual failures in debug mode
          this.simpleLogger.debug('Individual call failed', {
            method: call.method,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      });

      // Execute calls with rate limiting
      const results = await this.executeWithRateLimit(callPromises);

      // Track CU usage for individual calls
      if (this.cuMonitor) {
        this.cuMonitor.trackBatchOperation('eth_call', calls.length, false);
      }
      
      const successCount = results.filter((r) => r !== null).length;
      this.simpleLogger.trackBatch('eth_call', calls.length, false);
      
      // No logging for partial failures

      return results;
    } catch (error) {
      this.logger.error('Batch call failed', {
        error: error instanceof Error ? error.message : String(error),
        callCount: calls.length,
      });
      throw error;
    }
  }

  /**
   * Batches unclaimed reward calls for multiple deposit IDs
   * @param contract Staker contract instance
   * @param depositIds Array of deposit IDs to check
   * @returns Array of unclaimed reward amounts (null for failed calls)
   */
  async batchUnclaimedRewards(
    contract: ethers.Contract,
    depositIds: bigint[],
  ): Promise<Array<bigint | null>> {
    const calls = depositIds.map((depositId) => ({
      contract,
      method: 'unclaimedReward',
      params: [depositId],
      resultDecoder: (data: string) => {
        try {
          const decoded = contract.interface.decodeFunctionResult(
            'unclaimedReward',
            data,
          );
          return BigInt(decoded[0].toString());
        } catch (error) {
          this.logger.warn('Failed to decode unclaimedReward result', {
            depositId: depositId.toString(),
            data,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },
    }));

    return this.batchCalls(calls);
  }

  /**
   * Batches deposit info calls for multiple deposit IDs
   * @param contract Staker contract instance
   * @param depositIds Array of deposit IDs to fetch
   * @returns Array of deposit info objects (null for failed calls)
   */
  async batchDepositInfo(
    contract: ethers.Contract,
    depositIds: bigint[],
  ): Promise<
    Array<{
      balance: bigint;
      owner: string;
      delegatee: string;
      earningPower: bigint;
      claimer: string;
    } | null>
  > {
    const calls = depositIds.map((depositId) => ({
      contract,
      method: 'deposits',
      params: [depositId],
      resultDecoder: (data: string) => {
        try {
          const decoded = contract.interface.decodeFunctionResult(
            'deposits',
            data,
          );
          return {
            balance: BigInt(decoded[0].toString()),
            owner: decoded[1],
            delegatee: decoded[2],
            earningPower: BigInt(decoded[3].toString()),
            claimer: decoded[4],
          };
        } catch (error) {
          this.logger.warn('Failed to decode deposits result', {
            depositId: depositId.toString(),
            data,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },
    }));

    return this.batchCalls(calls);
  }

  /**
   * Executes promises with rate limiting to avoid overwhelming the RPC provider
   * @param promises Array of promises to execute
   * @returns Array of results
   */
  private async executeWithRateLimit<T>(
    promises: Promise<T>[]
  ): Promise<T[]> {
    const results: T[] = [];
    
    // Process in batches to avoid overwhelming the RPC provider
    for (let i = 0; i < promises.length; i += this.maxConcurrentCalls) {
      const batch = promises.slice(i, i + this.maxConcurrentCalls);
      
      try {
        const batchResults = await Promise.all(batch);
        results.push(...batchResults);
        
        // Add delay between batches if there are more to process
        if (i + this.maxConcurrentCalls < promises.length) {
          await new Promise(resolve => setTimeout(resolve, this.delayBetweenBatches));
        }
      } catch (error) {
        this.logger.warn('Batch execution failed, retrying with exponential backoff', {
          batchStart: i,
          batchSize: batch.length,
          error: error instanceof Error ? error.message : String(error)
        });
        
        // Retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, this.delayBetweenBatches * 2));
        const batchResults = await Promise.all(batch);
        results.push(...batchResults);
      }
    }
    
    return results;
  }
}
