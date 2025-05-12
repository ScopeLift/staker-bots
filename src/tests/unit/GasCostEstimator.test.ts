import { describe, it, expect } from '@jest/globals';
import { ethers } from 'ethers';
import { GasCostEstimator } from '../../prices/GasCostEstimator';
import { CONFIG } from '../../configuration';
import { ConsoleLogger } from '@/monitor/logging';

describe('GasCostEstimator', () => {
  const logger = new ConsoleLogger('debug');

  it('should calculate total cost with gas and profit margin', async () => {
    // Create a mock provider that returns known gas values for consistent testing
    const mockProvider = {
      getFeeData: async () => ({
        gasPrice: ethers.parseUnits('20', 'gwei'), // 20 gwei = 0.00000002 ETH
        maxFeePerGas: ethers.parseUnits('25', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
      }),
    } as unknown as ethers.Provider;

    // Create estimator instance (this will use the real CoinmarketcapFeed)
    const estimator = new GasCostEstimator();

    // Constants from RelayerExecutor logic
    const BASE_AMOUNT =
      2200n * 10n ** BigInt(CONFIG.govlst.rewardTokenDecimals); // Base payout amount in token decimals
    const PROFIT_MARGIN_BPS = 1000n; // 10% = 1000 basis points
    const GAS_LIMIT = 300000n; // Standard gas limit

    try {
      // Step 1: Get gas cost in reward tokens
      const gasCostInTokens = await estimator.estimateGasCostInRewardToken(
        mockProvider,
        GAS_LIMIT,
      );

      logger.info('Gas cost calculation', {
        gasCostInTokens: gasCostInTokens.toString(),
        gasCostFormatted: ethers.formatUnits(
          gasCostInTokens,
          CONFIG.govlst.rewardTokenDecimals,
        ),
        gasLimit: GAS_LIMIT.toString(),
        gasPriceGwei: '20', // From mock provider
        estimatedGasEth: ethers.formatEther(
          GAS_LIMIT * ethers.parseUnits('20', 'gwei'),
        ),
      });

      // Step 2: Calculate base amount including gas cost
      const baseAmountWithGas = BASE_AMOUNT + gasCostInTokens;

      logger.info('Base amount with gas', {
        baseAmount: ethers.formatUnits(
          BASE_AMOUNT,
          CONFIG.govlst.rewardTokenDecimals,
        ),
        baseAmountRaw: BASE_AMOUNT.toString(),
        withGas: ethers.formatUnits(
          baseAmountWithGas,
          CONFIG.govlst.rewardTokenDecimals,
        ),
        withGasRaw: baseAmountWithGas.toString(),
        gasCostInTokens: ethers.formatUnits(
          gasCostInTokens,
          CONFIG.govlst.rewardTokenDecimals,
        ),
        gasCostRaw: gasCostInTokens.toString(),
      });

      // Step 3: Calculate profit margin amount
      // Round up the profit margin amount to ensure we get exactly 10%
      const profitMarginAmount =
        (baseAmountWithGas * PROFIT_MARGIN_BPS + 9999n) / 10000n;

      logger.info('Profit margin calculation', {
        profitMarginBps: PROFIT_MARGIN_BPS.toString(),
        profitMarginAmount: ethers.formatUnits(
          profitMarginAmount,
          CONFIG.govlst.rewardTokenDecimals,
        ),
        profitMarginAmountRaw: profitMarginAmount.toString(),
        baseForCalculation: ethers.formatUnits(
          baseAmountWithGas,
          CONFIG.govlst.rewardTokenDecimals,
        ),
        baseForCalculationRaw: baseAmountWithGas.toString(),
        effectivePercentage: `${(Number(PROFIT_MARGIN_BPS) / 100).toFixed(2)}%`,
      });

      // Step 4: Calculate final threshold
      const finalThreshold = baseAmountWithGas + profitMarginAmount;

      logger.info('Final threshold calculation', {
        finalThreshold: ethers.formatUnits(
          finalThreshold,
          CONFIG.govlst.rewardTokenDecimals,
        ),
        finalThresholdRaw: finalThreshold.toString(),
        components: {
          baseAmount: ethers.formatUnits(
            BASE_AMOUNT,
            CONFIG.govlst.rewardTokenDecimals,
          ),
          baseAmountRaw: BASE_AMOUNT.toString(),
          gasCost: ethers.formatUnits(
            gasCostInTokens,
            CONFIG.govlst.rewardTokenDecimals,
          ),
          gasCostRaw: gasCostInTokens.toString(),
          profitMargin: ethers.formatUnits(
            profitMarginAmount,
            CONFIG.govlst.rewardTokenDecimals,
          ),
          profitMarginRaw: profitMarginAmount.toString(),
        },
        summary: {
          totalInTokens: ethers.formatUnits(
            finalThreshold,
            CONFIG.govlst.rewardTokenDecimals,
          ),
          gasInEth: ethers.formatEther(
            GAS_LIMIT * ethers.parseUnits('20', 'gwei'),
          ),
          profitMarginPercent: `${(Number(PROFIT_MARGIN_BPS) / 100).toFixed(2)}%`,
        },
      });

      // Assertions to verify the calculation
      expect(finalThreshold).toBeGreaterThan(baseAmountWithGas);
      expect(finalThreshold).toBeGreaterThan(BASE_AMOUNT);
      expect(profitMarginAmount).toBeGreaterThan(0n);
      expect(gasCostInTokens).toBeGreaterThan(0n);

      // Verify the profit margin is exactly 10%
      const actualProfitMargin =
        (profitMarginAmount * 10000n) / baseAmountWithGas;
      expect(actualProfitMargin).toBeGreaterThanOrEqual(PROFIT_MARGIN_BPS);

      // Log the actual ETH to Token conversion rate
      const ethToTokenRate =
        Number(gasCostInTokens) /
        Number(GAS_LIMIT * ethers.parseUnits('20', 'gwei'));
      logger.info('ETH to Token conversion rate', {
        rate: ethToTokenRate,
        interpretation: `1 ETH = ${ethToTokenRate} Tokens`,
        gasDetails: {
          gasLimitUsed: GAS_LIMIT.toString(),
          gasPriceGwei: '20',
          totalGasEth: ethers.formatEther(
            GAS_LIMIT * ethers.parseUnits('20', 'gwei'),
          ),
          equivalentInTokens: ethers.formatUnits(
            gasCostInTokens,
            CONFIG.govlst.rewardTokenDecimals,
          ),
        },
      });
    } catch (error) {
      logger.error('Test failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  });
});
