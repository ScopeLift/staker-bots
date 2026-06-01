/**
 * READ-ONLY bumpability check.
 *
 * Determines which deposits would currently accept a `bumpEarningPower` call,
 * WITHOUT ever sending a transaction. It creates no signer and only performs
 * `view` calls and `staticCall` simulations, so it cannot submit anything.
 *
 * Deposit IDs come from the local JSON DB; all state (balance, earning power,
 * delegatee) is read live from chain. Run with:
 *
 *   tsx scripts/check-bumpable.ts
 */
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../src/configuration';
import { stakerAbi } from '../src/configuration/abis';
import { REWARD_CALCULATOR_ABI } from '../src/calculator/constants';

const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);
const staker = new ethers.Contract(CONFIG.monitor.stakerAddress, stakerAbi, provider);
const calculator = new ethers.Contract(
  CONFIG.monitor.rewardCalculatorAddress,
  REWARD_CALCULATOR_ABI,
  provider,
);
const tipReceiver = CONFIG.executor.tipReceiver || ethers.ZeroAddress;

const ETH = (v: bigint) => ethers.formatEther(v);

function loadDepositIds(): string[] {
  const dbPath = path.resolve(process.cwd(), 'data', 'rari-staker-monitor-db.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  return Object.values(db.deposits ?? {}).map((d: any) => String(d.deposit_id));
}

async function main() {
  const block = await provider.getBlockNumber();
  const ids = loadDepositIds();
  console.log(
    `Checking ${ids.length} deposits at block ${block} on chain ${
      (await provider.getNetwork()).chainId
    }\n`,
  );

  const bumpable: string[] = [];

  for (const id of ids) {
    try {
      const d = await staker.deposits(BigInt(id)); // [owner, balance, earningPower, delegatee, claimer]
      const [newEP, qualified] = await calculator.getNewEarningPower(
        d.balance,
        d.owner,
        d.delegatee,
        d.earningPower,
      );
      const epWouldChange = newEP !== d.earningPower;

      // Ground truth: would a tip=0 bump succeed against the live contract right now?
      let wouldSucceed = false;
      let revert = '';
      try {
        await staker.bumpEarningPower.staticCall(BigInt(id), tipReceiver, 0n);
        wouldSucceed = true;
      } catch (e: any) {
        revert = (e?.shortMessage || e?.reason || e?.message || '').slice(0, 140);
      }

      const flag = wouldSucceed
        ? '✅ BUMPABLE'
        : qualified && epWouldChange
          ? '⚠️  EP changes but bump reverts'
          : '—  not bumpable';

      console.log(`#${id}  ${flag}`);
      console.log(
        `     balance=${ETH(d.balance)}  curEP=${ETH(d.earningPower)}  newEP=${ETH(
          newEP,
        )}  qualified=${qualified}  unclaimed=${ETH(await staker.unclaimedReward(BigInt(id)))}`,
      );
      if (!wouldSucceed && revert) console.log(`     staticCall revert: ${revert}`);

      if (wouldSucceed) bumpable.push(id);
    } catch (e: any) {
      console.log(`#${id}  ERROR: ${e?.shortMessage || e?.message}`);
    }
  }

  console.log(
    `\n${bumpable.length} of ${ids.length} deposit(s) would bump right now: ${
      bumpable.join(', ') || '(none)'
    }`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
