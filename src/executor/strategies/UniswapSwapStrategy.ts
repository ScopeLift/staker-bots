import { ethers } from 'ethers';
import { DefenderRelaySigner } from '@openzeppelin/defender-relay-client/lib/ethers';
import {
  ISwapStrategy,
  SwapConfig,
  SwapQuote,
} from '../interfaces/ISwapStrategy';
import { TransactionReceipt } from '../interfaces/types';
import { CONFIG } from '@/configuration';

// ABIs
const UNISWAP_ROUTER_ABI = [
  'function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) external returns (uint256[] memory amounts)',
  'function getAmountsOut(uint256 amountIn,address[] calldata path) external view returns (uint256[] memory amounts)',
] as const;

const ERC20_ABI = [
  'function approve(address spender,uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
] as const;

export class UniswapSwapStrategy implements ISwapStrategy {
  private readonly config: SwapConfig;
  private readonly signer: DefenderRelaySigner & ethers.Signer;
  private readonly tokenContract: ethers.Contract & {
    allowance(owner: string, spender: string): Promise<bigint>;
    approve(
      spender: string,
      amount: bigint,
    ): Promise<ethers.ContractTransactionResponse>;
  };
  private readonly routerContract: ethers.Contract & {
    swapExactTokensForETH(
      amountIn: bigint,
      amountOutMin: bigint,
      path: string[],
      to: string,
      deadline: number,
    ): Promise<ethers.ContractTransactionResponse>;
    getAmountsOut(amountIn: bigint, path: string[]): Promise<bigint[]>;
  };

  constructor(signer: DefenderRelaySigner & ethers.Signer) {
    this.signer = signer;
    this.config = CONFIG.executor.swap;

    if (!CONFIG.monitor.obolTokenAddress) {
      throw new Error('OBOL token address not configured');
    }

    if (!this.config.uniswapRouterAddress) {
      throw new Error('Uniswap router address not configured');
    }

    // Initialize contracts
    this.tokenContract = new ethers.Contract(
      CONFIG.monitor.obolTokenAddress,
      ERC20_ABI,
      signer,
    ) as typeof this.tokenContract;

    this.routerContract = new ethers.Contract(
      this.config.uniswapRouterAddress,
      UNISWAP_ROUTER_ABI,
      signer,
    ) as typeof this.routerContract;
  }

  async initialize(): Promise<void> {
    if (!this.config.enabled) return;

    // Check allowance and approve if needed
    const allowance = await this.getAllowance();
    if (allowance < this.config.maxAmountIn) {
      await this.approveRouter(this.config.maxAmountIn);
    }
  }

  async shouldSwap(tokenBalance: bigint): Promise<boolean> {
    if (!this.config.enabled) return false;

    return tokenBalance >= this.config.minAmountIn;
  }

  async getSwapQuote(amountIn: bigint): Promise<SwapQuote> {
    if (!CONFIG.monitor.obolTokenAddress) {
      throw new Error('OBOL token address not configured');
    }

    // Cap amount to max
    const actualAmountIn =
      amountIn > this.config.maxAmountIn ? this.config.maxAmountIn : amountIn;

    // Get path for swap
    const path = [CONFIG.monitor.obolTokenAddress, ethers.ZeroAddress];

    // Get expected output
    const amounts = await this.routerContract.getAmountsOut(
      actualAmountIn,
      path,
    );
    if (!amounts || amounts.length < 2 || !amounts[1]) {
      throw new Error('Invalid amounts returned from Uniswap');
    }

    // Calculate minimum output with slippage tolerance
    const amountOutMin =
      (amounts[1] *
        BigInt(Math.floor((100 - this.config.slippageTolerance) * 100))) /
      BigInt(10000);

    // Calculate deadline
    const deadline =
      Math.floor(Date.now() / 1000) + this.config.deadlineMinutes * 60;

    return {
      amountIn: actualAmountIn,
      amountOutMin,
      path,
      deadline,
    };
  }

  async executeSwap(quote: SwapQuote): Promise<TransactionReceipt> {
    const tx = await this.routerContract.swapExactTokensForETH(
      quote.amountIn,
      quote.amountOutMin,
      quote.path,
      await this.signer.getAddress(),
      quote.deadline,
    );

    const receipt = await tx.wait();
    if (!receipt) throw new Error('No receipt received from transaction');
    if (receipt.status === null) throw new Error('Transaction status is null');

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.gasPrice || 0n,
      status: receipt.status,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: [...log.topics], // Convert readonly array to mutable
        data: log.data,
      })),
    };
  }

  async getAllowance(): Promise<bigint> {
    return this.tokenContract.allowance(
      await this.signer.getAddress(),
      this.config.uniswapRouterAddress,
    );
  }

  async approveRouter(amount: bigint): Promise<TransactionReceipt> {
    const tx = await this.tokenContract.approve(
      this.config.uniswapRouterAddress,
      amount,
    );
    const receipt = await tx.wait();
    if (!receipt) throw new Error('No receipt received from transaction');
    if (receipt.status === null) throw new Error('Transaction status is null');

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.gasPrice || 0n,
      status: receipt.status,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: [...log.topics], // Convert readonly array to mutable
        data: log.data,
      })),
    };
  }
}
