import { ethers } from "ethers";

export interface ScoreEvent {
  delegatee: string;
  score: bigint;
  block_number: number;
  created_at?: string;
  updated_at?: string;
}

export interface CalculatorConfig {
  type: "binary" | string; // Extensible for future calculator types
}

export interface CalculatorStatus {
  isRunning: boolean;
  lastProcessedBlock: number;
}

export interface IRewardCalculator {
  getEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string,
  ): Promise<bigint>;

  getNewEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string,
    oldEarningPower: bigint,
  ): Promise<[bigint, boolean]>;

  filters: {
    DelegateeScoreUpdated: () => ethers.EventFilter;
  };

  queryFilter(
    event: ethers.EventFilter,
    fromBlock?: number,
    toBlock?: number,
  ): Promise<ethers.Log[]>;
}
