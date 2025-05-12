import { TransactionReceipt } from './types';

export interface SwapConfig {
  enabled: boolean;
  uniswapRouterAddress: string;
  slippageTolerance: number; // in percentage (e.g., 0.5 for 0.5%)
  deadlineMinutes: number; // minutes until transaction deadline
  minAmountIn: bigint; // minimum amount to trigger swap
  maxAmountIn: bigint; // maximum amount to swap at once
  tokenDecimals: number;
}

export interface SwapQuote {
  amountIn: bigint;
  amountOutMin: bigint;
  path: string[];
  deadline: number;
}

export interface ISwapStrategy {
  /**
   * Initialize the swap strategy
   */
  initialize(): Promise<void>;

  /**
   * Check if swap should be executed
   */
  shouldSwap(tokenBalance: bigint): Promise<boolean>;

  /**
   * Get swap quote from Uniswap
   */
  getSwapQuote(amountIn: bigint): Promise<SwapQuote>;

  /**
   * Execute token swap to ETH
   */
  executeSwap(quote: SwapQuote): Promise<TransactionReceipt>;

  /**
   * Get current token allowance for router
   */
  getAllowance(): Promise<bigint>;

  /**
   * Approve router to spend tokens
   */
  approveRouter(amount: bigint): Promise<TransactionReceipt>;
}
