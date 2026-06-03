# AGENTS.md

Context and working notes for AI agents (and humans) working on this repo. Last
substantive update: 2026-06-03.

This file captures hard-won context that is **not obvious from the code**: the
current operating posture, domain semantics, environment setup, and bugs
found/fixed.

> 🛑 **Current status: WIND-DOWN.** Rari is sunsetting its staking program; this
> repo only needs to operate for ~1 more month (from early June 2026). The full
> `src/` bot is **no longer the operational path** — day-to-day work runs through
> a small standalone keeper, **`scripts/claim.ts`**, on an hourly GitHub Actions
> cron. **Bumping is irrelevant** (the oracle has stopped updating delegatee
> scores, so nothing new becomes bumpable); the only job that matters is claiming
> & distributing rewards. See **§8 "Wind-down operations"** for the runbook. The
> `src/` bot and its engines (§1, §3–§5) are now mostly **historical context**.

---

## 1. What this repo is

A **GovLst staking keeper bot** that runs against **RARI Chain**
(`chainId 1380012617` = `0x52415249` = ASCII "RARI"). It monitors a Staker
contract, decides when keeper actions are profitable, and (when enabled) signs
and submits transactions.

Key on-chain actors (observed at runtime; sourced from env / `src/configuration`):

| Role               | Address                                      | Notes                                               |
| ------------------ | -------------------------------------------- | --------------------------------------------------- |
| Staker             | `0xfb0dF2b1Ca894BFdC0e3a200a26B87C5b348CeB6` | RariStaker, **deployed at block 2714010**           |
| GovLst / LST token | `0xf5b1009B9B5e36346f4A6B586FA35d02996703bf` | custodies pooled stake; `owner` of most deposits    |
| Reward calculator  | `0xAc5315251B91D2Fa4bf61cE479DF792778A7f464` | binary eligibility oracle (`DelegateeScoreUpdated`) |
| Default delegatee  | `0x0000000000000000000000000000000000000B01` | fallback for GovLst-owned deposits                  |

The bot has **two keeper actions**, each wrapped by one engine:

1. **Bumping** → `bumpEarningPower(depositId, tipReceiver, tip)` on the **Staker**.
   Engine: `src/profitability/strategies/RariBumpEarningPowerEngine.ts`.
   Re-syncs a deposit's earning power after its delegatee's score changes; the
   caller takes a `tip` out of the deposit's unclaimed rewards (capped by
   `maxBumpTip()`). The engine only acts when the change **crosses the
   eligibility threshold** (hardcoded `15e18`). Triggered by score events
   (`onScoreEvent`) and a periodic full sweep (`BUMP_EARNING_POWER_INTERVAL`,
   default 5 min).

2. **Claim & distribute** → `claimAndDistributeReward(recipient, minExpectedReward, depositIds[])`
   on the **LST**. Engine: `src/profitability/strategies/RariClaimDistributeEngine.ts`.
   Claims accrued rewards across a batch of deposits and distributes them; the
   bot's accounting treats the LST's fixed `payoutAmount` as a cost it pays in,
   profiting when `Σ unclaimedRewards − payoutAmount − gas > margin`. Periodic
   only (`CLAIM_AND_DISTRIBUTE_INTERVAL`, default 5 min).

A third, **dead** path exists (`queueClaimTransaction` → `claimReward(depositId)`,
`RariClaimDistributeEngine.ts:732`) — nothing calls it.

> ⚠️ **Both engines are DISABLED by default.** They hard-gate on
> `ENABLE_BUMP_EARNING_POWER=true` / `ENABLE_CLAIM_AND_DISTRIBUTE=true`
> (`RariBumpEarningPowerEngine.ts:900`, `RariClaimDistributeEngine.ts:122`).
> With the flags off, the bot only monitors and calculates — it never queues or
> sends a transaction. **For the wind-down, neither engine runs at all** — claiming
> is done by the standalone `scripts/claim.ts` (see §8).

Components are selected via `COMPONENTS=` (e.g. `monitor,executor,profitability,bump,claim`),
wired together in `src/index.ts`.

---

## 2. Dev environment

- **Toolchain is pinned with Volta** in `package.json`: Node **24.16.0**, pnpm
  **9.15.9** (`@types/node` is `^24`). Upgraded from Node 20 on 2026-06-03 to stay
  off the deprecated GitHub-Actions Node-20 runtime. (Volta 2.x manages pnpm
  without the old `VOLTA_FEATURE_PNPM` flag.)
- The committed lockfile is `lockfileVersion: 9.0` (pnpm ≥ 9). Both workflows
  (`code-quality.yml` + `claim.yml`) run on **Node-24 actions**:
  `actions/checkout@v5` + `actions/setup-node@v5` (node-version 24), installing
  pnpm via `npm install -g pnpm@9.15.9` instead of `pnpm/action-setup` (still a
  Node-20 action, which would re-trigger the deprecation warning).
- If `node -v` doesn't show 24.16.0 inside the repo, another version manager
  (nvm/Homebrew/asdf) is ahead of Volta in `PATH` — fix `PATH` ordering.
- Install: `pnpm install` (use `CI=true pnpm install --frozen-lockfile` to skip
  the interactive "purge modules" prompt). Run: `pnpm dev` (= `tsx watch src/index.ts`).
- **Required env** (in `.env`, gitignored). The private key var is
  **`PRIVATE_KEY`** — see fix #1 below. Also: `RPC_URL`, `CHAIN_ID`,
  `STAKER_CONTRACT_ADDRESS`, `LST_ADDRESS`, `REWARD_CALCULATOR_ADDRESS`,
  `GOVLST_ADDRESSES`, `START_BLOCK`, `TIP_RECEIVER`, `DATABASE_TYPE` (json|supabase),
  the two `ENABLE_*` flags. Full list: `src/configuration/index.ts`.
- **Storage**: `DATABASE_TYPE=json` writes `data/rari-staker-monitor-db.json`
  (gitignored). Supabase is the prod path.
- `START_BLOCK` matters: the monitor crawls from it 2000 blocks at a time. Set it
  near the Staker deployment (2714010) or it scans from genesis. (It was set to
  2713795 in testing, which is correctly just before deployment.)

### Tooling gaps (pre-existing)

- **No ESLint config exists** (`.eslintrc*` / `eslint.config.*` / `eslintConfig`
  are all absent). `pnpm lint` and the CI "Run ESLint" step therefore fail with
  _"ESLint couldn't find a configuration file."_ Prettier and `tsc` are fine.
- **No tests** (no `*.test.ts`) despite a commit titled "add simulation, tests".
- `pnpm typecheck` is clean once dependencies are fully installed.

---

## 3. Bugs fixed this session

All committed. File references are post-fix.

1. **`PRIVATE_KEY` env var name mismatch.** The executor reads
   `process.env.PRIVATE_KEY` (`src/configuration/index.ts:60`), but the `.env`
   template and README advertised `OPERATOR_PRIVATE_KEY`. Setting the wrong name
   left the key empty → `ethers.Wallet('')` → `invalid private key`. The tell was
   `hasPrivateKey: false` in the executor startup log. (Docs still inconsistent —
   `src/executor/README.md` is internally split.)

2. **Logger printed a trailing `undefined`** on every single-arg log call.
   `ConsoleLogger` passed `meta` (possibly `undefined`) straight to `console.*`.
   Fixed in `src/monitor/logging.ts` to omit the second arg when `meta` is
   undefined. Cosmetic only.

3. **ethers v6 `.address` mis-use in score-event logging.**
   `BinaryEligibilityOracleEarningPowerCalculator.ts` logged
   `(this.contract as unknown as { address: string }).address` — `.address` is
   ethers v5; v6 uses `.target`/`getAddress()`, so it logged `undefined`. The
   actual `queryFilter` was always correct. Fixed to log
   `CONFIG.monitor.rewardCalculatorAddress`. Cosmetic only.

4. **`deposits()` ABI struct mismatch (REAL bug).** `src/configuration/abis.ts`
   declared `deposits(uint256) returns (address owner, uint256 balance, uint256
earningPower, ...)`, but the actual Staker struct is
   **`(uint96 balance, address owner, uint96 earningPower, address delegatee,
address claimer)`** — `owner`/`balance` were swapped (and ints are `uint96`).
   Effect: `depositState.balance` decoded the owner _address_ as a ~1.4e48
   number, and `depositState.owner` was garbage. This fed the bump engine's
   `isBumpProfitable` (which reads `depositState.balance`/`.owner` and passes them
   to the calculator), producing bogus "earning power changed" results — every
   such bump would revert on-chain (and, since pre-encoded txs skip simulation in
   `BaseExecutor`, could be _sent_ and burn gas). Fixed at `abis.ts:90`. Engines
   access fields by name, so the one-line ABI change corrects the runtime decode
   everywhere.

### Verified, NOT a bug

- "Many deposits have the same balance" was a _symptom_ of bug #4: the displayed
  "balance" was really the `owner` address, and deposits #1–#18 are all owned by
  the LST (`0xf5b1009…703bf`), so they shared a value. Real balances differ.

---

## 4. Known / outstanding issues (not yet fixed)

Highest-impact first. None of these are addressed in code yet.

- ~~Monitor stores wrong deposit balances~~ — **fixed in code 2026-06-01** (see
  §5); existing `data/*.json` records stay stale until a re-sync.
- **Profitability math uses hardcoded stale prices.** `GasCostEstimator.ts:29`
  and `GovLstProfitabilityEngine.ts:915-916` hardcode `ETH=$1800`, `token=$1`. A
  real CoinMarketCap feed exists but isn't wired into these calculations.
- **Pre-encoded txs skip simulation** in `BaseExecutor`, so a reverting bump /
  claim can be submitted and waste gas. Bump & claim txs are hand-encoded.
- **Bump "increase" path tips 0** (`RariBumpEarningPowerEngine.ts:869`) — pays
  gas, collects nothing for the bot. Looks like a placeholder.
- **Hardcoded magic constants** in the bump engine: `15e18` eligibility threshold
  (`:751`), `1_000_000` token `MAX_SAFE_TIP` (`:775`) — neither validated against
  the contract.
- **ABI ambiguity / churn.** `claimAndDistributeReward` is defined 3× with 2
  signatures in `abis.ts` (LST variant vs staker variant w/ return); `bump()` and
  `bumpEarningPower()` coexist with **different arg order**. Confirm against the
  deployed contract before enabling (recent git history — "wrong function",
  "fixed claimAndDistribute" — churned here).
- **No reorg handling** despite a `REORG_DEPTH=64` config value (loaded, never
  used); no block-hash validation on resume.
- **JSON DB** has no concurrency control (in-memory mutate + async file write);
  the Supabase→JSON fallback is one-way (never recovers) → silent divergence.
- See §2 for the missing ESLint config and absent tests.

---

## 5. Monitor deposit-balance bug + fix (implemented 2026-06-01)

> **Status: fixed & verified (2026-06-03).** Applied across `src/monitor/types.ts`,
> `StakerMonitor.ts`, and `EventProcessor.ts` (the "use LST amount" override and
> the withdrawal underflow-clamp were removed). The JSON DB was re-synced from
> scratch and **all 19 deposits now match `deposits().balance` exactly**. The
> "Proposed fix" write-up below is retained as the rationale/record.

### Symptom

Stored `amount` in `data/*.json` does **not** match on-chain balances:

| deposit | stored `amount` | true on-chain balance |
| ------- | --------------- | --------------------- |
| #1      | 1619.40         | 6016.03               |
| #5      | 22694.82        | 46237.48              |

`earning_power` is never stored at all (always `(none)`).

### Root cause (verified against chain, not the ABI bug)

Confirmed independent of fix #4 — the monitor **never calls `deposits()`**; it
builds records from events only. And it's **not** a `START_BLOCK` coverage gap:
`START_BLOCK` (2713795) is before deployment (2714010), and re-scanning the chain
events reconciles **exactly** to the live balance:

```
deposit #5: Σ(StakeDeposited.amount) − Σ(StakeWithdrawn.amount) = 46237.477…
            last event's depositBalance                          = 46237.477…
            live deposits().balance                              = 46237.477…
            but JSON stored                                      = 22694.82  ❌
```

So the events are complete and correct, but the monitor's **delta-accumulation
pipeline drops/distorts** a large fraction of them (there are ~5,378
`StakeDeposited` + ~3,945 `StakeWithdrawn` events — heavy reward-restaking churn).
Two mechanisms in the code cause this:

- `EventProcessor.processStakeDeposited` (`src/monitor/EventProcessor.ts:36-38`)
  sums per-event `amount` deltas: `newAmount = existing.amount + event.amount`.
- `StakerMonitor` groups events **per transaction** and keeps only one
  `deposited`/`withdrawn` per group (`StakerMonitor.ts:464-506`), silently
  dropping extras when a tx emits several; plus a "use LST amount if available"
  override (`StakerMonitor.ts:478-482`) that replaces the staker `amount` with an
  LST-event amount on user-stake txs.

### Proposed fix — store the authoritative `depositBalance`

Each `StakeDeposited`/`StakeWithdrawn` event already carries `depositBalance`, the
**authoritative running total after that event**. Storing it directly (instead of
accumulating deltas) makes the persisted balance exactly correct and immune to
dropped-event / grouping / override bugs. The trace above proves
`depositBalance == live balance` at every step.

**Implementation steps** (spans 3 files; `depositBalance` is not currently
threaded through):

1. `src/monitor/types.ts` — add `depositBalance: bigint` to `StakeDepositedEvent`
   and `StakeWithdrawnEvent`.
2. `src/monitor/StakerMonitor.ts`
   - In the deposited path (~`:468-505`): read
     `depositEvent.args.depositBalance` and pass it through
     `handleStakeDeposited({ …, depositBalance })`.
   - In the withdrawn path (~`:521-527`): read `typedEvent.args.depositBalance`
     and pass it through `handleStakeWithdrawn({ …, depositBalance })`.
   - Drop the "use LST amount" override (`:478-482`) for the balance — it's no
     longer relevant once `depositBalance` is authoritative (the LST event may
     still be used for `depositorAddress` attribution if desired).
3. `src/monitor/EventProcessor.ts`
   - `processStakeDeposited`: set `amount: event.depositBalance.toString()`
     (no accumulation, create-or-update both set the same authoritative value).
   - `processStakeWithdrawn`: set `amount: event.depositBalance.toString()`
     instead of `existing.amount − withdrawnAmount`. Drop the
     `remainingAmount <= 0 → delegatee = owner` clamp branch (`:100-101`); it only
     existed to paper over undercounting.
   - Optional: also persist `earning_power` from `event.earningPower`, since the
     event provides it.

**After the change**, existing JSON records remain wrong until a re-sync. Either
delete `data/rari-staker-monitor-db.json` and let it rebuild from `START_BLOCK`,
or reprocess. Note the bot's _live_ reads (bump uses the now-fixed `deposits()`
getter; claim uses `unclaimedReward()`) are already accurate regardless of the
stored `amount`, which is mainly used as the **list of deposit IDs** to check —
so this fix is primarily about data integrity/observability, plus avoiding the
false `amount: 0` records.

---

## 6. Diagnostic scripts

- `scripts/check-bumpable.ts` — **read-only** bumpability checker. For each
  deposit in the JSON DB, reads live state and `staticCall`s the Staker's own
  `bumpEarningPower(id, tipReceiver, 0)` to determine if a real bump would
  succeed. Creates no signer; cannot submit. Run: `tsx scripts/check-bumpable.ts`.
  Verdict column: ✅ BUMPABLE / ⚠️ EP changes but reverts / — not bumpable.
  (As of last run, 0 of 19 deposits were bumpable — expected, the calculator
  keeps earning powers current.)

To re-verify the §5 data bug, trace a deposit's events with `queryFilter` on
`StakeDeposited`/`StakeWithdrawn` (chunk getLogs over the block range) and compare
`Σ(deposited)−Σ(withdrawn)`, the last event's `depositBalance`, and
`deposits().balance` — they should all match each other and differ from the
stored `amount`.

---

## 7. Conventions

- TypeScript ESM run via `tsx` (no build step in practice; `tsc` is typecheck-only).
- `tsconfig` is `strict` with `noUncheckedIndexedAccess`. Honor it.
- Watch for **ethers v6** semantics: contracts use `.target`/`getAddress()` (not
  `.address`), and `contract.filters.X()` returns a deferred filter (no `.topics`).
- The codebase has many `as unknown as` casts that **hide ABI/type mismatches**
  (bug #4 was one). Be suspicious of them; prefer verifying decodes against chain.
- Prefer fixing ABIs in `src/configuration/abis.ts` (engines read fields by name,
  so a correct ABI fixes all callers at once).

---

## 8. Wind-down operations (what's actually running)

For the sunset, the full `src/` bot is shelved. Everything runs through small
scripts in `scripts/` + one workflow — none of them touch the monitor,
calculator, executor, DB, or the profitability engines.

### `scripts/claim.ts` — the keeper

Stateless: each run reads live chain state and decides whether to claim. Reuses
`CONFIG` and the (fixed) ABIs, nothing else.

- **Economic rule:** `claimAndDistributeReward(recipient, minExpected, depositIds)`
  on the LST makes the caller pay the fixed `payoutAmount` in reward token (the
  "distribute" to LST holders) and sends the claimed staking rewards to
  `recipient` (= the wallet). Self-sustaining as long as it only fires when
  rewards cover the payout. Profit is **not** a goal; gas is the only subsidy.
- **Trigger:** claims only when `Σ unclaimedReward ≥ payoutAmount + CLAIM_PROFIT_BUFFER`;
  otherwise logs `⏭️ skip` and exits 0. Deposit IDs are hardcoded (LST-owned 1–18;
  refresh from the DB if the set changes).
- **Safety:** report-only by **default** — sends only with `--broadcast`. Always
  `staticCall`s before sending (a bad encoding reverts in sim, not on-chain).
  `minExpected = total` (zero slippage tolerance).
- **Preconditions (first, every run):** wallet must have approved the LST and hold
  ≥ `payoutAmount` of reward token. Insufficient → **warn** in report-only,
  **fatal** under `--broadcast` (a misconfigured cron goes red, not silent).
- **Env knobs:** `CLAIM_PROFIT_BUFFER` (whole reward tokens via `parseEther` — `1`
  = 1 token, NOT raw units / no `1e18`), `MAX_GAS_PRICE_GWEI`, `CLAIM_GAS_LIMIT`,
  `CLAIM_RECIPIENT`, plus the standard required vars.
- **Logs** are emoji-tagged: 🔍 preflight · 💰 totals · ⏭️ skip · 👀 report-only ·
  🚀 submitting · 📤 sent · ✅/❌ confirmed/failed · ⚠️ warn · ❌ FATAL.

### `scripts/approve.ts` — one-off

Approves the LST for the wallet's reward token (`uint256.max`). Report-only by
default; `--broadcast` to send; idempotent (no-op if already max). Run once before
the keeper can claim.

### `.github/workflows/claim.yml` — the schedule

- Runs `claim.ts --broadcast` on an **hourly** cron (cranked up for validation;
  scale back to e.g. `0 */8 * * *` once proven) + a manual **workflow_dispatch**
  button that defaults to **report-only**.
- The cron and the dispatch button only work once the file is on the **default
  branch (`main`)** — on a feature branch there's no "Run workflow" button and the
  schedule won't fire.
- **Secrets:** `RPC_URL`, `PRIVATE_KEY`. Optional **Variable:** `CLAIM_PROFIT_BUFFER`.
  Public addresses (CHAIN_ID, staker, LST) are inlined in `env:`. Concurrency-
  guarded (no overlapping runs); `permissions: contents: read`.

### Operator runbook

1. Dedicated, low-balance **keeper wallet**; fund with gas + ~1 `payoutAmount` of
   reward token (working capital). Don't reuse the key elsewhere.
2. `tsx scripts/approve.ts --broadcast` once.
3. Add the two GitHub secrets; merge `claim.yml` to `main`.
4. Validate via the manual dispatch (report-only), then let the cron run.
5. Healthy steady state = green `⏭️ skip` runs until rewards cross the threshold,
   then a green run that actually claims (📤/✅). Red usually = under-funded wallet
   (a precondition throw); GitHub emails on scheduled-run failures.

> Not yet exercised: a real broadcast claim. As of the Node-24 upgrade the keeper
> was correctly **skipping** (unclaimed ~30.6 < 51 threshold); the first claim
> above threshold is the final end-to-end validation, though it is `staticCall`-gated.
