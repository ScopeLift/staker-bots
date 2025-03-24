import { ethers } from 'ethers';
import { RewardDeposit } from '../interfaces/types';
import { STAKER_CLAIM_ABI } from '../constants';
import { ConsoleLogger, Logger } from '@/monitor/logging';

// Define the contract type to avoid linter errors
type StakerContract = ethers.Contract & {
  unclaimedReward(depositId: string | bigint): Promise<bigint>;
  deposits(depositId: string | bigint): Promise<{
    owner: string;
    balance: bigint;
    earningPower: bigint;
    delegatee: string;
    claimer: string;
  }>;
};

/**
 * Calculate unclaimed rewards for a list of deposits
 */
export async function calculateUnclaimedRewards(
  stakerContract: StakerContract,
  depositIds: string[],
  logger: Logger = new ConsoleLogger('info')
): Promise<Map<string, bigint>> {
  const rewards = new Map<string, bigint>();

  for (const depositId of depositIds) {
    try {
      // Get unclaimed rewards for this deposit
      const unclaimedReward = await stakerContract.unclaimedReward(depositId);

      // Store rewards
      rewards.set(depositId, unclaimedReward);

      logger.debug('Calculated unclaimed reward:', {
        depositId,
        unclaimedReward: unclaimedReward.toString()
      });
    } catch (error) {
      logger.error(`Failed to get unclaimed rewards for deposit ${depositId}`, { error });
      // Set reward to 0 for failed calculations
      rewards.set(depositId, BigInt(0));
    }
  }

  return rewards;
}

/**
 * Verify that deposits are owned by the expected GovLst contract
 */
export async function verifyDepositOwnership(
  stakerContract: StakerContract,
  depositIds: string[],
  expectedOwner: string,
  logger: Logger = new ConsoleLogger('info')
): Promise<string[]> {
  const validDepositIds: string[] = [];

  for (const depositId of depositIds) {
    try {
      // Get deposit information
      const { owner } = await stakerContract.deposits(depositId);

      // Normalize addresses for comparison
      const normalizedOwner = owner.toLowerCase();
      const normalizedExpected = expectedOwner.toLowerCase();

      // Check if owner matches expected owner
      if (normalizedOwner === normalizedExpected) {
        validDepositIds.push(depositId);
      } else {
        logger.warn('Deposit owner mismatch:', {
          depositId,
          actualOwner: normalizedOwner,
          expectedOwner: normalizedExpected
        });
      }
    } catch (error) {
      logger.error(`Failed to verify ownership for deposit ${depositId}`, { error });
    }
  }

  return validDepositIds;
}

/**
 * Sort deposits by unclaimed reward amount (descending)
 */
export function sortDepositsByReward(
  depositRewards: Map<string, bigint>
): string[] {
  // Convert to array for sorting
  const entries = Array.from(depositRewards.entries());

  // Sort by reward amount (descending)
  entries.sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));

  // Return sorted deposit IDs
  return entries.map(entry => entry[0]);
}

/**
 * Calculate total unclaimed rewards for a list of deposits
 */
export function calculateTotalRewards(
  depositIds: string[],
  depositRewards: Map<string, bigint>
): bigint {
  let totalRewards = BigInt(0);

  for (const depositId of depositIds) {
    const reward = depositRewards.get(depositId) || BigInt(0);
    totalRewards += reward;
  }

  return totalRewards;
}
