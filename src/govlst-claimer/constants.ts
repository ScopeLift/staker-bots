/**
 * GovLst ABI with only the functions we need
 */
export const GOVLST_ABI = [
  // Get Staker contract address
  'function STAKER() external view returns (address)',
  // Get payout amount
  'function payoutAmount() external view returns (uint256)',
  // Claim and distribute rewards
  'function claimAndDistributeReward(address tipReceiver, uint256 minTotalRewards, uint256[] calldata depositIds) external returns (uint256)',
];

/**
 * Staker ABI with only the functions we need for claiming
 */
export const STAKER_CLAIM_ABI = [
  // Get unclaimed rewards for a deposit
  'function unclaimedReward(uint256 depositId) external view returns (uint256)',
  // Get deposit info
  'function deposits(uint256 depositId) external view returns (address owner, uint256 balance, uint256 earningPower, address delegatee, address claimer)',
];

/**
 * Default configuration for GovLst claimer
 */
export const DEFAULT_GOVLST_CLAIMER_CONFIG = {
  addresses: [],
  payoutAmount: BigInt(0),
  minProfitMargin: BigInt(0),
  maxBatchSize: 10,
  claimInterval: 3600, // 1 hour
  gasPriceBuffer: 20, // 20%
};
