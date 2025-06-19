-- Create processing queue table
CREATE TABLE IF NOT EXISTS processing_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deposit_id TEXT NOT NULL REFERENCES deposits(deposit_id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    delegatee TEXT NOT NULL CHECK (length(delegatee) > 0),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    error TEXT CHECK (error IS NULL OR length(error) > 0),
    last_profitability_check TEXT CHECK (last_profitability_check IS NULL OR length(last_profitability_check) > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL
);

-- Create transaction queue table
CREATE TABLE IF NOT EXISTS transaction_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_type TEXT NOT NULL CHECK (transaction_type IN ('bump', 'claim_and_distribute')),
    deposit_id TEXT NOT NULL CHECK (length(deposit_id) > 0), -- This will store multiple deposit IDs as comma-separated values
    status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed')),
    hash TEXT CHECK (hash IS NULL OR length(hash) > 0),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    error TEXT CHECK (error IS NULL OR length(error) > 0),
    tx_data TEXT NOT NULL CHECK (length(tx_data) > 0),
    gas_price TEXT CHECK (gas_price IS NULL OR length(gas_price) > 0),
    tip_amount TEXT CHECK (tip_amount IS NULL OR length(tip_amount) > 0),
    tip_receiver TEXT CHECK (tip_receiver IS NULL OR length(tip_receiver) > 0),
    profitability_check TEXT CHECK (profitability_check IS NULL OR length(profitability_check) > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_processing_queue_deposit_id ON processing_queue(deposit_id);
CREATE INDEX IF NOT EXISTS idx_processing_queue_delegatee ON processing_queue(delegatee);
CREATE INDEX IF NOT EXISTS idx_processing_queue_status ON processing_queue(status);

CREATE INDEX IF NOT EXISTS idx_transaction_queue_status ON transaction_queue(status);
CREATE INDEX IF NOT EXISTS idx_transaction_queue_hash ON transaction_queue(hash);

-- Add triggers for updated_at
DROP TRIGGER IF EXISTS update_processing_queue_updated_at ON processing_queue;
CREATE TRIGGER update_processing_queue_updated_at
    BEFORE UPDATE ON processing_queue
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_transaction_queue_updated_at ON transaction_queue;
CREATE TRIGGER update_transaction_queue_updated_at
    BEFORE UPDATE ON transaction_queue
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column(); 