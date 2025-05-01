/**
 * ABI fragments for the staker contract
 */
export const stakerAbi = [
  'event StakeDeposited(address owner, uint256 indexed depositId, uint256 amount, uint256 depositBalance, uint256 earningPower)',
  'event StakeWithdrawn(address owner, uint256 indexed depositId, uint256 amount, uint256 depositBalance, uint256 earningPower)',
  'event DelegateeAltered(uint256 indexed depositId, address oldDelegatee, address newDelegatee, uint256 earningPower)',
  'event EarningPowerBumped(uint256 indexed depositId, uint256 oldEarningPower, uint256 newEarningPower, address bumper, address tipReceiver, uint256 tipAmount)',
  'function deposit(uint256 amount) external returns (uint256 depositId)',
  'function bumpDelegatee(uint256 depositId, address newDelegatee) external returns (bool)',
  'function withdraw(uint256 depositId, uint256 amount) external returns (bool)',
  "function deposits(uint256) view returns (tuple(address owner, uint256 balance, uint256 earningPower, address delegatee, address claimer))",
  "function unclaimedReward(uint256) view returns (uint256)",
  "function maxBumpTip() view returns (uint256)",
  "function bumpEarningPower(uint256, address, uint256) returns (uint256)",
  "function REWARD_TOKEN() view returns (address)"
];

// For debugging, export a utility function to verify ABI events
export const verifyAbiEvents = (abi: string[]): string[] => {
  return abi
    .filter(fragment => fragment.startsWith('event'))
    .map(eventFragment => eventFragment);
};

/**
 * ABI fragments for the reward calculator contract
 */
export const rewardCalculatorAbi = [
  'function calculateRewards(address delegatee, uint256 amount, uint256 timestamp) view returns (uint256)',
  'function getDelegateeScore(address delegatee) view returns (uint256)',
  'event ScoreChanged(address indexed delegatee, uint256 score)',
];

/**
 * ABI fragments for the ERC20 token contract
 */
export const erc20Abi = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]; 