// Script to check GovLst contract for deposit information
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const DB_PATH = './staker-monitor-db.json';

// GovLst ABI (extract from constants.ts)
const govLstAbi = [
  {
    inputs: [{ internalType: "address", name: "_delegatee", type: "address" }],
    name: "depositForDelegatee",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "defaultDelegatee",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_holder", type: "address" }],
    name: "depositIdForHolder",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_holder", type: "address" }],
    name: "delegateeForHolder",
    outputs: [{ internalType: "address", name: "_delegatee", type: "address" }],
    stateMutability: "view",
    type: "function"
  }
];

async function main() {
  try {
    // Create provider and contract
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const govLstAddress = process.env.LST_ADDRESS;

    if (!govLstAddress) {
      console.error('LST_ADDRESS not set in .env file');
      return;
    }

    console.log(`Using GovLst address: ${govLstAddress}`);
    const govLstContract = new ethers.Contract(govLstAddress, govLstAbi, provider);

    // Get default delegatee
    const defaultDelegatee = await govLstContract.defaultDelegatee();
    console.log(`Default delegatee: ${defaultDelegatee}`);
    console.log('-----------------------------------');

    // Check delegatee addresses
    const delegateesToCheck = [
      defaultDelegatee,
      '0x6Fbb31f8c459d773A8d0f67C8C055a70d943C1F1',
      '0xc0163E58648b247c143023CFB26C2BAA42C9d9A9',
      '0x0000000000000000000000000000000000000b01',
    ];

    console.log('DELEGATEE TO DEPOSIT ID MAPPING:');
    for (const delegatee of delegateesToCheck) {
      try {
        const depositId = await govLstContract.depositForDelegatee(delegatee);
        console.log(`Delegatee: ${delegatee} => Deposit ID: ${depositId.toString()}`);
      } catch (err) {
        console.log(`Error getting deposit for delegatee ${delegatee}: ${err.message}`);
      }
    }
    console.log('-----------------------------------');

    // Check deposit IDs
    const depositIdsToCheck = [1, 2, 3];

    console.log('DEPOSIT OWNERSHIP INFO:');

    // Read our local database to compare - ensure we're reading the latest from disk
    const dbData = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    console.log('Local database deposits:');
    console.log(JSON.stringify(dbData.deposits, null, 2));
    console.log('-----------------------------------');

    // Print summary of fixed database
    console.log('SUMMARY OF DATABASE:');

    if (dbData.deposits['1']) {
      console.log(`Deposit ID 1 => Delegatee: ${dbData.deposits['1'].delegatee_address}`);
      if (dbData.deposits['1'].delegatee_address === defaultDelegatee) {
        console.log('✅ Deposit ID 1 correctly set to default delegatee');
      } else {
        console.log('❌ Deposit ID 1 should be set to default delegatee');
      }
    }

    if (dbData.deposits['2']) {
      console.log(`Deposit ID 2 => Delegatee: ${dbData.deposits['2'].delegatee_address}`);
      console.log('❌ Deposit ID 2 should be removed');
    } else {
      console.log('✅ Deposit ID 2 correctly removed');
    }

    if (dbData.deposits['3']) {
      console.log(`Deposit ID 3 => Delegatee: ${dbData.deposits['3'].delegatee_address}`);
      if (dbData.deposits['3'].delegatee_address === '0xc0163E58648b247c143023CFB26C2BAA42C9d9A9') {
        console.log('✅ Deposit ID 3 correctly set to 0xc0163E58648b247c143023CFB26C2BAA42C9d9A9');
      } else {
        console.log('❌ Deposit ID 3 should be set to 0xc0163E58648b247c143023CFB26C2BAA42C9d9A9');
      }
    }

  } catch (err) {
    console.error('Error:', err);
  }
}

// Run the script
main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
