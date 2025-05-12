import { ethers } from 'ethers'
import { CONFIG } from '../configuration'
import type { SimulationTransaction, SimulationOptions, SimulationResult, SimulationError, GasCostEstimate } from './interfaces'

export class SimulationService {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>

  constructor() {
    if (!CONFIG.tenderly.accessKey || !CONFIG.tenderly.accountName || !CONFIG.tenderly.projectName) {
      throw new Error('Missing required Tenderly configuration')
    }

    // Verify API key format
    if (!CONFIG.tenderly.accessKey.match(/^[a-zA-Z0-9]{32}$/)) {
      throw new Error('Invalid Tenderly access key format - should be 32 alphanumeric characters')
    }

    console.log('Initializing Tenderly with config:', {
      accountName: CONFIG.tenderly.accountName,
      projectName: CONFIG.tenderly.projectName,
      accessKeyLength: CONFIG.tenderly.accessKey.length,
      accessKeyPrefix: CONFIG.tenderly.accessKey.substring(0, 4) + '...',
      accessKeyFormat: CONFIG.tenderly.accessKey.match(/^[a-zA-Z0-9]{32}$/) ? 'valid' : 'invalid'
    })

    // Initialize Tenderly API configuration
    this.baseUrl = `https://api.tenderly.co/api/v1/account/${CONFIG.tenderly.accountName}/project/${CONFIG.tenderly.projectName}/simulate`
    this.headers = {
      'Content-Type': 'application/json',
      'X-Access-Key': CONFIG.tenderly.accessKey
    }
  }

  private parseSimulationError(error: unknown): SimulationError {
    if (error instanceof Error) {
      // Check for common simulation errors
      if (error.message.includes('insufficient funds')) {
        return {
          code: 'INSUFFICIENT_FUNDS',
          message: 'Account has insufficient funds for transaction',
          details: error.message
        }
      } else if (error.message.includes('execution reverted')) {
        return {
          code: 'EXECUTION_REVERTED',
          message: 'Transaction execution reverted',
          details: error.message
        }
      } else if (error.message.includes('gas required exceeds allowance')) {
        return {
          code: 'GAS_LIMIT_EXCEEDED',
          message: 'Transaction requires more gas than provided',
          details: error.message
        }
      }
      return {
        code: 'UNKNOWN_ERROR',
        message: error.message,
        details: error.stack
      }
    }
    return {
      code: 'UNKNOWN_ERROR',
      message: 'Unknown simulation error',
      details: String(error)
    }
  }

  private mapSimulationOutput(simulation: any): SimulationResult {
    if (!simulation || simulation.error) {
      return {
        success: false,
        gasUsed: 0,
        error: {
          code: 'SIMULATION_FAILED',
          message: 'Transaction simulation failed',
          details: simulation?.error || 'Unknown failure reason'
        }
      }
    }

    const gasUsed = parseInt(simulation.transaction?.gas_used || '0', 10)

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
        subtraces: simulation.transaction.transaction_info.call_trace?.subtraces,
        traceAddress: simulation.transaction.transaction_info.call_trace?.trace_address
      },
      logs: simulation.transaction?.transaction_info?.logs?.map((log: any) => ({
        name: log.name,
        anonymous: log.anonymous,
        inputs: log.inputs?.map((input: any) => ({
          value: input.value,
          type: input.type,
          name: input.name
        })),
        raw: {
          address: log.raw.address,
          topics: log.raw.topics,
          data: log.raw.data
        }
      })),
      returnValue: simulation.transaction?.transaction_info?.output,
      status: simulation.transaction?.status,
      blockNumber: simulation.block_number,
      type: simulation.transaction?.type
    }
  }

  async simulateTransaction(
    transaction: SimulationTransaction,
    options: SimulationOptions = {}
  ): Promise<SimulationResult> {
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          network_id: options.networkId || '1', // Default to mainnet
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
          state_objects: options.overrides ? Object.entries(options.overrides).reduce((acc, [address, override]) => ({
            ...acc,
            [address]: {
              balance: override.balance,
              nonce: override.nonce,
              code: override.code,
              state: override.state,
              state_diff: override.stateDiff
            }
          }), {}) : undefined
        })
      })

      if (!response.ok) {
        throw new Error(`Simulation request failed: ${await response.text()}`)
      }

      const simulation = await response.json()
      return this.mapSimulationOutput(simulation)
    } catch (error) {
      const simulationError = this.parseSimulationError(error)
      return {
        success: false,
        gasUsed: 0,
        error: simulationError
      }
    }
  }

  async simulateBundle(
    transactions: SimulationTransaction[],
    options: SimulationOptions = {}
  ): Promise<SimulationResult[]> {
    try {
      const response = await fetch(this.baseUrl + '-bundle', {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          network_id: options.networkId || '1', // Default to mainnet
          transactions: transactions.map(tx => ({
            from: tx.from,
            to: tx.to,
            input: tx.data || '0x',
            gas: tx.gas,
            gas_price: tx.gasPrice || '0',
            value: tx.value || '0'
          })),
          block_number: options.blockNumber || null,
          state_objects: options.overrides ? Object.entries(options.overrides).reduce((acc, [address, override]) => ({
            ...acc,
            [address]: {
              balance: override.balance,
              nonce: override.nonce,
              code: override.code,
              state: override.state,
              state_diff: override.stateDiff
            }
          }), {}) : undefined,
          save: options.save || false,
          save_if_fails: options.saveIfFails || false
        })
      })

      if (!response.ok) {
        throw new Error(`Bundle simulation request failed: ${await response.text()}`)
      }

      const simulations = await response.json()
      return simulations.map((simulation: any) => this.mapSimulationOutput(simulation))
    } catch (error) {
      const simulationError = this.parseSimulationError(error)
      return transactions.map(() => ({
        success: false,
        gasUsed: 0,
        error: simulationError
      }))
    }
  }

  async estimateGasCosts(
    transaction: SimulationTransaction,
    options: SimulationOptions = {}
  ): Promise<GasCostEstimate> {
    try {
      const response = await fetch(
        `https://api.tenderly.co/api/v1/account/${CONFIG.tenderly.accountName}/project/${CONFIG.tenderly.projectName}/simulate`,
        {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({
            // Simulation Configuration
            save: false,
            save_if_fails: false,
            estimate_gas: true,
            simulation_type: 'quick',
            network_id: options.networkId || '1',
            // Standard EVM Transaction object
            from: transaction.from,
            to: transaction.to,
            input: transaction.data || '0x',
            gas: transaction.gas,
            gas_price: transaction.gasPrice || '0',
            value: transaction.value || '0',
            // Include any state overrides
            state_objects: options.overrides ? Object.entries(options.overrides).reduce((acc, [address, override]) => ({
              ...acc,
              [address]: {
                balance: override.balance,
                nonce: override.nonce,
                code: override.code,
                state: override.state,
                state_diff: override.stateDiff
              }
            }), {}) : undefined
          })
        }
      )

      if (!response.ok) {
        throw new Error(`Simulation request failed: ${await response.text()}`)
      }

      const data = await response.json()
      
      if (!data.transaction) {
        throw new Error('Invalid simulation response')
      }

      // Extract gas used from simulation
      const gasUnits = parseInt(data.transaction.gas_used || '0', 10)
      
      // Get current gas price from the transaction
      // First try effective_gas_price, then gas_price, then base_fee, finally fallback to 20 gwei
      const gasPriceWei = data.transaction.effective_gas_price || 
                         data.transaction.gas_price || 
                         data.transaction.base_fee ||
                         ethers.parseUnits('20', 'gwei').toString() // fallback to 20 gwei
      
      const gasPrice = ethers.formatUnits(gasPriceWei, 'gwei')

      // Log debug information
      console.log('Debug gas estimation:', {
        rawData: {
          effective_gas_price: data.transaction.effective_gas_price,
          gas_price: data.transaction.gas_price,
          base_fee: data.transaction.base_fee,
          gas_used: data.transaction.gas_used
        },
        calculated: {
          gasPriceWei,
          gasPrice,
          gasUnits
        }
      })

      return {
        gasUnits,
        gasPrice,
        gasPriceDetails: {
          baseFeePerGas: ethers.formatUnits(data.transaction.base_fee || gasPriceWei, 'gwei'),
          low: {
            maxPriorityFeePerGas: gasPrice,
            maxFeePerGas: gasPrice,
            waitTime: 120 // Default wait time in seconds
          },
          medium: {
            maxPriorityFeePerGas: gasPrice,
            maxFeePerGas: gasPrice,
            waitTime: 60
          },
          high: {
            maxPriorityFeePerGas: gasPrice,
            maxFeePerGas: gasPrice,
            waitTime: 30
          }
        },
        timestamp: Math.floor(Date.now() / 1000)
      }
    } catch (error) {
      throw new Error(`Failed to estimate gas costs: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
} 