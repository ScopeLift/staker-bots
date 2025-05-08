/**
 * Represents a deposit in the staker contract
 */
export type Deposit = {
  deposit_id: bigint;
  owner_address: string;
  delegatee_address: string | null;
  amount: bigint;
  earning_power?: bigint;
  created_at?: string;
  updated_at?: string;
};

/**
 * Result of a profitability check for a deposit
 */
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

/**
 * Analysis of a batch of deposits for profitability
 */
export type BatchAnalysis = {
  deposits: {
    depositId: bigint;
    profitability: ProfitabilityCheck;
  }[];
  totalGasEstimate: bigint;
  totalExpectedProfit: bigint;
  recommendedBatchSize: number;
};

/**
 * Result of tip optimization calculation
 */
export type TipOptimization = {
  optimalTip: bigint;
  expectedProfit: bigint;
  gasEstimate: bigint;
};

/**
 * Requirements for bumping a deposit
 */
export type BumpRequirements = {
  isEligible: boolean;
  newEarningPower: bigint;
  unclaimedRewards: bigint;
  maxBumpTip: bigint;
};

/**
 * Gas price estimate with confidence level
 */
export type GasPriceEstimate = {
  price: bigint;
  confidence: number;
  timestamp: number;
};

/**
 * Configuration for the profitability engine
 */
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

/**
 * Details about a deposit in the processing queue
 */
export interface DepositQueueItem {
  depositId: bigint;
  delegateeAddress: string;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  lastAttempt: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Details about a transaction in the execution queue
 */
export interface TransactionQueueItem {
  depositId: bigint;
  tipReceiver: string;
  tip: bigint;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  lastAttempt: number | null;
  error: string | null;
  transactionHash: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Cache entry for a deposit with timestamp
 */
export interface DepositCache {
  deposit: Deposit;
  timestamp: number;
}

/**
 * Status information for the profitability engine
 */
export interface EngineStatus {
  isRunning: boolean;
  lastGasPrice: bigint;
  lastUpdateTimestamp: number;
  queueSize: number;
  delegateeCount: number;
  processingStats: {
    pendingCount: number;
    processingCount: number;
    completedCount: number;
    failedCount: number;
  };
}
