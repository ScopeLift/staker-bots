-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = TIMEZONE('utc', NOW());
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create deposits table
CREATE TABLE IF NOT EXISTS deposits (
    deposit_id TEXT PRIMARY KEY,
    owner_address TEXT NOT NULL CHECK (length(owner_address) > 0),
    depositor_address TEXT NOT NULL CHECK (length(depositor_address) > 0),
    delegatee_address TEXT NOT NULL CHECK (length(delegatee_address) > 0),
    amount NUMERIC NOT NULL CHECK (amount >= 0),
    earning_power TEXT CHECK (earning_power IS NULL OR length(earning_power) > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL
);

-- Create processing_checkpoints table
CREATE TABLE IF NOT EXISTS processing_checkpoints (
    component_type TEXT PRIMARY KEY CHECK (length(component_type) > 0),
    last_block_number BIGINT NOT NULL CHECK (last_block_number >= 0),
    block_hash TEXT NOT NULL CHECK (length(block_hash) > 0),
    last_update TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_deposits_owner ON deposits(owner_address);
CREATE INDEX IF NOT EXISTS idx_deposits_delegatee ON deposits(delegatee_address);
CREATE INDEX IF NOT EXISTS idx_deposits_depositor ON deposits(depositor_address);

-- Add trigger to deposits table
DROP TRIGGER IF EXISTS update_deposits_updated_at ON deposits;
CREATE TRIGGER update_deposits_updated_at
    BEFORE UPDATE ON deposits
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column(); 