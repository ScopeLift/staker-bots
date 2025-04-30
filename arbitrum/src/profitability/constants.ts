export const STAKER_ABI = [
  'function bumpEarningPower(uint256 depositId, address tipReceiver, uint256 tip) returns (uint256)',
  'function unclaimedReward(uint256 depositId) view returns (uint256)',
  'function maxBumpTip() view returns (uint256)',
];
