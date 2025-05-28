import { Logger } from '@/monitor/logging';
import { QueuedTransaction } from '@/executor/interfaces/types';
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
  // Validate and potentially use fallback address
  let finalSignerAddress = signerAddress;
  if (!isValidAddress(signerAddress)) {
    // Use the executor address from config as fallback
    const fallbackAddress = CONFIG.executor.tipReceiver;
    if (isValidAddress(fallbackAddress)) {
      logger.info('Using fallback executor address for simulation', {
        originalAddress: signerAddress,
        fallbackAddress,
        txId: tx.id,
      });
      finalSignerAddress = fallbackAddress;
    } else {
      const error = `Invalid signer address and no valid fallback available: ${signerAddress}`;
      logger.error('Simulation validation failed', {
        error,
        txId: tx.id,
        signerAddress,
        fallbackAddress,
      });
      return { success: false, gasEstimate: null, error };
    }
  }

  if (!isValidAddress(lstContract.target.toString())) {
    const error = `Invalid contract address: ${lstContract.target.toString()}`;
    logger.error('Simulation validation failed', {
      error,
      txId: tx.id,
      contractAddress: lstContract.target.toString(),
    });
    return { success: false, gasEstimate: null, error };
  }

  if (!simulationService) {
    logger.warn('Simulation service not available, skipping simulation', {
      txId: tx.id,
    });
    return { success: true, gasEstimate: null };
  }

  try {
    // Get current gas price for realistic cost calculations
    let realGasPrice: bigint = BigInt(0);
    let simulationGasPrice: string;
    
    try {
      const provider = lstContract.runner?.provider as ethers.Provider;
      if (provider) {
        const feeData = await provider.getFeeData();
        realGasPrice = feeData.gasPrice || BigInt(0);
        
        // For simulation: Apply minimum threshold for Tenderly stability
        const MIN_SIMULATION_GAS_PRICE = ethers.parseUnits('1', 'gwei');
        let adjustedGasPrice = realGasPrice;
        
        if (realGasPrice < MIN_SIMULATION_GAS_PRICE) {
          adjustedGasPrice = MIN_SIMULATION_GAS_PRICE;
          logger.info('Using minimum gas price for simulation stability', {
            realGasPriceGwei: Number(realGasPrice) / 1e9,
            simulationGasPriceGwei: Number(adjustedGasPrice) / 1e9,
            reason: 'sub-1-gwei protection for Tenderly',
          });
        }
        
        simulationGasPrice = adjustedGasPrice.toString();
        logger.debug('Gas price setup for simulation', {
          realGasPriceGwei: Number(realGasPrice) / 1e9,
          simulationGasPriceGwei: Number(adjustedGasPrice) / 1e9,
          isAdjusted: realGasPrice !== adjustedGasPrice,
        });
      } else {
        simulationGasPrice = ethers.parseUnits('20', 'gwei').toString();
        realGasPrice = ethers.parseUnits('20', 'gwei');
        logger.warn('No provider available, using fallback gas price');
      }
    } catch (error) {
      simulationGasPrice = ethers.parseUnits('20', 'gwei').toString();
      realGasPrice = ethers.parseUnits('20', 'gwei');
      logger.warn('Failed to get current gas price, using fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Get the contract data for the transaction
    const data = lstContract.interface.encodeFunctionData(
      'claimAndDistributeReward',
      [finalSignerAddress, minExpectedReward, depositIds],
    );

    const contractAddress = lstContract.target.toString();

    // Ensure minimum gas limit for simulation to avoid failures with very low estimates
    const MIN_SIMULATION_GAS = 2000000; // 2m gas minimum for complex operations
    const simulationGasLimit = Number(gasLimit) < MIN_SIMULATION_GAS 
      ? MIN_SIMULATION_GAS 
      : Number(gasLimit);

    // Add debug logging
    logger.debug('Preparing simulation transaction', {
      txId: tx.id,
      signerAddress,
      contractAddress,
      minExpectedReward: minExpectedReward.toString(),
      depositCount: depositIds.length,
      originalGasLimit: Number(gasLimit),
      adjustedGasLimit: simulationGasLimit,
      gasPriceGwei: Number(simulationGasPrice) / 1e9,
    });

    // Create simulation transaction object
    const simulationTx: SimulationTransaction = {
      from: finalSignerAddress,
      to: contractAddress,
      data,
      gas: simulationGasLimit,
      gasPrice: simulationGasPrice, // Use current network gas price
      value: '0',
    };

    logger.info('Simulating transaction', {
      txId: tx.id,
      depositIds: depositIds.map(String),
      minExpectedReward: minExpectedReward.toString(),
      recipient: finalSignerAddress,
      gasLimit: simulationGasLimit.toString(),
      gasPriceGwei: Number(simulationGasPrice) / 1e9,
    });

    // First try to get gas estimation (faster)
    let gasEstimate: bigint | null = null;
    try {
      const gasEstimation = await simulationService.estimateGasCosts(
        simulationTx,
        {
          networkId: CONFIG.tenderly.networkId || '1',
        },
      );

      gasEstimate = BigInt(Math.ceil(gasEstimation.gasUnits * 1.3)); // Add 30% buffer
      logger.info('Transaction gas estimation successful', {
        txId: tx.id,
        estimatedGas: gasEstimation.gasUnits,
        bufferedGas: gasEstimate.toString(),
        usedGasPriceGwei: Number(simulationGasPrice) / 1e9,
      });
    } catch (estimateError) {
      logger.warn(
        'Failed to estimate gas via simulation, will fall back to full simulation',
        {
          error:
            estimateError instanceof Error
              ? estimateError.message
              : String(estimateError),
          txId: tx.id,
        },
      );
    }

    // Then run full simulation to check for other issues
    const simulationResult = await simulationService.simulateTransaction(
      simulationTx,
      {
        networkId: CONFIG.tenderly.networkId || '1',
      },
    );

    // If simulation fails but the error is gas-related, try again with higher gas
    if (
      !simulationResult.success &&
      simulationResult.error?.code === 'GAS_LIMIT_EXCEEDED' &&
      simulationResult.gasUsed > 0
    ) {
      const newGasLimit = Math.max(
        Math.ceil(simulationResult.gasUsed * 1.52), // 50% buffer
        MIN_SIMULATION_GAS // Ensure minimum
      );

      const retrySimulationTx = {
        ...simulationTx,
        gas: newGasLimit,
      };

      logger.info('Retrying simulation with higher gas limit', {
        txId: tx.id,
        originalGasLimit: simulationGasLimit,
        newGasLimit: newGasLimit,
        gasUsedInFirstAttempt: simulationResult.gasUsed,
      });

      const retryResult = await simulationService.simulateTransaction(
        retrySimulationTx,
        {
          networkId: CONFIG.tenderly.networkId || '1',
        },
      );

      if (retryResult.success) {
        logger.info('Transaction simulation succeeded with higher gas limit', {
          txId: tx.id,
          gasUsed: retryResult.gasUsed,
          optimizedGasLimit: newGasLimit.toString(),
        });

        return {
          success: true,
          gasEstimate:
            gasEstimate || BigInt(Math.ceil(retryResult.gasUsed * 1.2)),
          optimizedGasLimit: BigInt(newGasLimit),
        };
      }
    }

    if (!simulationResult.success) {
      logger.warn('Transaction simulation failed', {
        txId: tx.id,
        errorCode: simulationResult.error?.code,
        errorMessage: simulationResult.error?.message,
        errorDetails: simulationResult.error?.details,
        gasUsed: simulationResult.gasUsed || 0,
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
    // Enhance error logging
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error('Transaction simulation preparation failed', {
      error: errorMessage,
      stack: errorStack,
      txId: tx.id,
      signerAddress,
      contractAddress: lstContract.target.toString(),
      depositCount: depositIds.length,
    });

    return {
      success: false,
      gasEstimate: null,
      error: errorMessage,
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
  // Validate and potentially use fallback address
  let finalRecipient = recipient;
  if (!isValidAddress(recipient)) {
    // Use the executor address from config as fallback
    const fallbackAddress = CONFIG.executor.tipReceiver;
    if (isValidAddress(fallbackAddress)) {
      logger.info('Using fallback executor address for gas estimation', {
        originalAddress: recipient,
        fallbackAddress,
        depositCount: depositIds.length,
      });
      finalRecipient = fallbackAddress;
    } else {
      logger.error(
        'Gas estimation failed - invalid recipient address and no valid fallback',
        {
          recipient,
          fallbackAddress,
          depositCount: depositIds.length,
        },
      );
      return null;
    }
  }

  if (!isValidAddress(lstContract.target.toString())) {
    logger.error('Gas estimation failed - invalid contract address', {
      contractAddress: lstContract.target.toString(),
      depositCount: depositIds.length,
    });
    return null;
  }

  if (!simulationService) {
    return null;
  }

  try {
    // Get current gas price for realistic cost calculations
    let realGasPrice: bigint = BigInt(0);
    let simulationGasPrice: string;
    
    try {
      const provider = lstContract.runner?.provider as ethers.Provider;
      if (provider) {
        const feeData = await provider.getFeeData();
        realGasPrice = feeData.gasPrice || BigInt(0);
        
        // For simulation: Apply minimum threshold for Tenderly stability
        const MIN_SIMULATION_GAS_PRICE = ethers.parseUnits('1', 'gwei');
        let adjustedGasPrice = realGasPrice;
        
        if (realGasPrice < MIN_SIMULATION_GAS_PRICE) {
          adjustedGasPrice = MIN_SIMULATION_GAS_PRICE;
          logger.info('Using minimum gas price for simulation stability', {
            realGasPriceGwei: Number(realGasPrice) / 1e9,
            simulationGasPriceGwei: Number(adjustedGasPrice) / 1e9,
            reason: 'sub-1-gwei protection for Tenderly',
          });
        }
        
        simulationGasPrice = adjustedGasPrice.toString();
        logger.debug('Gas price setup for simulation', {
          realGasPriceGwei: Number(realGasPrice) / 1e9,
          simulationGasPriceGwei: Number(adjustedGasPrice) / 1e9,
          isAdjusted: realGasPrice !== adjustedGasPrice,
        });
      } else {
        simulationGasPrice = ethers.parseUnits('20', 'gwei').toString();
        realGasPrice = ethers.parseUnits('20', 'gwei');
        logger.warn('No provider available, using fallback gas price');
      }
    } catch (error) {
      simulationGasPrice = ethers.parseUnits('20', 'gwei').toString();
      realGasPrice = ethers.parseUnits('20', 'gwei');
      logger.warn('Failed to get current gas price, using fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Add debug logging
    logger.debug('Preparing gas estimation', {
      recipient,
      contractAddress: lstContract.target.toString(),
      reward: reward.toString(),
      depositCount: depositIds.length,
      gasPriceGwei: Number(simulationGasPrice) / 1e9,
    });

    // Encode transaction data
    const data = lstContract.interface.encodeFunctionData(
      'claimAndDistributeReward',
      [finalRecipient, reward, depositIds],
    );

    // Use a high gas limit for estimation but ensure it's reasonable
    const MIN_ESTIMATION_GAS = 1000000; // 1M gas minimum for gas estimation
    const MAX_ESTIMATION_GAS = 10000000; // 10M gas maximum to avoid excessive costs
    const estimationGasLimit = Math.min(MAX_ESTIMATION_GAS, Math.max(MIN_ESTIMATION_GAS, 5000000));

    // Create simulation transaction with a high gas limit to ensure it doesn't fail due to gas
    const simulationTx: SimulationTransaction = {
      from: finalRecipient,
      to: lstContract.target.toString(),
      data,
      gas: estimationGasLimit,
      gasPrice: simulationGasPrice, // Use current network gas price
      value: '0',
    };

    logger.debug('Gas estimation transaction details', {
      from: finalRecipient,
      to: lstContract.target.toString(),
      gasLimit: estimationGasLimit,
      depositCount: depositIds.length,
    });

    // Get gas estimation
    const gasEstimation = await simulationService.estimateGasCosts(
      simulationTx,
      {
        networkId: CONFIG.tenderly.networkId || '1',
      },
    );

    // Add 30% buffer to the estimate but ensure it's reasonable
    const bufferedEstimate = Math.ceil(gasEstimation.gasUnits * 1.3);
    const gasEstimate = BigInt(Math.max(bufferedEstimate, 300000)); // Minimum 300k gas

    logger.info('Estimated gas using simulation', {
      depositCount: depositIds.length,
      rawEstimate: gasEstimation.gasUnits,
      bufferedEstimate: bufferedEstimate,
      finalEstimate: gasEstimate.toString(),
      recipient: finalRecipient,
      contractAddress: lstContract.target.toString(),
    });

    return gasEstimate;
  } catch (error) {
    // Enhance error logging
    logger.error('Gas estimation simulation failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      depositCount: depositIds.length,
      recipient: finalRecipient,
      contractAddress: lstContract.target.toString(),
      reward: reward.toString(),
    });
    return null;
  }
}

// Add this helper at the top after imports
function isValidAddress(address: string): boolean {
  try {
    return ethers.isAddress(address) && address !== ethers.ZeroAddress;
  } catch {
    return false;
  }
}
