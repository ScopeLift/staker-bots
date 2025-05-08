export const REWARD_CALCULATOR_ABI = [
  'function getEarningPower(uint256 amountStaked, address staker, address delegatee) view returns (uint256)',
  'function getNewEarningPower(uint256 amountStaked, address staker, address delegatee, uint256 oldEarningPower) view returns (uint256, bool)',
  'event DelegateeScoreUpdated(address indexed delegatee, uint256 oldScore, uint256 newScore)',
] as const;

export const CALCULATOR_EVENTS = {
  DELEGATEE_SCORE_UPDATED: 'DelegateeScoreUpdated',
} as const;

export const MAX_SCORE_CACHE_SIZE = 1000;
