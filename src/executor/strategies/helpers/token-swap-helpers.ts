import { Logger } from '@/monitor/logging';
import { ethers } from 'ethers';
import { CONFIG } from '@/configuration';
import { ErrorLogger } from '@/configuration/errorLogger';
import { pollForReceipt } from '@/configuration/helpers';

/**
 * Swaps tokens for ETH using Uniswap
 * @param lstContract Contract instance
 * @param relaySigner Signer instance
 * @param relayProvider Provider instance
 * @param logger Logger instance
 * @param errorLogger Error logger instance
 */
export async function swapTokensForEth(
  lstContract: ethers.Contract & { payoutAmount(): Promise<bigint> },
  relaySigner: ethers.Signer,
  relayProvider: ethers.Provider,
  logger: Logger,
  errorLogger: ErrorLogger,
): Promise<void> {
  if (
    !CONFIG.executor.swap.enabled ||
    !CONFIG.executor.swap.uniswapRouterAddress
  ) {
    logger.warn('Token swap not configured properly');
    return;
  }

  try {
    // Get the reward token address - first try contract, then fallback to config
    let rewardTokenAddress: string;
    try {
      // Check if REWARD_TOKEN is a function (most likely) or a property
      if (typeof lstContract.REWARD_TOKEN === 'function') {
        // Call it as a function
        const contractToken = await lstContract.REWARD_TOKEN();
        rewardTokenAddress = String(contractToken);
      } else {
        // Try accessing it as a property
        const contractToken = lstContract.REWARD_TOKEN;
        rewardTokenAddress = String(contractToken);
      }

      if (!rewardTokenAddress) {
        throw new Error('REWARD_TOKEN not found on contract');
      }

      logger.info('Retrieved reward token address from contract for swap', {
        address: rewardTokenAddress,
      });
    } catch (error) {
      // Fallback to config value
      rewardTokenAddress = CONFIG.profitability.rewardTokenAddress;
      if (!rewardTokenAddress) {
        throw new Error(
          'No reward token address available in contract or config',
        );
      }
      logger.info('Using reward token address from config for swap', {
        address: rewardTokenAddress,
      });
    }

    // Get relayer address
    const signerAddress = await relaySigner.getAddress();

    // Create token contract
    const tokenAbi = [
      'function balanceOf(address account) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)',
      'function decimals() view returns (uint8)',
    ] as const;

    const tokenContract = new ethers.Contract(
      rewardTokenAddress,
      tokenAbi,
      relaySigner,
    ) as ethers.Contract & {
      balanceOf(account: string): Promise<bigint>;
      approve(
        spender: string,
        amount: bigint,
      ): Promise<ethers.ContractTransactionResponse>;
      decimals(): Promise<number>;
    };

    // Create Uniswap router contract - use relaySigner directly
    const uniswapAbi = [
      'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
      'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)',
    ] as const;

    const uniswapRouter = new ethers.Contract(
      CONFIG.executor.swap.uniswapRouterAddress,
      uniswapAbi,
      relaySigner,
    ) as ethers.Contract & {
      swapExactTokensForETH(
        amountIn: bigint,
        amountOutMin: bigint,
        path: string[],
        to: string,
        deadline: number,
      ): Promise<ethers.ContractTransactionResponse>;
      getAmountsOut(amountIn: bigint, path: string[]): Promise<bigint[]>;
    };

    // Get token balance
    const tokenBalance = await tokenContract.balanceOf(signerAddress);
    const decimals = await tokenContract.decimals();
    const minKeepAmount = ethers.parseUnits('2200', decimals); // Always keep at least 2200 tokens

    logger.info('Current token balance', {
      balance: ethers.formatUnits(tokenBalance, decimals),
      minKeepAmount: ethers.formatUnits(minKeepAmount, decimals),
    });

    // Check if we have enough tokens to swap while maintaining minimum balance
    if (tokenBalance <= minKeepAmount) {
      logger.warn('Token balance too low for swap', {
        balance: ethers.formatUnits(tokenBalance, decimals),
        minKeepAmount: ethers.formatUnits(minKeepAmount, decimals),
      });
      return;
    }

    // Get contract's payout amount to ensure we don't go below it
    const payoutAmount = await lstContract.payoutAmount();

    // Calculate how much we can swap
    // We want to keep at least max(minKeepAmount, payoutAmount)
    const keepAmount =
      minKeepAmount > payoutAmount ? minKeepAmount : payoutAmount;
    const availableToSwap = tokenBalance - keepAmount;

    // Use half of available tokens, but not more than maxAmountIn
    let swapAmount = availableToSwap / 2n;
    if (swapAmount > CONFIG.executor.swap.maxAmountIn) {
      swapAmount = CONFIG.executor.swap.maxAmountIn;
    }

    // Check minimum swap amount
    if (swapAmount < CONFIG.executor.swap.minAmountIn) {
      logger.info('Swap amount below minimum threshold', {
        amount: ethers.formatUnits(swapAmount, decimals),
        minAmount: ethers.formatUnits(
          CONFIG.executor.swap.minAmountIn,
          decimals,
        ),
      });
      return;
    }

    // Set up the swap path and parameters
    const path = [rewardTokenAddress, ethers.ZeroAddress]; // Token -> ETH
    const deadline =
      Math.floor(Date.now() / 1000) + CONFIG.executor.swap.deadlineMinutes * 60;

    // Get expected ETH output
    const amountsOut = await uniswapRouter.getAmountsOut(swapAmount, path);
    if (!amountsOut || !Array.isArray(amountsOut) || amountsOut.length < 2) {
      throw new Error('Invalid amounts out from Uniswap');
    }

    // TypeScript safe access to the second element (ETH amount)
    const ethAmountRaw = amountsOut[1];
    if (!ethAmountRaw) {
      throw new Error('ETH output amount is undefined');
    }

    // Convert to BigInt to ensure type safety
    const expectedEthAmount = BigInt(ethAmountRaw.toString());

    // Apply slippage tolerance
    const slippageTolerance = CONFIG.executor.swap.slippageTolerance;
    const minOutputWithSlippage =
      (expectedEthAmount * BigInt(Math.floor((1 - slippageTolerance) * 1000))) /
      1000n;

    logger.info('Preparing token swap', {
      swapAmount: ethers.formatUnits(swapAmount, decimals),
      expectedEthOutput: ethers.formatEther(expectedEthAmount),
      minOutputWithSlippage: ethers.formatEther(minOutputWithSlippage),
      slippageTolerance: `${slippageTolerance * 100}%`,
    });

    // First approve the router to spend tokens
    const approveTx = await tokenContract.approve(
      CONFIG.executor.swap.uniswapRouterAddress,
      swapAmount,
    );

    logger.info('Approval transaction submitted', {
      hash: approveTx.hash,
    });

    // Wait for receipt
    const approvalReceipt = await pollForReceipt(
      approveTx.hash,
      relayProvider,
      logger,
      1,
    );

    if (!approvalReceipt || approvalReceipt.status !== 1) {
      throw new Error('Approval transaction failed');
    }

    logger.info('Approval confirmed', {
      hash: approveTx.hash,
      blockNumber: approvalReceipt.blockNumber,
    });

    // Execute the swap
    const swapTx = await uniswapRouter.swapExactTokensForETH(
      swapAmount,
      minOutputWithSlippage,
      path,
      signerAddress,
      deadline,
    );

    logger.info('Swap transaction submitted', {
      hash: swapTx.hash,
    });

    // Wait for swap to be mined
    const swapReceipt = await pollForReceipt(
      swapTx.hash,
      relayProvider,
      logger,
      1,
    );

    if (!swapReceipt) {
      throw new Error('No receipt returned from swap transaction');
    }

    logger.info('Token swap successful', {
      hash: swapTx.hash,
      gasUsed: swapReceipt.gasUsed?.toString(),
      blockNumber: swapReceipt.blockNumber,
      tokensSwapped: ethers.formatUnits(swapAmount, decimals),
    });
  } catch (error) {
    logger.error('Token swap failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    if (errorLogger) {
      errorLogger.error(
        error instanceof Error ? error : new Error(String(error)),
        {
          stage: 'relayer-executor-token-swap-error',
        },
      );
    }
  }
}

/**
 * Checks ETH balance and swaps tokens if needed
 */
export async function checkAndSwapTokensIfNeeded(
  lstContract: ethers.Contract & { payoutAmount(): Promise<bigint> },
  relaySigner: ethers.Signer,
  relayProvider: ethers.Provider,
  logger: Logger,
  errorLogger: ErrorLogger,
): Promise<void> {
  // Only proceed if swap is enabled
  if (!CONFIG.executor.swap.enabled) {
    return;
  }

  try {
    // Check relayer ETH balance
    const relayerBalance = await relayProvider.getBalance(
      await relaySigner.getAddress(),
    );

    if (!relayerBalance) {
      logger.warn('Unable to get relayer balance');
      return;
    }

    const minEthBalance = ethers.parseEther('0.1'); // 0.1 ETH threshold

    if (relayerBalance < minEthBalance) {
      logger.info(
        'Relayer ETH balance below threshold, attempting to swap tokens',
        {
          currentBalance: ethers.formatEther(relayerBalance),
          threshold: '0.1 ETH',
        },
      );

      await swapTokensForEth(
        lstContract,
        relaySigner,
        relayProvider,
        logger,
        errorLogger,
      );
    }
  } catch (error) {
    logger.error('Failed to check ETH balance', {
      error: error instanceof Error ? error.message : String(error),
    });

    if (errorLogger) {
      errorLogger.error(
        error instanceof Error ? error : new Error(String(error)),
        {
          stage: 'relayer-executor-check-eth-balance',
        },
      );
    }
  }
}
