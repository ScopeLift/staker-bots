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
  };
  estimates: {
    optimalTip: bigint;
    gasEstimate: bigint;
    expectedProfit: bigint;
    tipReceiver: string;
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
  minProfitMargin: bigint;
  gasPriceBuffer: number;
  maxBatchSize: number;
  defaultTipReceiver: string;
  priceFeed: {
    cacheDuration: number; // Cache duration in milliseconds
  };
}
