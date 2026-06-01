# AGENTS.md

Context and working notes for AI agents (and humans) working on this repo. Last
substantive update: 2026-06-01.

This file captures hard-won context that is **not obvious from the code**:
domain semantics, environment setup, bugs already found/fixed, and the
known-outstanding issues — most importantly a data-accuracy bug in the monitor
with a validated fix described at the end.

---

## 1. What this repo is

A **GovLst staking keeper bot** that runs against **RARI Chain**
(`chainId 1380012617` = `0x52415249` = ASCII "RARI"). It monitors a Staker
contract, decides when keeper actions are profitable, and (when enabled) signs
and submits transactions.

Key on-chain actors (observed at runtime; sourced from env / `src/configuration`):

| Role | Address | Notes |
|---|---|---|
| Staker | `0xfb0dF2b1Ca894BFdC0e3a200a26B87C5b348CeB6` | RariStaker, **deployed at block 2714010** |
| GovLst / LST token | `0xf5b1009B9B5e36346f4A6B586FA35d02996703bf` | custodies pooled stake; `owner` of most deposits |
| Reward calculator | `0xAc5315251B91D2Fa4bf61cE479DF792778A7f464` | binary eligibility oracle (`DelegateeScoreUpdated`) |
| Default delegatee | `0x0000000000000000000000000000000000000B01` | fallback for GovLst-owned deposits |

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
> sends a transaction.

Components are selected via `COMPONENTS=` (e.g. `monitor,executor,profitability,bump,claim`),
wired together in `src/index.ts`.

---

## 2. Dev environment

- **Toolchain is pinned with Volta** in `package.json`: Node **20.20.2**, pnpm
  **9.15.9**. (Volta 2.x manages pnpm without the old `VOLTA_FEATURE_PNPM` flag.)
- The committed lockfile is `lockfileVersion: 9.0` (pnpm ≥ 9). CI
  (`.github/workflows/code-quality.yml`) was bumped from pnpm 8 → 9 to match.
- If `node -v` doesn't show 20.20.2 inside the repo, another version manager
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
  *"ESLint couldn't find a configuration file."* Prettier and `tsc` are fine.
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
   Effect: `depositState.balance` decoded the owner *address* as a ~1.4e48
   number, and `depositState.owner` was garbage. This fed the bump engine's
   `isBumpProfitable` (which reads `depositState.balance`/`.owner` and passes them
   to the calculator), producing bogus "earning power changed" results — every
   such bump would revert on-chain (and, since pre-encoded txs skip simulation in
   `BaseExecutor`, could be *sent* and burn gas). Fixed at `abis.ts:90`. Engines
   access fields by name, so the one-line ABI change corrects the runtime decode
   everywhere.

### Verified, NOT a bug
- "Many deposits have the same balance" was a *symptom* of bug #4: the displayed
  "balance" was really the `owner` address, and deposits #1–#18 are all owned by
  the LST (`0xf5b1009…703bf`), so they shared a value. Real balances differ.

---

## 4. Known / outstanding issues (not yet fixed)

Highest-impact first. None of these are addressed in code yet.

- **Monitor stores wrong deposit balances** — see §5 (the main one).
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

## 5. Monitor deposit-balance bug + proposed fix

### Symptom
Stored `amount` in `data/*.json` does **not** match on-chain balances:

| deposit | stored `amount` | true on-chain balance |
|---|---|---|
| #1 | 1619.40 | 6016.03 |
| #5 | 22694.82 | 46237.48 |

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
or reprocess. Note the bot's *live* reads (bump uses the now-fixed `deposits()`
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
