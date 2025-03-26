// Script to fix delegatee address in the database
import fs from 'fs';

const DB_PATH = './staker-monitor-db.json';

async function main() {
  try {
    // Read the current database
    const dbContent = fs.readFileSync(DB_PATH, 'utf8');
    const db = JSON.parse(dbContent);

    console.log('Current database state:');
    console.log(JSON.stringify(db.deposits, null, 2));

    // Fix deposit 1 delegatee address
    if (db.deposits && db.deposits['1']) {
      const oldDelegatee = db.deposits['1'].delegatee_address;
      db.deposits['1'].delegatee_address = '0x0000000000000000000000000000000000000B01';
      db.deposits['1'].updated_at = new Date().toISOString();

      console.log(`Changed deposit 1 delegatee from ${oldDelegatee} to 0x0000000000000000000000000000000000000B01`);
    } else {
      console.error('Deposit 1 not found in database');
      return;
    }

    // Remove deposit 2 which appears to be invalid
    if (db.deposits && db.deposits['2']) {
      console.log('Removing deposit 2 from database');
      delete db.deposits['2'];
    }

    // Write the updated database back
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    console.log('Database updated successfully');

    // Verify the updated database
    const updatedDb = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    console.log('Updated database state:');
    console.log(JSON.stringify(updatedDb.deposits, null, 2));

    console.log('SUMMARY OF CHANGES:');
    console.log('1. Fixed deposit ID 1 to use the default delegatee (0x0000000000000000000000000000000000000B01)');
    console.log('2. Removed invalid deposit ID 2');
    console.log('3. Kept deposit ID 3 as it is (with delegatee 0xc0163E58648b247c143023CFB26C2BAA42C9d9A9)');

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
