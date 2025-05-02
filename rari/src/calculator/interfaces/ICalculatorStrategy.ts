export interface ICalculatorStrategy {
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

  processScoreEvents(fromBlock: number, toBlock: number): Promise<void>;
}
