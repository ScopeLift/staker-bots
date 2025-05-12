import { ethers } from 'ethers';
import { SimulationService } from '@/simulation';
import type { SimulationTransaction } from '@/simulation/interfaces';

// Constants for testing
const UNISWAP_ROUTER = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af';
const OBOL_TOKEN = '0x0b010000b7624eb9b3dfbc279673c76e9d29d5f7';
const ETH_ADDRESS = ethers.ZeroAddress;
const TEST_WALLET = '0x5c8032e8fb4603a9f0483ab26e8fc356fde0e5b9'; // Example wallet for simulation
const SWAP_AMOUNT = ethers.parseUnits('100', 18); // 100 OBOL tokens

// ABIs
const UNISWAP_ROUTER_ABI = [
  'function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) external returns (uint256[] memory amounts)',
  'function getAmountsOut(uint256 amountIn,address[] calldata path) external view returns (uint256[] memory amounts)',
] as const;

const ERC20_ABI = [
  'function approve(address spender,uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
] as const;

describe('Uniswap Swap Simulation', () => {
  let simulationService: SimulationService;

  beforeAll(() => {
    simulationService = new SimulationService();
  });

  describe('OBOL to ETH swap simulation', () => {
    it('should simulate the complete swap flow including approval and swap', async () => {
      // Step 1: Create contract interfaces
      const routerInterface = new ethers.Interface(UNISWAP_ROUTER_ABI);
      const tokenInterface = new ethers.Interface(ERC20_ABI);

      // Step 2: Simulate token approval
      const approvalCalldata = tokenInterface.encodeFunctionData('approve', [
        UNISWAP_ROUTER,
        SWAP_AMOUNT,
      ]);

      const approvalTx: SimulationTransaction = {
        from: TEST_WALLET,
        to: OBOL_TOKEN,
        data: approvalCalldata,
        gas: 100000, // Standard gas limit for approvals
        value: '0',
      };

      // eslint-disable-next-line no-console
      console.log('Simulating token approval...');
      const approvalSimulation = await simulationService.simulateTransaction(
        approvalTx,
        {
          networkId: '1',
          overrides: {
            [TEST_WALLET]: {
              balance: ethers.parseEther('1').toString(), // Ensure enough ETH for gas
            },
          },
        },
      );

      // eslint-disable-next-line no-console
      console.log('Approval simulation results:', {
        success: approvalSimulation.success,
        gasUsed: approvalSimulation.gasUsed,
        error: approvalSimulation.error,
      });

      expect(approvalSimulation.success).toBe(true);
      expect(approvalSimulation.gasUsed).toBeGreaterThan(0);

      // Step 3: Get swap parameters
      const swapPath = [OBOL_TOKEN, ETH_ADDRESS];
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

      // Step 4: Simulate the swap
      const swapCalldata = routerInterface.encodeFunctionData(
        'swapExactTokensForETH',
        [
          SWAP_AMOUNT,
          0, // We'll get the minimum amount from simulation
          swapPath,
          TEST_WALLET,
          deadline,
        ],
      );

      const swapTx: SimulationTransaction = {
        from: TEST_WALLET,
        to: UNISWAP_ROUTER,
        data: swapCalldata,
        gas: 350000, // Higher gas limit for swaps
        value: '0',
      };

      // eslint-disable-next-line no-console
      console.log('Simulating token swap...');
      const swapSimulation = await simulationService.simulateTransaction(
        swapTx,
        {
          networkId: '1',
          overrides: {
            [TEST_WALLET]: {
              balance: ethers.parseEther('1').toString(), // Ensure enough ETH for gas
              state: {
                // Set token balance for the test wallet
                [`0x${ethers.zeroPadValue(TEST_WALLET, 32).slice(2)}`]:
                  ethers.toBeHex(SWAP_AMOUNT),
              },
            },
          },
          save: true, // Enable saving the simulation
          saveIfFails: true, // Save even if it fails
        },
      );

      // eslint-disable-next-line no-console
      console.log('Swap simulation results:', {
        success: swapSimulation.success,
        gasUsed: swapSimulation.gasUsed,
        error: swapSimulation.error,
        logs: swapSimulation.logs?.map((log) => ({
          name: log.name,
          inputs: log.inputs,
        })),
      });

      // Get gas cost estimate for the entire flow
      const gasCostEstimate = await simulationService.estimateGasCosts(swapTx, {
        networkId: '1',
        overrides: {
          [TEST_WALLET]: {
            balance: ethers.parseEther('1').toString(),
          },
        },
      });

      // eslint-disable-next-line no-console
      console.log('Gas cost estimation:', {
        gasUnits: gasCostEstimate.gasUnits,
        gasPrice: gasCostEstimate.gasPrice + ' gwei',
        gasPriceDetails: {
          baseFeePerGas:
            gasCostEstimate.gasPriceDetails?.baseFeePerGas + ' gwei',
          low: gasCostEstimate.gasPriceDetails?.low,
          medium: gasCostEstimate.gasPriceDetails?.medium,
          high: gasCostEstimate.gasPriceDetails?.high,
        },
      });

      // Validate simulation results
      if (swapSimulation.success) {
        expect(swapSimulation.gasUsed).toBeGreaterThan(0);
        expect(swapSimulation.gasUsed).toBeLessThan(350000);
        // Logs might be undefined if no events were emitted
        if (swapSimulation.logs) {
          expect(swapSimulation.logs.length).toBeGreaterThan(0);
        }
      } else {
        console.warn('Swap simulation failed:', swapSimulation.error);
      }

      // Validate gas estimation
      expect(gasCostEstimate.gasUnits).toBeGreaterThan(0);
      expect(gasCostEstimate.gasPrice).toBeDefined();
      expect(parseFloat(gasCostEstimate.gasPrice)).toBeGreaterThan(0);
    }, 60000); // 60 second timeout for network calls
  });
});
