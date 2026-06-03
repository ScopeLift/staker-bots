/**
 * One-off: approve the LST to spend the wallet's reward token, uint256.max.
 *
 * Required once before scripts/claim.ts can broadcast — `claimAndDistributeReward`
 * pulls `payoutAmount` from the caller via transferFrom, so the LST needs an
 * allowance. Max approval means it never has to be redone as the allowance is
 * consumed.
 *
 *   tsx scripts/approve.ts              # report-only: show what it would approve
 *   tsx scripts/approve.ts --broadcast  # send the approve transaction
 */
import { ethers } from 'ethers';
import { CONFIG } from '../src/configuration';

const BROADCAST = process.argv.includes('--broadcast');
const ts = () => new Date().toISOString();
const log = (m: string) => console.log(`[${ts()}] ${m}`);

async function main() {
  if (!CONFIG.executor.privateKey) throw new Error('PRIVATE_KEY is not set');
  if (!CONFIG.monitor.lstAddress) throw new Error('LST_ADDRESS is not set');

  const provider = new ethers.JsonRpcProvider(CONFIG.monitor.rpcUrl);
  const wallet = new ethers.Wallet(CONFIG.executor.privateKey, provider);

  const lst = new ethers.Contract(
    CONFIG.monitor.lstAddress,
    ['function REWARD_TOKEN() view returns (address)'],
    provider,
  );
  const rewardTokenAddress: string = await lst.REWARD_TOKEN();
  const token = new ethers.Contract(
    rewardTokenAddress,
    [
      'function allowance(address,address) view returns (uint256)',
      'function approve(address spender, uint256 value) returns (bool)',
    ],
    wallet,
  );

  const current: bigint = await token.allowance(
    wallet.address,
    CONFIG.monitor.lstAddress,
  );
  log(`reward token   ${rewardTokenAddress}`);
  log(`owner (wallet) ${wallet.address}`);
  log(`spender (LST)  ${CONFIG.monitor.lstAddress}`);
  log(
    `current allowance ${current === ethers.MaxUint256 ? 'MAX' : ethers.formatEther(current)}`,
  );

  if (current === ethers.MaxUint256) {
    log('already max-approved; nothing to do');
    return;
  }

  if (!BROADCAST) {
    log(
      'report-only (pass --broadcast to send): would approve(LST, uint256.max)',
    );
    return;
  }

  log('submitting approve(LST, uint256.max) ...');
  const tx = await token.approve(CONFIG.monitor.lstAddress, ethers.MaxUint256);
  log(`tx sent ${tx.hash}`);
  const rcpt = await tx.wait(1);
  log(
    `tx ${rcpt?.status === 1 ? 'CONFIRMED' : 'FAILED'} block ${rcpt?.blockNumber}`,
  );
}

main().catch((e) => {
  console.error(`[${ts()}] FATAL`, e);
  process.exit(1);
});
