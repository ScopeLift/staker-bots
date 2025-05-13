import { CONFIG } from '@/configuration/constants';
import type {
  SimulationTransaction,
  SimulationOptions,
  SimulationResult,
  SimulationError,
  GasCostEstimate,
} from './interfaces';
import { TenderlyConfigError } from '@/configuration/errors';

export class SimulationService {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor() {
    if (
      !CONFIG.tenderly.accessKey ||
      !CONFIG.tenderly.accountName ||
      !CONFIG.tenderly.projectName
    ) {
      throw new TenderlyConfigError('Missing required Tenderly configuration');
    }

    // Verify API key format
    if (!CONFIG.tenderly.accessKey.match(/^[a-zA-Z0-9]{32}$/)) {
      throw new TenderlyConfigError(
        'Invalid Tenderly access key format - should be 32 alphanumeric characters',
      );
    }

    // Initialize Tenderly API configuration
    this.baseUrl = `https://api.tenderly.co/api/v1/account/${CONFIG.tenderly.accountName}/project/${CONFIG.tenderly.projectName}/simulate`;
    this.headers = {
      'Content-Type': 'application/json',
      'X-Access-Key': CONFIG.tenderly.accessKey,
    };
  }

  private parseSimulationError(error: unknown): SimulationError {
    if (error instanceof Error) {
      // Check for common simulation errors
      if (error.message.includes('insufficient funds')) {
        return {
          code: 'INSUFFICIENT_FUNDS',
          message: 'Account has insufficient funds for transaction',
          details: error.message,
        };
      } else if (error.message.includes('execution reverted')) {
        return {
          code: 'EXECUTION_REVERTED',
          message: 'Transaction execution reverted',
          details: error.message,
        };
      } else if (error.message.includes('gas required exceeds allowance')) {
        return {
          code: 'GAS_LIMIT_EXCEEDED',
          message: 'Transaction requires more gas than provided',
          details: error.message,
        };
      }
      return {
        code: 'UNKNOWN_ERROR',
        message: error.message,
        details: error.stack,
      };
    }
    return {
      code: 'UNKNOWN_ERROR',
      message: 'Unknown simulation error',
      details: String(error),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapSimulationOutput(simulation: any): SimulationResult {
    if (!simulation || simulation.error) {
      return {
        success: false,
        gasUsed: 0,
        error: {
          code: 'SIMULATION_FAILED',
          message: 'Transaction simulation failed',
          details: simulation?.error || 'Unknown failure reason',
        },
      };
    }

    const gasUsed = parseInt(simulation.transaction?.gas_used || '0', 10);

    return {
      success: true,
      gasUsed,
      trace: simulation.transaction?.transaction_info && {
        gas: parseInt(simulation.transaction.gas || '0', 10),
        failed: !simulation.transaction.status,
        error: simulation.transaction.error_message,
        returnValue: simulation.transaction.transaction_info.output,
        type: simulation.transaction.transaction_info.call_trace?.type,
        from: simulation.transaction.from,
        to: simulation.transaction.to,
        gasUsed: parseInt(simulation.transaction.gas_used || '0', 10),
        address: simulation.transaction.transaction_info.call_trace?.address,
        balance: simulation.transaction.transaction_info.call_trace?.balance,
        value: simulation.transaction.value,
        errorReason: simulation.transaction.error_message,
        input: simulation.transaction.input,
        output: simulation.transaction.transaction_info.output,
        method: simulation.transaction.transaction_info.call_trace?.method,
        subtraces:
          simulation.transaction.transaction_info.call_trace?.subtraces,
        traceAddress:
          simulation.transaction.transaction_info.call_trace?.trace_address,
      },
      logs: simulation.transaction?.transaction_info?.logs?.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (log: any) => ({
          name: log.name,
          anonymous: log.anonymous,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          inputs: log.inputs?.map((input: any) => ({
            value: input.value,
            type: input.type,
            name: input.name,
          })),
          raw: {
            address: log.raw.address,
            topics: log.raw.topics,
            data: log.raw.data,
          },
        }),
      ),
      returnValue: simulation.transaction?.transaction_info?.output,
      status: simulation.transaction?.status,
      blockNumber: simulation.block_number,
      type: simulation.transaction?.type,
    };
  }

  async simulateTransaction(
    transaction: SimulationTransaction,
    options: SimulationOptions = {},
  ): Promise<SimulationResult> {
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          network_id: options.networkId || '42161', // Default to Arbitrum One
          from: transaction.from,
          to: transaction.to,
          input: transaction.data || '0x',
          gas: transaction.gas,
          gas_price: transaction.gasPrice || '0',
          value: transaction.value || '0',
          save: options.save || false,
          save_if_fails: options.saveIfFails || false,
          simulation_type: 'full', // Request full simulation with logs
          generate_access_list: true, // This can help with gas optimization
          block_number: options.blockNumber || null,
          state_objects: options.overrides
            ? Object.entries(options.overrides).reduce(
                (acc, [address, override]) => ({
                  ...acc,
                  [address]: {
                    balance: override.balance,
                    nonce: override.nonce,
                    code: override.code,
                    state: override.state,
                    state_diff: override.stateDiff,
                  },
                }),
                {},
              )
            : undefined,
        }),
      });

      if (!response.ok) {
        throw new Error(`Simulation request failed: ${await response.text()}`);
      }

      const simulation = await response.json();
      return this.mapSimulationOutput(simulation);
    } catch (error) {
      const simulationError = this.parseSimulationError(error);
      return {
        success: false,
        gasUsed: 0,
        error: simulationError,
      };
    }
  }

  async estimateGasCosts(
    transaction: SimulationTransaction,
    options: SimulationOptions = {},
  ): Promise<GasCostEstimate> {
    try {
      const response = await fetch(
        this.baseUrl.replace('/simulate', '/gas-estimation'),
        {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({
            network_id: options.networkId || '42161', // Default to Arbitrum One
            from: transaction.from,
            to: transaction.to,
            input: transaction.data || '0x',
            gas: transaction.gas,
            value: transaction.value || '0',
          }),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Gas estimation request failed: ${await response.text()}`,
        );
      }

      const estimation = await response.json();
      return {
        gasUnits: parseInt(estimation.gas_used || estimation.gas || '0', 10),
        gasPrice: estimation.gas_price || '0',
        gasPriceDetails: estimation.gas_price_info && {
          baseFeePerGas: estimation.gas_price_info.base_fee_per_gas,
          low: {
            maxPriorityFeePerGas:
              estimation.gas_price_info.low.max_priority_fee_per_gas,
            maxFeePerGas: estimation.gas_price_info.low.max_fee_per_gas,
            waitTime: estimation.gas_price_info.low.wait_time_secs,
          },
          medium: {
            maxPriorityFeePerGas:
              estimation.gas_price_info.medium.max_priority_fee_per_gas,
            maxFeePerGas: estimation.gas_price_info.medium.max_fee_per_gas,
            waitTime: estimation.gas_price_info.medium.wait_time_secs,
          },
          high: {
            maxPriorityFeePerGas:
              estimation.gas_price_info.high.max_priority_fee_per_gas,
            maxFeePerGas: estimation.gas_price_info.high.max_fee_per_gas,
            waitTime: estimation.gas_price_info.high.wait_time_secs,
          },
        },
        timestamp: Date.now(),
      };
    } catch (error) {
      throw new Error(
        `Failed to estimate gas costs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
