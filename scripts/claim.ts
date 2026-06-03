/**
 * Standalone claim-and-distribute keeper for the Rari GovLst wind-down.
 *
 * Stateless: each run reads live chain state and decides whether to claim.
 * Pulls in NONE of the bot machinery (no monitor, calculator, executor, queue,
 * or DB). Intended to be run on a cron (e.g. every 6-12h) for ~1 month, then
 * deleted along with the cron entry.
 *
 *   tsx scripts/claim.ts              # report-only (default): read + simulate, never send
 *   tsx scripts/claim.ts --broadcast  # actually submit the claim transaction
 *
 * Economic rule (profit is NOT a goal; only gas is ever subsidized):
 *   `claimAndDistributeReward` makes the caller pay the LST's fixed
 *   `payoutAmount` in reward token (distributed to LST holders) and sends the
 *   claimed staking rewards to `recipient`. We set recipient = our wallet so the
 *   claimed rewards offset the payout, and we ONLY claim when the aggregate
 *   unclaimed reward across deposits >= payoutAmount + CLAIM_PROFIT_BUFFER. That
 *   keeps every call at worst break-even on the token side (or better, by the
 *   buffer), leaving gas as the only subsidy.
 *
 * Prerequisites (operator must set up once; not done by this script):
 *   - Wallet funded with gas + ~1 payoutAmount of reward token as working capital.
 *   - One-time ERC20 approve(LST, >= payoutAmount) for the reward token.
 *   Approval/balance are checked at startup: insufficient -> warn in report-only
 *   mode, fatal under --broadcast.
 *
 * Flags:
 *   --broadcast          actually send the transaction. WITHOUT it (the default),
 *                        the script is report-only: it reads, threshold-checks, and
 *                        staticCalls, but never broadcasts.
 *
 * Env knobs (beyond the usual RPC_URL / PRIVATE_KEY / LST_ADDRESS /
 * STAKER_CONTRACT_ADDRESS read via CONFIG):
 *   CLAIM_PROFIT_BUFFER  required surplus over payoutAmount before claiming, in
 *                        WHOLE reward tokens (e.g. 1 = 1 token, 0.5 = half; NOT raw
 *                        units, no 1e18). Default 0. Claim when total >= payout + buffer.
 *   MAX_GAS_PRICE_GWEI   optional ceiling; skip the run if gas price is above it.
 *   CLAIM_GAS_LIMIT      optional fallback gas limit if estimateGas fails.
 *   CLAIM_RECIPIENT      optional override for the rewards recipient (default: wallet).
 */
import { ethers } from 'ethers';
import { CONFIG } from '../src/configuration';

// LST-owned deposit IDs to sweep. Static during the sunset (#0 is not LST-owned,
// so it's excluded). Refresh from the monitor DB if the set changes: the
// LST-owned deposits are those in data/rari-staker-monitor-db.json whose
// owner_address == LST_ADDRESS.
const DEPOSIT_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
].map((n) => BigInt(n));

const GAS_LIMIT_FALLBACK = BigInt(process.env.CLAIM_GAS_LIMIT || '2000000');
// Required surplus over payoutAmount before claiming, expressed in WHOLE reward
// tokens and parsed via parseEther (assumes an 18-decimal token). Decimals are
// allowed: CLAIM_PROFIT_BUFFER=1 -> 1 token, =0.5 -> half a token. NOT raw units
// — do not pass 1e18 (parseEther rejects scientific notation, and 1e18 would mean
// 1e18 tokens).
const PROFIT_BUFFER = ethers.parseEther(process.env.CLAIM_PROFIT_BUFFER || '0');
// Report-only by default; require an explicit --broadcast flag to send any tx.
const BROADCAST = process.argv.includes('--broadcast');

const ts = () => new Date().toISOString();
const json = (o: unknown) =>
  JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
const log = (msg: string, extra?: unknown) =>
  console.log(
    `[${ts()}] ${msg}${extra !== undefined ? ' ' + json(extra) : ''}`,
  );

// Unmet precondition: fatal under --broadcast, warn-and-continue in report-only
// mode (so a report-only run still produces a report).
function precondition(ok: boolean, message: string): void {
  if (ok) return;
  if (BROADCAST) throw new Error(message);
  log(`WARN (report-only, continuing): ${message}`);
}

async function main() {
  if (!CONFIG.executor.privateKey) throw new Error('PRIVATE_KEY is not set');
  if (!CONFIG.monitor.lstAddress) throw new Error('LST_ADDRESS is not set');
  if (!CONFIG.monitor.stakerAddress)
    throw new Error('STAKER_CONTRACT_ADDRESS is not set');

  const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);
  const wallet = new ethers.Wallet(CONFIG.executor.privateKey, provider);
  const recipient = process.env.CLAIM_RECIPIENT || wallet.address;

  const staker = new ethers.Contract(
    CONFIG.monitor.stakerAddress,
    ['function unclaimedReward(uint256 depositId) view returns (uint256)'],
    provider,
  );
  const lst = new ethers.Contract(
    CONFIG.monitor.lstAddress,
    [
      'function payoutAmount() view returns (uint256)',
      'function REWARD_TOKEN() view returns (address)',
      'function claimAndDistributeReward(address _recipient, uint256 _minExpectedReward, uint256[] _depositIds)',
    ],
    wallet,
  );

  // Preconditions: the wallet must have approved the LST to pull at least one
  // payoutAmount of reward token AND hold at least that much, else claims revert.
  // Fatal under --broadcast; warn-and-continue in report-only mode.
  const payout: bigint = await lst.payoutAmount();
  const rewardTokenAddress: string = await lst.REWARD_TOKEN();
  const rewardToken = new ethers.Contract(
    rewardTokenAddress,
    [
      'function balanceOf(address) view returns (uint256)',
      'function allowance(address,address) view returns (uint256)',
    ],
    provider,
  );
  const [rewardBalance, allowance]: [bigint, bigint] = await Promise.all([
    rewardToken.balanceOf(wallet.address),
    rewardToken.allowance(wallet.address, CONFIG.monitor.lstAddress),
  ]);
  log(
    `preflight: payoutAmount ${ethers.formatEther(payout)}, allowance ${Number(ethers.formatEther(allowance)).toExponential(2)}, ` +
      `reward-token balance ${ethers.formatEther(rewardBalance)}`,
  );
  precondition(
    allowance >= payout,
    `Insufficient reward-token approval: allowance ${ethers.formatEther(allowance)} < payoutAmount ` +
      `${ethers.formatEther(payout)}. Approve the LST (${CONFIG.monitor.lstAddress}) to spend the reward ` +
      `token (${rewardTokenAddress}) from ${wallet.address} before broadcasting.`,
  );
  precondition(
    rewardBalance >= payout,
    `Insufficient reward-token balance: ${ethers.formatEther(rewardBalance)} < payoutAmount ` +
      `${ethers.formatEther(payout)}. Fund ${wallet.address} with at least one payoutAmount of the reward ` +
      `token (${rewardTokenAddress}) before broadcasting.`,
  );

  // Optional gas-price ceiling so we don't claim during a spike.
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0n;
  if (process.env.MAX_GAS_PRICE_GWEI) {
    const ceiling = ethers.parseUnits(process.env.MAX_GAS_PRICE_GWEI, 'gwei');
    if (gasPrice > ceiling) {
      log(
        `skip: gas price ${ethers.formatUnits(gasPrice, 'gwei')} gwei > ceiling ${process.env.MAX_GAS_PRICE_GWEI} gwei`,
      );
      return;
    }
  }

  // Read unclaimed rewards per deposit (payoutAmount already read in preflight).
  const withRewards: bigint[] = [];
  let total = 0n;
  for (const id of DEPOSIT_IDS) {
    const r: bigint = await staker.unclaimedReward(id);
    if (r > 0n) {
      withRewards.push(id);
      total += r;
    }
  }
  const threshold = payout + PROFIT_BUFFER;
  log(
    `unclaimed total ${ethers.formatEther(total)} across ${withRewards.length} deposit(s); ` +
      `payoutAmount ${ethers.formatEther(payout)} + buffer ${ethers.formatEther(PROFIT_BUFFER)} = threshold ${ethers.formatEther(threshold)}`,
  );

  // Only claim when the sweep clears payoutAmount + the profit buffer.
  if (withRewards.length === 0 || total < threshold) {
    log(
      `skip: aggregate unclaimed ${ethers.formatEther(total)} < threshold ${ethers.formatEther(threshold)}; nothing worth claiming yet`,
    );
    return;
  }

  // No slippage tolerance: require the full measured unclaimed total.
  const minExpected = total;

  // Simulate first — never burn gas on a revert.
  try {
    await lst.claimAndDistributeReward.staticCall(
      recipient,
      minExpected,
      withRewards,
    );
  } catch (e: any) {
    log(
      `skip: staticCall reverted — ${e?.shortMessage || e?.reason || e?.message}`,
    );
    return;
  }

  if (!BROADCAST) {
    log(
      'report-only (pass --broadcast to send): staticCall succeeded; would submit claimAndDistributeReward',
      { deposits: withRewards, minExpected, recipient },
    );
    return;
  }

  let gasLimit = GAS_LIMIT_FALLBACK;
  try {
    gasLimit =
      ((await lst.claimAndDistributeReward.estimateGas(
        recipient,
        minExpected,
        withRewards,
      )) *
        120n) /
      100n;
  } catch {
    /* fall back to constant */
  }

  log(`submitting claimAndDistributeReward`, {
    deposits: withRewards,
    minExpected,
    recipient,
    gasLimit,
  });
  const tx = await lst.claimAndDistributeReward(
    recipient,
    minExpected,
    withRewards,
    { gasLimit },
  );
  log(`tx sent ${tx.hash}`);
  const rcpt = await tx.wait(1);
  log(
    `tx ${rcpt?.status === 1 ? 'CONFIRMED' : 'FAILED'} block ${rcpt?.blockNumber} gasUsed ${rcpt?.gasUsed}`,
  );
}

main().catch((e) => {
  console.error(`[${ts()}] FATAL`, e);
  process.exit(1);
});
