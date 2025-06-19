import { ethers } from 'ethers';
import { Logger } from '@/monitor/logging';

/**
 * Result of a transaction simulation
 */
export interface SimulationResult<T = unknown> {
  success: boolean;
  result?: T;
  error?: string;
}

/**
 * Result of gas estimation
 */
export interface GasEstimateResult {
  gasLimit: bigint;
  gasPrice: bigint;
}

/**
 * Utility class for simulating transactions and estimating gas
 */
export class TransactionSimulator {
  private readonly logger: Logger;
  private readonly provider: ethers.Provider;
  private readonly gasBoostPercentage: number;
  private readonly gasLimitBufferPercentage: number;

  /**
   * Creates a new TransactionSimulator instance
   * @param provider Ethereum provider
   * @param logger Logger instance
   * @param options Configuration options
   */
  constructor(
    provider: ethers.Provider,
    logger: Logger,
    options: {
      gasBoostPercentage?: number;
      gasLimitBufferPercentage?: number;
    } = {},
  ) {
    this.provider = provider;
    this.logger = logger;
    this.gasBoostPercentage = options.gasBoostPercentage || 10; // Default 10% boost
    this.gasLimitBufferPercentage = options.gasLimitBufferPercentage || 20; // Default 20% buffer
  }

  /**
   * Simulates a contract function call to check if it will succeed
   * @param contract The contract instance
   * @param functionName The function name to call
   * @param args Arguments to pass to the function
   * @param options Additional options including call overrides
   * @returns Simulation result with success status and result or error
   */
  async simulateContractFunction<T = unknown>(
    contract: ethers.Contract,
    functionName: string,
    args: unknown[],
    options: {
      callOverrides?: ethers.Overrides;
      context?: string;
    } = {},
  ): Promise<SimulationResult<T>> {
    try {
      this.logger.info(`Simulating function call: ${functionName}`, {
        args: args.map((arg) =>
          typeof arg === 'bigint' ? arg.toString() : arg,
        ),
        contract: contract.target,
        context: options.context,
      });

      // Get the function reference
      const contractFunction = contract.getFunction(functionName);
      if (!contractFunction) {
        throw new Error(`Function ${functionName} not found on contract`);
      }

      // Simulate the call
      const result = await contractFunction.staticCall(
        ...args,
        options.callOverrides || {},
      );

      this.logger.info(`Simulation successful: ${functionName}`, {
        result: typeof result === 'bigint' ? result.toString() : result,
        context: options.context,
      });

      return { success: true, result: result as T };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger.error(`Simulation failed: ${functionName}`, {
        error: errorMessage,
        context: options.context,
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Estimates gas for a contract function call
   * @param contract The contract instance
   * @param functionName The function name to call
   * @param args Arguments to pass to the function
   * @param options Additional options including call overrides and fallback gas limit
   * @returns Gas estimate result with gasLimit and gasPrice
   */
  async estimateGasParameters(
    contract: ethers.Contract,
    functionName: string,
    args: unknown[],
    options: {
      callOverrides?: ethers.Overrides;
      fallbackGasLimit?: bigint;
      context?: string;
    } = {},
  ): Promise<GasEstimateResult> {
    // Get current gas price from provider with boost
    const feeData = await this.provider.getFeeData();
    const baseGasPrice = feeData.gasPrice || BigInt(0);
    const boostMultiplier = BigInt(100 + this.gasBoostPercentage) / BigInt(100);
    let gasPrice = baseGasPrice * boostMultiplier;

    // Ensure gas price is at least the base fee
    const baseFeePerGas = feeData.maxFeePerGas || baseGasPrice;
    if (gasPrice < baseFeePerGas) {
      gasPrice = baseFeePerGas + BigInt(1_000_000); // Add 1 gwei buffer
    }

    // Estimate gas limit
    let gasLimit: bigint;
    try {
      // Get the function reference
      const contractFunction = contract.getFunction(functionName);
      if (!contractFunction) {
        throw new Error(`Function ${functionName} not found on contract`);
      }

      // Estimate gas
      gasLimit = await contractFunction.estimateGas(
        ...args,
        options.callOverrides || {},
      );

      // Add buffer for safety
      const bufferMultiplier =
        BigInt(100 + this.gasLimitBufferPercentage) / BigInt(100);
      gasLimit = gasLimit * bufferMultiplier;

      this.logger.info(`Gas estimation successful: ${functionName}`, {
        rawGasLimit: gasLimit.toString(),
        bufferedGasLimit: gasLimit.toString(),
        gasPrice: gasPrice.toString(),
        context: options.context,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger.error(`Gas estimation failed: ${functionName}`, {
        error: errorMessage,
        context: options.context,
      });

      // Use fallback gas limit
      gasLimit = options.fallbackGasLimit || BigInt(300000);

      this.logger.warn(`Using fallback gas limit: ${gasLimit.toString()}`, {
        context: options.context,
      });
    }

    return { gasLimit, gasPrice };
  }

  /**
   * Utility method to combine simulation and gas estimation
   * @param contract The contract instance
   * @param functionName The function name to call
   * @param args Arguments to pass to the function
   * @param options Additional options
   * @returns Combined result with simulation and gas estimate
   */
  async simulateAndEstimateGas<T = unknown>(
    contract: ethers.Contract,
    functionName: string,
    args: unknown[],
    options: {
      callOverrides?: ethers.Overrides;
      fallbackGasLimit?: bigint;
      context?: string;
    } = {},
  ): Promise<{
    simulation: SimulationResult<T>;
    gasEstimate: GasEstimateResult | null;
  }> {
    // First simulate to ensure transaction will succeed
    const simulation = await this.simulateContractFunction<T>(
      contract,
      functionName,
      args,
      options,
    );

    // Only estimate gas if simulation succeeded
    let gasEstimate: GasEstimateResult | null = null;
    if (simulation.success) {
      gasEstimate = await this.estimateGasParameters(
        contract,
        functionName,
        args,
        options,
      );
    }

    return { simulation, gasEstimate };
  }
}
