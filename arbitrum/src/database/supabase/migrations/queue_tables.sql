-- Create processing queue table
CREATE TABLE IF NOT EXISTS processing_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deposit_id TEXT NOT NULL REFERENCES deposits(deposit_id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    delegatee TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    last_profitability_check JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL
);

-- Create transaction queue table
CREATE TABLE IF NOT EXISTS transaction_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deposit_id TEXT NOT NULL REFERENCES deposits(deposit_id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed')),
    hash TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    tx_data JSONB NOT NULL,
    gas_price TEXT,
    tip_amount TEXT,
    tip_receiver TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_processing_queue_deposit_id ON processing_queue(deposit_id);
CREATE INDEX IF NOT EXISTS idx_processing_queue_delegatee ON processing_queue(delegatee);
CREATE INDEX IF NOT EXISTS idx_processing_queue_status ON processing_queue(status);

CREATE INDEX IF NOT EXISTS idx_transaction_queue_deposit_id ON transaction_queue(deposit_id);
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
