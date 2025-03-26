export const govlst = [
  {
    // Constructor
    inputs: [{
      components: [
        { internalType: "string", name: "fixedLstName", type: "string" },
        { internalType: "string", name: "fixedLstSymbol", type: "string" },
        { internalType: "string", name: "rebasingLstName", type: "string" },
        { internalType: "string", name: "rebasingLstSymbol", type: "string" },
        { internalType: "string", name: "version", type: "string" },
        { internalType: "contract Staker", name: "staker", type: "address" },
        { internalType: "address", name: "initialDefaultDelegatee", type: "address" },
        { internalType: "address", name: "initialOwner", type: "address" },
        { internalType: "uint80", name: "initialPayoutAmount", type: "uint80" },
        { internalType: "address", name: "initialDelegateeGuardian", type: "address" },
        { internalType: "uint256", name: "stakeToBurn", type: "uint256" },
        { internalType: "uint256", name: "maxOverrideTip", type: "uint256" },
        { internalType: "uint256", name: "minQualifyingEarningPowerBips", type: "uint256" }
      ],
      internalType: "struct GovLst.ConstructorParams",
      name: "_params",
      type: "tuple"
    }],
    stateMutability: "nonpayable",
    type: "constructor"
  },

  // Errors
  { inputs: [{ internalType: "address", name: "target", type: "address" }], name: "AddressEmptyCode", type: "error" },
  { inputs: [{ internalType: "address", name: "account", type: "address" }], name: "AddressInsufficientBalance", type: "error" },
  { inputs: [], name: "FailedInnerCall", type: "error" },
  { inputs: [{ internalType: "uint256", name: "earningPower", type: "uint256" }, { internalType: "uint256", name: "thresholdEarningPower", type: "uint256" }], name: "GovLst__EarningPowerNotQualified", type: "error" },
  { inputs: [{ internalType: "uint16", name: "feeBips", type: "uint16" }, { internalType: "uint16", name: "maxFeeBips", type: "uint16" }], name: "GovLst__FeeBipsExceedMaximum", type: "error" },
  { inputs: [], name: "GovLst__FeeCollectorCannotBeZeroAddress", type: "error" },
  { inputs: [], name: "GovLst__GreaterThanMaxTip", type: "error" },
  { inputs: [], name: "GovLst__InsufficientBalance", type: "error" },
  { inputs: [], name: "GovLst__InsufficientRewards", type: "error" },
  { inputs: [], name: "GovLst__InvalidDeposit", type: "error" },
  { inputs: [], name: "GovLst__InvalidFeeParameters", type: "error" },
  { inputs: [], name: "GovLst__InvalidOverride", type: "error" },
  { inputs: [], name: "GovLst__InvalidParameter", type: "error" },
  { inputs: [], name: "GovLst__InvalidSignature", type: "error" },
  { inputs: [], name: "GovLst__SignatureExpired", type: "error" },
  { inputs: [], name: "GovLst__Unauthorized", type: "error" },
  { inputs: [{ internalType: "address", name: "account", type: "address" }, { internalType: "uint256", name: "currentNonce", type: "uint256" }], name: "InvalidAccountNonce", type: "error" },
  { inputs: [], name: "InvalidShortString", type: "error" },
  { inputs: [{ internalType: "address", name: "owner", type: "address" }], name: "OwnableInvalidOwner", type: "error" },
  { inputs: [{ internalType: "address", name: "account", type: "address" }], name: "OwnableUnauthorizedAccount", type: "error" },
  { inputs: [{ internalType: "uint8", name: "bits", type: "uint8" }, { internalType: "uint256", name: "value", type: "uint256" }], name: "SafeCastOverflowedUintDowncast", type: "error" },
  { inputs: [{ internalType: "address", name: "token", type: "address" }], name: "SafeERC20FailedOperation", type: "error" },
  { inputs: [{ internalType: "string", name: "str", type: "string" }], name: "StringTooLong", type: "error" },

  // Events
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "owner", type: "address" },
      { indexed: true, internalType: "address", name: "spender", type: "address" },
      { indexed: false, internalType: "uint256", name: "value", type: "uint256" }
    ],
    name: "Approval",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "address", name: "oldDelegatee", type: "address" },
      { indexed: false, internalType: "address", name: "newDelegatee", type: "address" }
    ],
    name: "DefaultDelegateeSet",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "address", name: "oldDelegatee", type: "address" },
      { indexed: false, internalType: "address", name: "newDelegatee", type: "address" }
    ],
    name: "DelegateeGuardianSet",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "delegatee", type: "address" },
      { indexed: false, internalType: "Staker.DepositIdentifier", name: "depositId", type: "uint256" }
    ],
    name: "DepositInitialized",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "Staker.DepositIdentifier", name: "depositId", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" }
    ],
    name: "DepositSubsidized",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "holder", type: "address" },
      { indexed: false, internalType: "Staker.DepositIdentifier", name: "oldDepositId", type: "uint256" },
      { indexed: false, internalType: "Staker.DepositIdentifier", name: "newDepositId", type: "uint256" }
    ],
    name: "DepositUpdated",
    type: "event"
  },
  { anonymous: false, inputs: [], name: "EIP712DomainChanged", type: "event" },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "uint256", name: "_oldMaxOverrideTip", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "_newMaxOverrideTip", type: "uint256" }
    ],
    name: "MaxOverrideTipSet",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "uint256", name: "_oldMinQualifyingEarningPowerBips", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "_newMinQualifyingEarningPowerBips", type: "uint256" }
    ],
    name: "MinQualifyingEarningPowerBipsSet",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "Staker.DepositIdentifier", name: "depositId", type: "uint256" },
      { indexed: false, internalType: "address", name: "tipReceiver", type: "address" },
      { indexed: false, internalType: "uint160", name: "tipShares", type: "uint160" }
    ],
    name: "OverrideEnacted",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "Staker.DepositIdentifier", name: "depositId", type: "uint256" },
      { indexed: false, internalType: "address", name: "oldDelegatee", type: "address" },
      { indexed: false, internalType: "address", name: "newDelegatee", type: "address" },
      { indexed: false, internalType: "address", name: "tipReceiver", type: "address" },
      { indexed: false, internalType: "uint160", name: "tipShares", type: "uint160" }
    ],
    name: "OverrideMigrated",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "Staker.DepositIdentifier", name: "depositId", type: "uint256" },
      { indexed: false, internalType: "address", name: "tipReceiver", type: "address" },
      { indexed: false, internalType: "uint160", name: "tipShares", type: "uint160" }
    ],
    name: "OverrideRevoked",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "previousOwner", type: "address" },
      { indexed: true, internalType: "address", name: "newOwner", type: "address" }
    ],
    name: "OwnershipTransferred",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "uint256", name: "oldPayoutAmount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "newPayoutAmount", type: "uint256" }
    ],
    name: "PayoutAmountSet",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "claimer", type: "address" },
      { indexed: true, internalType: "address", name: "recipient", type: "address" },
      { indexed: false, internalType: "uint256", name: "rewardsClaimed", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "payoutAmount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "feeAmount", type: "uint256" },
      { indexed: false, internalType: "address", name: "feeCollector", type: "address" }
    ],
    name: "RewardDistributed",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "uint256", name: "payoutAmount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "feeBips", type: "uint256" },
      { indexed: false, internalType: "address", name: "feeCollector", type: "address" }
    ],
    name: "RewardParametersSet",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "account", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" }
    ],
    name: "Staked",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "Staker.DepositIdentifier", name: "_depositId", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
      { indexed: true, internalType: "address", name: "_referrer", type: "address" }
    ],
    name: "StakedWithAttribution",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      { indexed: false, internalType: "uint256", name: "value", type: "uint256" }
    ],
    name: "Transfer",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "account", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" }
    ],
    name: "Unstaked",
    type: "event"
  },

  // Functions
  {
    inputs: [],
    name: "BIPS",
    outputs: [{ internalType: "uint16", name: "", type: "uint16" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "DEFAULT_DEPOSIT_ID",
    outputs: [{ internalType: "Staker.DepositIdentifier", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "DOMAIN_SEPARATOR",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "FIXED_LST",
    outputs: [{ internalType: "contract FixedGovLst", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "MAX_FEE_BIPS",
    outputs: [{ internalType: "uint16", name: "", type: "uint16" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "MAX_OVERRIDE_TIP_CAP",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "MINIMUM_QUALIFYING_EARNING_POWER_BIPS_CAP",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "PERMIT_TYPEHASH",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "REWARD_TOKEN",
    outputs: [{ internalType: "contract IERC20", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "SHARE_SCALE_FACTOR",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "STAKER",
    outputs: [{ internalType: "contract Staker", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "STAKE_TOKEN",
    outputs: [{ internalType: "contract IERC20", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "STAKE_TYPEHASH",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "UNSTAKE_TYPEHASH",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "UPDATE_DEPOSIT_TYPEHASH",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "WITHDRAW_GATE",
    outputs: [{ internalType: "contract WithdrawGate", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "holder", type: "address" },
      { internalType: "address", name: "spender", type: "address" }
    ],
    name: "allowance",
    outputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "_spender", type: "address" },
      { internalType: "uint256", name: "_amount", type: "uint256" }
    ],
    name: "approve",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_holder", type: "address" }],
    name: "balanceCheckpoint",
    outputs: [{ internalType: "uint256", name: "_balanceCheckpoint", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_holder", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "_recipient", type: "address" },
      { internalType: "uint256", name: "_minExpectedReward", type: "uint256" },
      { internalType: "Staker.DepositIdentifier[]", name: "_depositIds", type: "uint256[]" }
    ],
    name: "claimAndDistributeReward",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "_account", type: "address" },
      { internalType: "uint256", name: "_amount", type: "uint256" }
    ],
    name: "convertToFixed",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "_account", type: "address" },
      { internalType: "uint256", name: "_shares", type: "uint256" }
    ],
    name: "convertToRebasing",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "_account", type: "address" },
      { internalType: "uint256", name: "_shares", type: "uint256" }
    ],
    name: "convertToRebasingAndUnstake",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "pure",
    type: "function"
  },
  {
    inputs: [],
    name: "defaultDelegatee",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_delegatee", type: "address" }],
    name: "delegate",
    outputs: [{ internalType: "Staker.DepositIdentifier", name: "_depositId", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_holder", type: "address" }],
    name: "delegateeForHolder",
    outputs: [{ internalType: "address", name: "_delegatee", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "delegateeGuardian",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_delegatee", type: "address" }],
    name: "depositForDelegatee",
    outputs: [{ internalType: "Staker.DepositIdentifier", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_holder", type: "address" }],
    name: "depositIdForHolder",
    outputs: [{ internalType: "Staker.DepositIdentifier", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "eip712Domain",
    outputs: [
      { internalType: "bytes1", name: "fields", type: "bytes1" },
      { internalType: "string", name: "name", type: "string" },
      { internalType: "string", name: "version", type: "string" },
      { internalType: "uint256", name: "chainId", type: "uint256" },
      { internalType: "address", name: "verifyingContract", type: "address" },
      { internalType: "bytes32", name: "salt", type: "bytes32" },
      { internalType: "uint256[]", name: "extensions", type: "uint256[]" }
    ],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "Staker.DepositIdentifier", name: "_depositId", type: "uint256" },
      { internalType: "address", name: "_tipReceiver", type: "address" },
      { internalType: "uint160", name: "_requestedTip", type: "uint160" }
    ],
    name: "enactOverride",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "feeAmount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "feeCollector",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_delegatee", type: "address" }],
    name: "fetchOrInitializeDepositForDelegatee",
    outputs: [{ internalType: "Staker.DepositIdentifier", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "isGuardianControlled",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "Staker.DepositIdentifier", name: "depositId", type: "uint256" }],
    name: "isOverridden",
    outputs: [{ internalType: "bool", name: "isOverridden", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "maxOverrideTip",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "Staker.DepositIdentifier", name: "_depositId", type: "uint256" },
      { internalType: "address", name: "_tipReceiver", type: "address" },
      { internalType: "uint160", name: "_requestedTip", type: "uint160" }
    ],
    name: "migrateOverride",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "minQualifyingEarningPowerBips",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "bytes[]", name: "data", type: "bytes[]" }],
    name: "multicall",
    outputs: [{ internalType: "bytes[]", name: "results", type: "bytes[]" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "name",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_owner", type: "address" }],
    name: "nonces",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "payoutAmount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "_owner", type: "address" },
      { internalType: "address", name: "_spender", type: "address" },
      { internalType: "uint256", name: "_value", type: "uint256" },
      { internalType: "uint256", name: "_deadline", type: "uint256" },
      { internalType: "uint8", name: "_v", type: "uint8" },
      { internalType: "bytes32", name: "_r", type: "bytes32" },
      { internalType: "bytes32", name: "_s", type: "bytes32" }
    ],
    name: "permit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "_amount", type: "uint256" },
      { internalType: "uint256", name: "_deadline", type: "uint256" },
      { internalType: "uint8", name: "_v", type: "uint8" },
      { internalType: "bytes32", name: "_r", type: "bytes32" },
      { internalType: "bytes32", name: "_s", type: "bytes32" }
    ],
    name: "permitAndStake",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "renounceOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "Staker.DepositIdentifier", name: "_depositId", type: "uint256" },
      { internalType: "address", name: "_originalDelegatee", type: "address" },
      { internalType: "address", name: "_tipReceiver", type: "address" },
      { internalType: "uint160", name: "_requestedTip", type: "uint160" }
    ],
    name: "revokeOverride",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "stakeToBurn",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function"
  },


]
