export const govlstAbi = [
  'function name() external view returns (string)',
  'function symbol() external view returns (string)',
  'function decimals() external pure returns (uint8)',
  'function version() external view returns (string)',
  'function totalSupply() external view returns (uint256)',
  'function totalShares() external view returns (uint256)',
  'function sharesForStake(uint256 _amount) external view returns (uint256)',
  'function stakeForShares(uint256 _shares) public view returns (uint256)',
  'function balanceOf(address _holder) external view returns (uint256)',
  'function sharesOf(address _holder) external view returns (uint256)',
  'function balanceCheckpoint(address _holder) external view returns (uint256)',
  'function delegateeForHolder(address _holder) external view returns (address)',
  'function depositForDelegatee(address _delegatee) public view returns (uint256)',
  'function depositIdForHolder(address _holder) external view returns (uint256)',
  'function feeAmount() external view returns (uint256)',
  'function feeCollector() external view returns (address)',
  'function payoutAmount() external view returns (uint256)',
  'function nonces(address _owner) public view returns (uint256)',
  'function DOMAIN_SEPARATOR() external view returns (bytes32)',
  'function fetchOrInitializeDepositForDelegatee(address _delegatee) public returns (uint256)',
  'function updateDeposit(uint256 _newDepositId) public',
  'function stake(uint256 _amount) external returns (uint256)',
  'function stakeWithAttribution(uint256 _amount, address _referrer) external returns (uint256)',
  'function unstake(uint256 _amount) external returns (uint256)',
  'function approve(address _spender, uint256 _amount) external returns (bool)',
  'function permit(address _owner, address _spender, uint256 _value, uint256 _deadline, uint8 _v, bytes32 _r, bytes32 _s) external',
  'function transfer(address _to, uint256 _value) external returns (bool)',
  'function transferAndReturnBalanceDiffs(address _receiver, uint256 _value) external returns (uint256, uint256)',
  'function transferFrom(address _from, address _to, uint256 _value) external returns (bool)',
  'function transferFromAndReturnBalanceDiffs(address _from, address _to, uint256 _value) external returns (uint256, uint256)',
  'function claimAndDistributeReward(address _recipient, uint256 _minExpectedReward, uint256[] calldata _depositIds) external',
  'function delegate(address _delegatee) public returns (uint256)',
  'function subsidizeDeposit(uint256 _depositId, uint256 _amount) external',
  'function enactOverride(uint256 _depositId) external',
  'function revokeOverride(uint256 _depositId, address _originalDelegatee) external',
  'function migrateOverride(uint256 _depositId) external',
  'function setRewardParameters(tuple(uint80 payoutAmount, uint16 feeBips, address feeCollector) _params) external',
  'function setMinQualifyingEarningPowerBips(uint256 _minQualifyingEarningPowerBips) external',
  'function setDefaultDelegatee(address _newDelegatee) external',
  'function setDelegateeGuardian(address _newDelegateeGuardian) external',
  'function updateFixedDeposit(address _account, uint256 _newDepositId) external returns (uint256)',
  'function stakeAndConvertToFixed(address _account, uint256 _amount) external returns (uint256)',
  'function convertToFixed(address _account, uint256 _amount) external returns (uint256)',
  'function transferFixed(address _sender, address _receiver, uint256 _shares) external returns (uint256, uint256)',
  'function convertToRebasing(address _account, uint256 _shares) external returns (uint256)',
  'function convertToRebasingAndUnstake(address _account, uint256 _shares) external returns (uint256)',
  'function STAKER() external view returns (address)',
  'function STAKE_TOKEN() external view returns (address)',
  'function REWARD_TOKEN() external view returns (address)',
  'function WITHDRAW_GATE() external view returns (address)',
  'function FIXED_LST() external view returns (address)',
  'function DEFAULT_DEPOSIT_ID() external view returns (uint256)',
  'function SHARE_SCALE_FACTOR() external view returns (uint256)',
  'function PERMIT_TYPEHASH() external view returns (bytes32)',
  'function BIPS() external view returns (uint16)',
  'function MAX_FEE_BIPS() external view returns (uint16)',
  'function MINIMUM_QUALIFYING_EARNING_POWER_BIPS_CAP() external view returns (uint256)',
  'function defaultDelegatee() external view returns (address)',
  'function delegateeGuardian() external view returns (address)',
  'function isGuardianControlled() external view returns (bool)',
  'function minQualifyingEarningPowerBips() external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function isOverridden(uint256 depositId) external view returns (bool)',
  'event PayoutAmountSet(uint256 oldPayoutAmount, uint256 newPayoutAmount)',
  'event RewardParametersSet(uint256 payoutAmount, uint256 feeBips, address feeCollector)',
  'event DefaultDelegateeSet(address oldDelegatee, address newDelegatee)',
  'event DelegateeGuardianSet(address oldDelegatee, address newDelegatee)',
  'event MinQualifyingEarningPowerBipsSet(uint256 _oldMinQualifyingEarningPowerBips, uint256 _newMinQualifyingEarningPowerBips)',
  'event DepositInitialized(address indexed delegatee, uint256 depositId)',
  'event DepositUpdated(address indexed holder, uint256 oldDepositId, uint256 newDepositId)',
  'event Staked(address indexed account, uint256 amount)',
  'event Unstaked(address indexed account, uint256 amount)',
  'event OverrideEnacted(uint256 depositId)',
  'event OverrideRevoked(uint256 depositId)',
  'event OverrideMigrated(uint256 depositId, address oldDelegatee, address newDelegatee)',
  'event RewardDistributed(address indexed claimer, address indexed recipient, uint256 rewardsClaimed, uint256 payoutAmount, uint256 feeAmount, address feeCollector)',
  'event StakedWithAttribution(uint256 _depositId, uint256 _amount, address indexed _referrer)',
  'event DepositSubsidized(uint256 indexed depositId, uint256 amount)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

// Import and export the staker ABI from the JSON file
export const stakerAbi = [
  'function STAKER() external view returns (address)',
  'function payoutAmount() external view returns (uint256)',
  'function claimAndDistributeReward(address tipReceiver, uint256 minTotalRewards, uint256[] calldata depositIds) external returns (uint256)',
  'function sharesOf(address account) external view returns (uint256)',
  'function deposits(uint256 depositId) external view returns (address owner, uint256 balance, uint256 earningPower, address delegatee, address claimer)',
  'function unclaimedReward(uint256 depositId) external view returns (uint256)',
  'function claimReward(uint256 depositId) external returns (uint256)',
  'function bump(uint256 depositId, uint256 tip, address tipReceiver) external returns (uint256)',
  'function bumpEarningPower(uint256 depositId, address tipReceiver, uint256 tip) external returns (uint256)',
  'function totalSupply() external view returns (uint256)',
  'function symbol() external view returns (string)',
  'function balanceOf(address account) external view returns (uint256)',
  'function transfer(address recipient, uint256 amount) external returns (bool)',
  'function transferFrom(address sender, address recipient, uint256 amount) external returns (bool)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'event StakeDeposited(address owner, uint256 indexed depositId, uint256 amount, uint256 depositBalance, uint256 earningPower)',
  'event StakeWithdrawn(address owner, uint256 indexed depositId, uint256 amount, uint256 depositBalance, uint256 earningPower)',
  'event DelegateeAltered(uint256 indexed depositId, address oldDelegatee, address newDelegatee, uint256 earningPower)',
  'event Staked(address indexed account, uint256 amount)',
  'event StakedWithAttribution(uint256 _depositId, uint256 _amount, address indexed _referrer)',
  'event Unstaked(address indexed account, uint256 amount)',
  'event DepositInitialized(address indexed delegatee, uint256 depositId)',
  'event DepositUpdated(address indexed holder, uint256 oldDepositId, uint256 newDepositId)',
];

export const RARI_ABIS = {
  // Staker Contract ABI (simplified for relevant functions)
  STAKER_CONTRACT_ABI: `[
    {
      "inputs": [
        {
          "internalType": "uint256",
          "name": "depositId",
          "type": "uint256"
        },
        {
          "internalType": "address",
          "name": "tipReceiver",
          "type": "address"
        },
        {
          "internalType": "uint256",
          "name": "tip",
          "type": "uint256"
        }
      ],
      "name": "bumpEarningPower",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "depositor",
          "type": "address"
        }
      ],
      "name": "getEarningPower",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "depositor",
          "type": "address"
        }
      ],
      "name": "depositInfos",
      "outputs": [
        {
          "components": [
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "delegatee",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "earningPower",
              "type": "uint256"
            }
          ],
          "internalType": "struct RariStaker.DepositInfo",
          "name": "",
          "type": "tuple"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    }
  ]`,

  // LST Token ABI (simplified for relevant functions)
  LST_ABI: `[
    {
      "inputs": [],
      "name": "claimAndDistributeReward",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "getUnclaimedRewards",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    }
  ]`,

  // Earning Power Calculator ABI (simplified for relevant functions)
  EARNING_POWER_CALCULATOR_ABI: `[
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "depositor",
          "type": "address"
        }
      ],
      "name": "calculateEarningPower",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "depositor",
          "type": "address"
        },
        {
          "internalType": "uint256",
          "name": "tipAmount",
          "type": "uint256"
        }
      ],
      "name": "simulateBumpEarningPower",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    }
  ]`
}
