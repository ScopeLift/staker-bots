export interface SimulationTransaction {
    from: string;
    to: string;
    data?: string;
    gas?: number | string;
    gasPrice?: string;
    value?: string;
  }
  
  export interface SimulationError {
    code:
      | 'INSUFFICIENT_FUNDS'
      | 'EXECUTION_REVERTED'
      | 'GAS_LIMIT_EXCEEDED'
      | 'SIMULATION_FAILED'
      | 'UNKNOWN_ERROR';
    message: string;
    details?: string;
  }
  
  export interface SimulationResult {
    success: boolean;
    gasUsed: number;
    error?: SimulationError;
    trace?: SimulationTrace;
    logs?: SimulationLog[];
    returnValue?: string;
    status?: boolean;
    blockNumber?: number;
    type?: number;
  }
  
  export interface SimulationStateOverride {
    balance?: string;
    nonce?: number;
    code?: string;
    state?: { [slot: string]: string };
    stateDiff?: { [slot: string]: string };
  }
  
  export interface SimulationOptions {
    networkId?: string; // Network ID (e.g., '1' for mainnet, '5' for goerli)
    blockNumber?: number;
    save?: boolean;
    saveIfFails?: boolean;
    overrides?: Record<
      string,
      {
        balance?: string;
        nonce?: number;
        code?: string;
        state?: Record<string, string>;
        stateDiff?: Record<string, string>;
      }
    >;
  }
  
  export interface SimulationTrace {
    gas: number;
    failed: boolean;
    error?: string;
    returnValue?: string;
    type?: string;
    from: string;
    to: string;
    gasUsed: number;
    address?: string;
    balance?: string;
    value: string;
    errorReason?: string;
    input: string;
    output?: string;
    method?: string;
    subtraces?: SimulationTrace[];
    traceAddress?: number[];
  }
  
  export interface SimulationLog {
    name: string;
    anonymous: boolean;
    inputs: Array<{
      value: string;
      type: string;
      name: string;
    }>;
    raw: {
      address: string;
      topics: string[];
      data: string;
    };
  }
  
  export interface GasPriceDetails {
    baseFeePerGas: string;
    low: {
      maxPriorityFeePerGas: string;
      maxFeePerGas: string;
      waitTime: number;
    };
    medium: {
      maxPriorityFeePerGas: string;
      maxFeePerGas: string;
      waitTime: number;
    };
    high: {
      maxPriorityFeePerGas: string;
      maxFeePerGas: string;
      waitTime: number;
    };
  }
  
  export interface GasCostEstimate {
    gasUnits: number;
    gasPrice: string;
    gasPriceDetails?: GasPriceDetails;
    timestamp: number;
  }
  