import { ICalculatorStrategy } from './interfaces/ICalculatorStrategy';
import { BinaryEligibilityOracleEarningPowerCalculator } from './strategies/BinaryEligibilityOracleEarningPowerCalculator';
import { CalculatorConfig, CalculatorStatus } from './interfaces/types';
import { IDatabase } from '@/database';
import { ethers } from 'ethers';

export class CalculatorWrapper implements ICalculatorStrategy {
  private strategy: ICalculatorStrategy;
  private isRunning: boolean;
  private lastProcessedBlock: number;

  constructor(
    db: IDatabase,
    provider: ethers.Provider,
    config: CalculatorConfig = { type: 'binary' },
  ) {
    // Initialize with BinaryEligibilityOracleEarningPowerCalculator strategy by default
    this.strategy = new BinaryEligibilityOracleEarningPowerCalculator(
      db,
      provider,
    );
    this.isRunning = false;
    this.lastProcessedBlock = 0;

    // Can extend here to support other calculator types
    if (config.type !== 'binary') {
      throw new Error(`Calculator type ${config.type} not supported`);
    }
  }

  async start(): Promise<void> {
    this.isRunning = true;
  }

  async stop(): Promise<void> {
    this.isRunning = false;
  }

  async getStatus(): Promise<CalculatorStatus> {
    return {
      isRunning: this.isRunning,
      lastProcessedBlock: this.lastProcessedBlock,
    };
  }

  async getEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string,
  ): Promise<bigint> {
    return this.strategy.getEarningPower(amountStaked, staker, delegatee);
  }

  async getNewEarningPower(
    amountStaked: bigint,
    staker: string,
    delegatee: string,
    oldEarningPower: bigint,
  ): Promise<[bigint, boolean]> {
    return this.strategy.getNewEarningPower(
      amountStaked,
      staker,
      delegatee,
      oldEarningPower,
    );
  }

  async processScoreEvents(fromBlock: number, toBlock: number): Promise<void> {
    await this.strategy.processScoreEvents(fromBlock, toBlock);
    this.lastProcessedBlock = toBlock;
  }

  /**
   * Get the earning power calculator instance
   */
  getEarningPowerCalculator(): BinaryEligibilityOracleEarningPowerCalculator | null {
    return this.strategy instanceof
      BinaryEligibilityOracleEarningPowerCalculator
      ? this.strategy
      : null;
  }
}
