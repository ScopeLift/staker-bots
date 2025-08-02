import { ethers } from 'ethers';
import { Logger } from '@/monitor/logging';

/**
 * Utility class for batch contract calls using multicall pattern
 */
export class MulticallBatcher {
  private readonly provider: ethers.Provider;
  private readonly logger: Logger;

  constructor(provider: ethers.Provider, logger: Logger) {
    this.provider = provider;
    this.logger = logger;
  }

  /**
   * Batches multiple contract calls into a single RPC request using eth_call
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

    try {
      // Group calls by contract for efficiency
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
          this.logger.warn('Individual call failed in batch', {
            method: call.method,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      });

      // Execute all calls in parallel
      const results = await Promise.all(callPromises);

      this.logger.info('Batch call completed', {
        totalCalls: calls.length,
        successfulCalls: results.filter((r) => r !== null).length,
        failedCalls: results.filter((r) => r === null).length,
      });

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
}
