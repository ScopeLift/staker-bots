### 2. Database Schema

1. Go to [Supabase Dashboard](https://app.supabase.com)
2. Select your project
3. Go to SQL Editor
4. Click "New Query"
5. Copy the contents of `src/database/supabase/migrations/schema.sql`
6. Click "Run" to execute the schema

## Database Structure

### Tables

#### deposits

- `deposit_id` (TEXT, PK): Unique identifier for each deposit
- `owner_address` (TEXT): Address of the deposit owner
- `amount` (NUMERIC): amount of deposit
- `delegatee_address` (TEXT): Address of the delegatee
- `created_at` (TIMESTAMP): Auto-set on creation
- `updated_at` (TIMESTAMP): Auto-updates on changes

#### processing_checkpoints

- `component_type` (TEXT, PK): Type of the processing component
- `last_block_number` (BIGINT): Last processed block number
- `block_hash` (TEXT): Hash of the last processed block
- `last_update` (TIMESTAMP): Time of last update

### Indexes

- `idx_deposits_owner`: Index on owner_address for faster queries
- `idx_deposits_delegatee`: Index on delegatee_address for faster queries

## Usage Example

```typescript
import { DatabaseWrapper } from '@/database';

// Supabase database (default)
const supabaseDb = new DatabaseWrapper();

// Local JSON database
const jsonDb = new DatabaseWrapper({
  type: 'json',
  jsonDbPath: '.my-local-db.json', // optional, defaults to '.local-db.json'
});

// Create deposit
npm run dev
```

## Local JSON Database

The package includes a simple JSON-based database implementation for local development and testing. The JSON database stores all data in a local file and implements the same interface as the Supabase database.

To use the JSON database:

1. Initialize the DatabaseWrapper with the 'json' type
2. Optionally specify a custom path for the database file
3. The database file will be automatically created if it doesn't exist

The JSON database is suitable for:

- Local development
- Testing
- Simple deployments that don't require a full database
- Scenarios where you want to avoid external dependencies

Note that the JSON database is not recommended for production use cases that require:

- Concurrent access
- High performance
- Data redundancy
- Complex queries
