/// <reference types="jest" />
import { SimulationService } from '@/simulation';
import { CONFIG } from '@/configuration';
import { ethers } from 'ethers';
import type {
  SimulationTransaction,
  SimulationOptions,
} from '@/simulation/interfaces';

// Create a real provider for testing
async function createTestProvider(): Promise<ethers.JsonRpcProvider> {
  if (!CONFIG.tenderly.accessKey) {
    throw new Error(
      'Missing required TENDERLY_ACCESS_KEY environment variable',
    );
  }

  // Use Tenderly's mainnet gateway with access key
  const url = `https://mainnet.gateway.tenderly.co/${CONFIG.tenderly.accessKey}`;

  // Create a provider with proper headers
  const network = await ethers.Network.from('mainnet');
  const provider = new ethers.JsonRpcProvider(url, undefined, {
    staticNetwork: network,
  });

  // Add custom request function to handle Tenderly-specific methods
  const originalRequest = provider._send;
  provider._send = async function (
    payload: ethers.JsonRpcPayload | Array<ethers.JsonRpcPayload>,
  ): Promise<Array<ethers.JsonRpcResult>> {
    // Handle array of requests
    if (Array.isArray(payload)) {
      return originalRequest.call(provider, payload);
    }

    // Handle Tenderly simulation
    if (payload.method === 'tenderly_simulateTransaction') {
      const response = await fetch(
        `https://mainnet.gateway.tenderly.co/${CONFIG.tenderly.accessKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            id: payload.id,
            jsonrpc: '2.0',
            method: 'tenderly_simulateTransaction',
            params: payload.params,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Simulation failed: ${await response.text()}`);
      }

      const result = await response.json();
      return [
        {
          id: payload.id,
          result: result.result,
        },
      ] as Array<ethers.JsonRpcResult>;
    }

    // For all other requests, use the normal provider
    return originalRequest.call(provider, payload);
  };

  return provider;
}

describe('SimulationService Integration Tests', () => {
  const GOVLST_ADDRESS = '0x1932e815254c53b3ecd81cecf252a5ac7f0e8bea';
  const RECIPIENT_ADDRESS = '0x5c8032e8fb4603a9f0483ab26e8fc356fde0e5b9';
  const MIN_EXPECTED_REWARD = '2420000000000000000000'; // 2420 tokens
  const GAS_LIMIT = 5_000_000; // 5M gas limit
  const AVERAGE_GAS = 3_000_000; // 3M average gas usage
  const DEPOSIT_IDS = [
    2n,
    20n,
    32n,
    12n,
    251n,
    37n,
    3n,
    249n,
    1n,
    88n,
    274n,
    34n,
    22n,
    8n,
    63n,
    45n,
    5n,
    187n,
    216n,
    193n,
    244n,
    267n,
    59n,
    257n,
    240n,
    282n,
    237n,
    189n,
    233n,
    205n,
    71n,
    228n,
    230n,
    41n,
    224n,
    201n,
    229n,
    275n,
    260n,
    118n,
    285n,
    226n,
    239n,
    17n,
    10n,
    199n,
    183n,
    258n,
    13n,
    232n,
    25n,
    281n,
    166n,
    263n,
    15n,
    280n,
    43n,
    16n,
    9n,
    293n,
    7n,
    211n,
    261n,
    27n,
    14n,
    207n,
    33n,
    60n,
    204n,
    254n,
    194n,
    234n,
    56n,
    11n,
    214n,
    287n,
    288n,
    289n,
    290n,
    253n,
    292n,
    291n,
    26n,
    262n,
    271n,
    247n,
    38n,
    173n,
    236n,
    107n,
    192n,
    231n,
    94n,
    18n,
    4n,
    67n,
    29n,
    92n,
    198n,
  ];

  let service: SimulationService;
  let provider: ethers.JsonRpcProvider;

  beforeAll(async () => {
    provider = await createTestProvider();
    service = new SimulationService();

    // Wait for provider to be ready
    await provider.ready;
  });

  afterAll(async () => {
    // Clean up provider
    await provider.destroy();
  });

  describe('constructor', () => {
    it('should initialize with valid configuration', () => {
      expect(() => new SimulationService()).not.toThrow();
    });

    it('should verify API connection', async () => {
      // Test a simple RPC call to verify connection
      const network = await provider.getNetwork();
      expect(network.chainId).toBeGreaterThan(0);
    });
  });

  describe('simulateTransaction', () => {
    it('should simulate a simple ETH transfer', async () => {
      const transaction: SimulationTransaction = {
        from: RECIPIENT_ADDRESS,
        to: GOVLST_ADDRESS,
        value: ethers.parseEther('0.1').toString(),
        gas: 21000,
      };

      const result = await service.simulateTransaction(transaction, {
        networkId: '1', // mainnet
        save: true,
        saveIfFails: true,
      });

      // eslint-disable-next-line no-console
      console.log('ETH transfer simulation result:', {
        success: result.success,
        gasUsed: result.gasUsed,
        error: result.error,
        hasTrace: !!result.trace,
      });

      // The simulation might fail if the account doesn't have enough balance
      // That's expected and we should handle both success and failure cases
      if (result.success) {
        expect(result.gasUsed).toBeGreaterThan(0);
        expect(result.trace).toBeDefined();
      } else {
        expect(result.error?.code).toBe('INSUFFICIENT_FUNDS');
      }
    }, 30000);

    it('should simulate with state overrides', async () => {
      const transaction: SimulationTransaction = {
        from: RECIPIENT_ADDRESS,
        to: GOVLST_ADDRESS,
        value: ethers.parseEther('0.1').toString(),
        gas: 21000,
      };

      const options: SimulationOptions = {
        networkId: '1', // mainnet
        overrides: {
          [RECIPIENT_ADDRESS]: {
            balance: ethers.parseEther('10').toString(),
            nonce: 5,
          },
        },
        save: true,
        saveIfFails: true,
      };

      const result = await service.simulateTransaction(transaction, options);
      // eslint-disable-next-line no-console
      console.log('State override simulation result:', {
        success: result.success,
        gasUsed: result.gasUsed,
        error: result.error,
      });

      // With balance override, the transaction should succeed
      expect(result.success).toBe(true);
      expect(result.gasUsed).toBeGreaterThan(0);
    }, 30000);

    it('should simulate contract interaction', async () => {
      const iface = new ethers.Interface([
        'function claimAndDistributeReward(address _recipient, uint256 _minExpectedReward, uint256[] _depositIds)',
      ]);

      const calldata = iface.encodeFunctionData('claimAndDistributeReward', [
        RECIPIENT_ADDRESS,
        MIN_EXPECTED_REWARD,
        DEPOSIT_IDS,
      ]);

      const transaction: SimulationTransaction = {
        from: RECIPIENT_ADDRESS,
        to: GOVLST_ADDRESS,
        data: calldata,
        gas: GAS_LIMIT, // Using 5M gas limit constant
      };

      const result = await service.simulateTransaction(transaction, {
        networkId: '1', // mainnet
        save: true,
        saveIfFails: true,
        overrides: {
          [RECIPIENT_ADDRESS]: {
            balance: ethers.parseEther('1').toString(), // Ensure enough ETH for gas
          },
        },
      });

      // eslint-disable-next-line no-console
      console.log('Contract interaction details:', {
        transaction: {
          from: transaction.from,
          to: transaction.to,
          gas: transaction.gas,
          data: transaction.data?.slice(0, 66) + '...', // Show first 32 bytes of calldata
        },
        result: {
          success: result.success,
          gasUsed: result.gasUsed,
          expectedGas: AVERAGE_GAS, // Show expected average gas
          error: result.error,
          trace: result.trace && {
            failed: result.trace.failed,
            error: result.trace.error,
            errorReason: result.trace.errorReason,
            method: result.trace.method,
            returnValue: result.trace.returnValue,
            gasUsed: result.trace.gasUsed,
            output: result.trace.output,
          },
          logs: result.logs?.map((log) => ({
            name: log.name,
            inputs: log.inputs,
            address: log.raw?.address,
          })),
        },
      });

      // The simulation might fail due to various contract-level checks
      // We're testing that we get a proper response either way
      if (result.success) {
        expect(result.gasUsed).toBeGreaterThan(0);
        // Check if gas used is around the expected average
        expect(result.gasUsed).toBeLessThanOrEqual(GAS_LIMIT);
        expect(Math.abs(result.gasUsed - AVERAGE_GAS)).toBeLessThan(
          AVERAGE_GAS * 0.5,
        ); // Within 50% of average
        if (result.logs?.length) {
          expect(result.logs[0]).toHaveProperty('name');
        }
      } else {
        expect(result.error).toBeDefined();
        expect(['EXECUTION_REVERTED', 'INSUFFICIENT_FUNDS']).toContain(
          result.error?.code,
        );
      }
    }, 30000);
  });

  describe('simulateBundle', () => {
    it('should simulate multiple transactions', async () => {
      const transactions: SimulationTransaction[] = [
        {
          from: RECIPIENT_ADDRESS,
          to: GOVLST_ADDRESS,
          value: ethers.parseEther('0.1').toString(),
          gas: GAS_LIMIT,
        },
        {
          from: RECIPIENT_ADDRESS,
          to: GOVLST_ADDRESS,
          value: ethers.parseEther('0.2').toString(),
          gas: GAS_LIMIT,
        },
      ];

      const options: SimulationOptions = {
        networkId: '1', // mainnet
        overrides: {
          [RECIPIENT_ADDRESS]: {
            balance: ethers.parseEther('1').toString(), // Ensure enough balance for both transactions
          },
        },
        save: true,
        saveIfFails: true,
      };

      const results = await service.simulateBundle(transactions, options);
      // eslint-disable-next-line no-console
      console.log(
        'Bundle simulation results:',
        results.map((result) => ({
          success: result.success,
          gasUsed: result.gasUsed,
          expectedGas: AVERAGE_GAS,
          error: result.error,
        })),
      );

      expect(results).toHaveLength(2);
      results.forEach((result) => {
        if (result.success) {
          expect(result.gasUsed).toBeGreaterThan(0);
          expect(result.gasUsed).toBeLessThanOrEqual(GAS_LIMIT);
          expect(Math.abs(result.gasUsed - AVERAGE_GAS)).toBeLessThan(
            AVERAGE_GAS * 0.5,
          ); // Within 50% of average
        } else {
          expect(result.error).toBeDefined();
        }
      });
    }, 60000);
  });

  describe('estimateGasCosts', () => {
    it('should estimate gas costs for a contract interaction', async () => {
      const iface = new ethers.Interface([
        'function claimAndDistributeReward(address _recipient, uint256 _minExpectedReward, uint256[] _depositIds)',
      ]);

      const calldata = iface.encodeFunctionData('claimAndDistributeReward', [
        RECIPIENT_ADDRESS,
        MIN_EXPECTED_REWARD,
        DEPOSIT_IDS,
      ]);

      const transaction: SimulationTransaction = {
        from: RECIPIENT_ADDRESS,
        to: GOVLST_ADDRESS,
        data: calldata,
        gas: GAS_LIMIT,
      };

      const result = await service.estimateGasCosts(transaction, {
        networkId: '1', // mainnet
        overrides: {
          [RECIPIENT_ADDRESS]: {
            balance: ethers.parseEther('1').toString(), // Ensure enough ETH for gas
          },
        },
      });

      // eslint-disable-next-line no-console
      console.log('Gas cost estimation:', {
        transaction: {
          from: transaction.from,
          to: transaction.to,
          gas: transaction.gas,
          data: transaction.data?.slice(0, 66) + '...', // Show first 32 bytes of calldata
        },
        estimation: {
          gasUnits: result.gasUnits,
          gasPrice: result.gasPrice + ' gwei',
          gasPriceDetails: {
            baseFeePerGas: result.gasPriceDetails?.baseFeePerGas + ' gwei',
            low: {
              maxFeePerGas: result.gasPriceDetails?.low.maxFeePerGas + ' gwei',
              waitTime: result.gasPriceDetails?.low.waitTime + ' seconds',
            },
            medium: {
              maxFeePerGas:
                result.gasPriceDetails?.medium.maxFeePerGas + ' gwei',
              waitTime: result.gasPriceDetails?.medium.waitTime + ' seconds',
            },
            high: {
              maxFeePerGas: result.gasPriceDetails?.high.maxFeePerGas + ' gwei',
              waitTime: result.gasPriceDetails?.high.waitTime + ' seconds',
            },
          },
          timestamp: new Date(result.timestamp * 1000).toISOString(),
        },
      });

      // Basic validation
      expect(result.gasUnits).toBeGreaterThan(0);
      expect(result.gasUnits).toBeLessThanOrEqual(GAS_LIMIT);
      expect(parseFloat(result.gasPrice)).toBeGreaterThan(0);

      // Gas price details validation
      expect(result.gasPriceDetails).toBeDefined();
      const gasPriceDetails = result.gasPriceDetails!;
      expect(parseFloat(gasPriceDetails.baseFeePerGas)).toBeGreaterThanOrEqual(
        0,
      );

      // Validate wait times
      expect(gasPriceDetails.high.waitTime).toBe(30);
      expect(gasPriceDetails.medium.waitTime).toBe(60);
      expect(gasPriceDetails.low.waitTime).toBe(120);

      // Validate gas prices are consistent
      expect(gasPriceDetails.high.maxFeePerGas).toBe(result.gasPrice);
      expect(gasPriceDetails.medium.maxFeePerGas).toBe(result.gasPrice);
      expect(gasPriceDetails.low.maxFeePerGas).toBe(result.gasPrice);

      // Timestamp validation
      expect(result.timestamp).toBeLessThanOrEqual(
        Math.floor(Date.now() / 1000),
      );
      expect(result.timestamp).toBeGreaterThan(
        Math.floor(Date.now() / 1000) - 60,
      ); // Within last minute
    }, 30000); // 30 second timeout
  });
});
