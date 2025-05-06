export type Deposit = {
  deposit_id: bigint;
  owner_address: string;
  delegatee_address: string | null;
  amount: bigint;
  earning_power?: bigint;
  created_at?: string;
  updated_at?: string;
};

export type ProfitabilityCheck = {
  canBump: boolean;
  constraints: {
    calculatorEligible: boolean;
    hasEnoughRewards: boolean;
    isProfitable: boolean;
    hasScoreChanged?: boolean;
    hasEarningPowerIncrease?: boolean;
  };
  estimates: {
    optimalTip: bigint;
    gasEstimate: bigint;
    expectedProfit: bigint;
    tipReceiver: string;
    staticCallResult?: bigint;
  };
};

export type BatchAnalysis = {
  deposits: {
    depositId: bigint;
    profitability: ProfitabilityCheck;
  }[];
  totalGasEstimate: bigint;
  totalExpectedProfit: bigint;
  recommendedBatchSize: number;
};

export type TipOptimization = {
  optimalTip: bigint;
  expectedProfit: bigint;
  gasEstimate: bigint;
};

export type BumpRequirements = {
  isEligible: boolean;
  newEarningPower: bigint;
  unclaimedRewards: bigint;
  maxBumpTip: bigint;
};

export type GasPriceEstimate = {
  price: bigint;
  confidence: number;
  timestamp: number;
};

export interface ProfitabilityConfig {
  rewardTokenAddress: string;
  minProfitMargin: number;
  gasPriceBuffer: number;
  maxBatchSize: number;
  defaultTipReceiver: string;
  priceFeed: {
    cacheDuration: number; // Cache duration in milliseconds
  };
}

export interface GovLstDeposit {
  deposit_id: bigint;
  owner_address: string;
  delegatee_address: string;
  amount: bigint;
  depositor_address?: string;
  shares_of: bigint;
  payout_amount: bigint;
  rewards: bigint;
  earning_power: bigint;
  created_at: string;
  updated_at: string;
}

export interface GovLstDepositGroup {
  deposit_ids: bigint[];
  total_shares: bigint;
  total_payout: bigint;
  expected_profit: bigint;
  gas_estimate: bigint;
  total_rewards: bigint;
}

export interface GovLstProfitabilityCheck {
  is_profitable: boolean;
  constraints: {
    has_enough_shares: boolean;
    meets_min_reward: boolean;
    meets_min_profit: boolean;
  };
  estimates: {
    total_shares: bigint;
    payout_amount: bigint;
    gas_estimate: bigint;
    gas_cost: bigint;
    expected_profit: bigint;
  };
  deposit_details: Array<{
    depositId: bigint;
    rewards: bigint;
  }>;
}

export interface GovLstBatchAnalysis {
  deposit_groups: GovLstDepositGroup[];
  total_gas_estimate: bigint;
  total_expected_profit: bigint;
  total_deposits: number;
}

export interface DepositCache {
  deposit: GovLstDeposit;
  timestamp: number;
}

export interface GovLstDepositDetail {
  depositId: bigint;
  rewards: bigint;
  earning_power: bigint;
}

/**
 * Result of processing a single item in the profitability queue
 */
export interface ProfitabilityQueueResult {
  success: boolean
  result: 'queued' | 'not_profitable' | 'error'
  details: Record<string, unknown>
}

/**
 * Result of batch processing deposits
 */
export interface ProfitabilityQueueBatchResult {
  success: boolean
  total: number
  queued: number
  notProfitable: number
  errors: number
  details: Array<{
    depositId: string
    result: 'queued' | 'not_profitable' | 'error'
    details: Record<string, unknown>
  }>
}
