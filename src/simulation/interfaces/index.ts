import { BigNumberish } from 'ethers'

export interface SimulationTransaction {
  from: string
  to: string
  data?: string
  value?: string | number
  gas: number
  gasPrice?: string
  maxFeePerGas?: number
  maxPriorityFeePerGas?: number
  accessList?: Array<{
    valueAddress: string
    valueStorageKeys: string[]
  }>
}

export interface SimulationError {
  code: 'INSUFFICIENT_FUNDS' | 'EXECUTION_REVERTED' | 'GAS_LIMIT_EXCEEDED' | 'SIMULATION_FAILED' | 'UNKNOWN_ERROR'
  message: string
  details?: string
}

export interface SimulationResult {
  success: boolean
  gasUsed: number
  error?: SimulationError
  trace?: {
    gas?: number
    failed?: boolean
    error?: string
    returnValue?: string
    type?: string
    from?: string
    to?: string
    gasUsed?: number
    address?: string | null
    balance?: number | null
    refundAddress?: string | null
    value?: number | null
    errorReason?: string | null
    input?: string | null
    output?: string | null
    method?: string | null
    subtraces?: number
    traceAddress?: number[]
  }
  logs?: Array<{
    name?: string
    anonymous?: boolean
    inputs?: Array<{
      value?: unknown
      type?: string
      name?: string
    }>
    raw?: {
      address?: string
      topics: string[]
      data: string
    }
  }>
  returnValue?: string
  status?: boolean
  blockNumber?: number
  type?: number
}

export interface SimulationStateOverride {
  balance?: string
  nonce?: number
  code?: string
  state?: { [slot: string]: string }
  stateDiff?: { [slot: string]: string }
}

export interface SimulationOptions {
  networkId?: string // Network ID (e.g., '1' for mainnet, '5' for goerli)
  blockNumber?: number
  overrides?: { [address: string]: SimulationStateOverride }
  save?: boolean
  saveIfFails?: boolean
}

export interface GasCostEstimate {
  gasUnits: number
  gasPrice: string
  gasPriceDetails?: {
    baseFeePerGas: string
    low: {
      maxPriorityFeePerGas: string
      maxFeePerGas: string
      waitTime: number
    }
    medium: {
      maxPriorityFeePerGas: string
      maxFeePerGas: string
      waitTime: number
    }
    high: {
      maxPriorityFeePerGas: string
      maxFeePerGas: string
      waitTime: number
    }
  }
  timestamp: number
} 