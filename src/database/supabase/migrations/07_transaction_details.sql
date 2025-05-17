-- Create transaction details table
CREATE TABLE IF NOT EXISTS transaction_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id TEXT NOT NULL, -- ID from the executor
    transaction_hash TEXT, -- Transaction hash once submitted
    tx_queue_item_id TEXT, -- Reference to queue item ID
    status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed')),
    deposit_ids TEXT[], -- Array of deposit IDs included in this transaction
    recipient_address TEXT NOT NULL, -- Recipient address
    min_expected_reward TEXT NOT NULL, -- Minimum expected reward
    payout_amount TEXT NOT NULL, -- Payout amount from contract
    profit_margin_amount TEXT NOT NULL, -- Amount added for profit margin
    gas_cost_estimate TEXT NOT NULL, -- Gas cost estimate in reward tokens
    gas_cost_eth TEXT, -- Gas cost in ETH
    gas_limit TEXT NOT NULL, -- Gas limit used
    gas_used TEXT, -- Actual gas used
    gas_price TEXT, -- Gas price paid
    max_fee_per_gas TEXT, -- Max fee per gas
    max_priority_fee_per_gas TEXT, -- Max priority fee per gas
    reward_token_price_usd TEXT, -- Reward token price in USD
    eth_price_usd TEXT, -- ETH price in USD
    expected_profit TEXT NOT NULL, -- Expected profit in reward tokens
    actual_profit TEXT, -- Actual profit in reward tokens
    start_time TIMESTAMP WITH TIME ZONE, -- Transaction start time
    end_time TIMESTAMP WITH TIME ZONE, -- Transaction completion time
    duration_ms INTEGER, -- Duration in milliseconds
    error TEXT, -- Error message if failed
    contract_address TEXT NOT NULL, -- Contract address
    network_id TEXT NOT NULL, -- Network ID
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_tx_details_transaction_id ON transaction_details(transaction_id);
CREATE INDEX IF NOT EXISTS idx_tx_details_transaction_hash ON transaction_details(transaction_hash);
CREATE INDEX IF NOT EXISTS idx_tx_details_status ON transaction_details(status);
CREATE INDEX IF NOT EXISTS idx_tx_details_contract_address ON transaction_details(contract_address);

-- Add triggers for updated_at
DROP TRIGGER IF EXISTS update_transaction_details_updated_at ON transaction_details;
CREATE TRIGGER update_transaction_details_updated_at
    BEFORE UPDATE ON transaction_details
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column(); 