import { TransactionReceipt } from '@/executor/interfaces/types';

/**
 * Configuration for the GovLst claimer
 */
export type GovLstClaimerConfig = {
  // List of GovLst contract addresses to monitor
  addresses: string[];
  // Current payout amount for claiming rewards
  payoutAmount: bigint;
  // Minimum profit margin required for a claim to be executed
  minProfitMargin: bigint;
  // Maximum batch size for claims
  maxBatchSize: number;
  // How often to check for claimable rewards (in seconds)
  claimInterval: number;
  // Gas price buffer for profitability calculations (percentage)
  gasPriceBuffer: number;
  // Address to receive tips from claims
  tipReceiver?: string;
};

/**
 * Deposit with unclaimed reward information
 */
export type RewardDeposit = {
  deposit_id: string;
  unclaimedReward: bigint;
};

/**
 * Claim batch with profitability analysis
 */
export type ClaimBatch = {
  depositIds: string[];
  estimatedReward: bigint;
  estimatedGasCost: bigint;
  estimatedProfit: bigint;
};

/**
 * Result of a reward analysis for a GovLst contract
 */
export type RewardAnalysis = {
  govLstAddress: string;
  totalDeposits: number;
  totalClaimableRewards: bigint;
  profitableDeposits: number;
  optimalBatches: ClaimBatch[];
};

/**
 * Result of a claim execution
 */
export type ClaimResult = {
  govLstAddress: string;
  batch: ClaimBatch;
  transactionId?: string;
  txHash?: string;
  receipt?: TransactionReceipt;
  success: boolean;
  error?: string;
};

/**
 * Profitability calculation result
 */
export type ProfitabilityCalculation = {
  isGasPriceAvailable: boolean;
  gasPrice: bigint;
  gasCostPerClaim: bigint;
  gasCostPerBatch: bigint;
  tokenValueOfGas: bigint;
  profitPerDeposit: bigint;
  isProfitable: boolean;
};
