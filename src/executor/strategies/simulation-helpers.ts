import { Logger } from '@/monitor/logging';
import { QueuedTransaction } from '../interfaces/types';
import { SimulationService } from '@/simulation';
import { SimulationTransaction } from '@/simulation/interfaces';
import { ethers } from 'ethers';
import { CONFIG } from '@/configuration';

/**
 * Simulates a transaction to verify it will succeed and estimate gas costs
 * This uses Tenderly simulation API to validate the transaction without submitting to the chain
 *
 * @param tx The transaction to simulate
 * @param depositIds List of deposit IDs
 * @param signerAddress The address that will sign the transaction
 * @param minExpectedReward Minimum expected reward
 * @param gasLimit Initial gas limit to use for simulation
 * @param lstContract Contract instance
 * @param simulationService Simulation service instance
 * @param logger Logger instance
 * @returns Object containing simulation results and gas parameters
 */
export async function simulateTransaction(
  tx: QueuedTransaction,
  depositIds: bigint[],
  signerAddress: string,
  minExpectedReward: bigint,
  gasLimit: bigint,
  lstContract: ethers.Contract,
  simulationService: SimulationService | null,
  logger: Logger,
): Promise<{
  success: boolean;
  gasEstimate: bigint | null;
  error?: string;
  optimizedGasLimit?: bigint;
}> {
  if (!simulationService) {
    logger.warn('Simulation service not available, skipping simulation', {
      txId: tx.id,
    });
    return { success: true, gasEstimate: null }; // Default to success if service not available
  }

  try {
    // Get the contract data for the transaction
    const data = lstContract.interface.encodeFunctionData('claimAndDistributeReward', [
      signerAddress,
      minExpectedReward,
      depositIds,
    ]);

    const contractAddress = lstContract.target.toString();

    // Create simulation transaction object
    const simulationTx: SimulationTransaction = {
      from: signerAddress,
      to: contractAddress,
      data,
      gas: Number(gasLimit),
      value: '0',
    };

    logger.info('Simulating transaction', {
      txId: tx.id,
      depositIds: depositIds.map(String),
      minExpectedReward: minExpectedReward.toString(),
      recipient: signerAddress,
      gasLimit: gasLimit.toString(),
    });

    // First try to get gas estimation (faster)
    let gasEstimate: bigint | null = null;
    try {
      const gasEstimation = await simulationService.estimateGasCosts(simulationTx, {
        networkId: CONFIG.tenderly.networkId || '1',
      });

      gasEstimate = BigInt(Math.ceil(gasEstimation.gasUnits * 1.3)); // Add 30% buffer
      logger.info('Transaction gas estimation successful', {
        txId: tx.id,
        estimatedGas: gasEstimation.gasUnits,
        bufferedGas: gasEstimate.toString(),
      });
    } catch (estimateError) {
      logger.warn('Failed to estimate gas via simulation, will fall back to simulation', {
        error: estimateError instanceof Error ? estimateError.message : String(estimateError),
        txId: tx.id,
      });
    }

    // Then run full simulation to check for other issues
    const simulationResult = await simulationService.simulateTransaction(simulationTx, {
      networkId: CONFIG.tenderly.networkId || '1',
    });

    // If simulation fails but the error is gas-related, try again with higher gas
    if (
      !simulationResult.success &&
      simulationResult.error?.code === 'GAS_LIMIT_EXCEEDED' &&
      simulationResult.gasUsed > 0
    ) {
      const newGasLimit = BigInt(Math.ceil(simulationResult.gasUsed * 1.5)); // 50% buffer

      const retrySimulationTx = {
        ...simulationTx,
        gas: Number(newGasLimit),
      };

      logger.info('Retrying simulation with higher gas limit', {
        txId: tx.id,
        originalGasLimit: gasLimit.toString(),
        newGasLimit: newGasLimit.toString(),
      });

      const retryResult = await simulationService.simulateTransaction(retrySimulationTx, {
        networkId: CONFIG.tenderly.networkId || '1',
      });

      if (retryResult.success) {
        logger.info('Transaction simulation succeeded with higher gas limit', {
          txId: tx.id,
          gasUsed: retryResult.gasUsed,
          optimizedGasLimit: newGasLimit.toString(),
        });

        return {
          success: true,
          gasEstimate: gasEstimate || BigInt(Math.ceil(retryResult.gasUsed * 1.2)),
          optimizedGasLimit: newGasLimit,
        };
      }
    }

    if (!simulationResult.success) {
      logger.warn('Transaction simulation failed', {
        txId: tx.id,
        errorCode: simulationResult.error?.code,
        errorMessage: simulationResult.error?.message,
        errorDetails: simulationResult.error?.details,
      });

      return {
        success: false,
        gasEstimate: null,
        error: `${simulationResult.error?.code}: ${simulationResult.error?.message}`,
      };
    }

    // Use gas from simulation if it's higher than our estimate (plus buffer)
    if (simulationResult.gasUsed > 0) {
      const simulationGas = BigInt(Math.ceil(simulationResult.gasUsed * 1.2)); // 20% buffer
      if (!gasEstimate || simulationGas > gasEstimate) {
        gasEstimate = simulationGas;
      }
    }

    logger.info('Transaction simulation successful', {
      txId: tx.id,
      gasUsed: simulationResult.gasUsed,
      estimatedGas: gasEstimate?.toString(),
      simulationStatus: simulationResult.status,
    });

    return {
      success: true,
      gasEstimate,
    };
  } catch (error) {
    logger.error('Transaction simulation error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      txId: tx.id,
    });

    // Return success true with null gasEstimate to allow fallback to normal gas estimation
    return {
      success: true,
      gasEstimate: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Estimates gas for a transaction using simulation
 * This is a lighter-weight method that only calls the gas estimation part of the simulation
 *
 * @param depositIds List of deposit IDs
 * @param recipient The recipient address
 * @param reward The expected reward amount
 * @param lstContract Contract instance
 * @param simulationService Simulation service instance
 * @param logger Logger instance
 * @returns Estimated gas or null if simulation fails
 */
export async function estimateGasUsingSimulation(
  depositIds: bigint[],
  recipient: string,
  reward: bigint,
  lstContract: ethers.Contract,
  simulationService: SimulationService | null,
  logger: Logger,
): Promise<bigint | null> {
  if (!simulationService) {
    return null; // Simulation service not available
  }

  try {
    // Encode transaction data
    const data = lstContract.interface.encodeFunctionData('claimAndDistributeReward', [
      recipient,
      reward,
      depositIds,
    ]);

    // Create simulation transaction with a high gas limit to ensure it doesn't fail due to gas
    const simulationTx: SimulationTransaction = {
      from: recipient,
      to: lstContract.target.toString(),
      data,
      gas: 5000000, // 10M gas as a high limit for estimation
      value: '0',
    };

    // Get gas estimation
    const gasEstimation = await simulationService.estimateGasCosts(simulationTx, {
      networkId: CONFIG.tenderly.networkId || '1',
    });

    // Add 30% buffer to the estimate
    const gasEstimate = BigInt(Math.ceil(gasEstimation.gasUnits * 1.3));

    logger.info('Estimated gas using simulation', {
      depositCount: depositIds.length,
      rawEstimate: gasEstimation.gasUnits,
      bufferedEstimate: gasEstimate.toString(),
    });

    return gasEstimate;
  } catch (error) {
    logger.warn('Failed to estimate gas using simulation', {
      error: error instanceof Error ? error.message : String(error),
      depositCount: depositIds.length,
    });
    return null;
  }
} 