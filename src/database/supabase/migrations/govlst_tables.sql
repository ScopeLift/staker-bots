-- GovLst Deposits Table
CREATE TABLE IF NOT EXISTS govlst_deposits (
  deposit_id TEXT PRIMARY KEY REFERENCES deposits(deposit_id),
  govlst_address TEXT NOT NULL,
  last_reward_check TIMESTAMP WITH TIME ZONE,
  last_unclaimed_reward TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL
);

-- GovLst Claim History Table
CREATE TABLE IF NOT EXISTS govlst_claim_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  govlst_address TEXT NOT NULL,
  deposit_ids TEXT[] NOT NULL,
  claimed_reward TEXT NOT NULL,
  payout_amount TEXT NOT NULL,
  profit TEXT NOT NULL,
  transaction_hash TEXT,
  gas_used TEXT,
  gas_price TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_govlst_deposits_address ON govlst_deposits(govlst_address);
CREATE INDEX IF NOT EXISTS idx_govlst_claim_history_address ON govlst_claim_history(govlst_address);
CREATE INDEX IF NOT EXISTS idx_govlst_claim_history_tx_hash ON govlst_claim_history(transaction_hash);

-- Add triggers for updated_at
DROP TRIGGER IF EXISTS update_govlst_deposits_updated_at ON govlst_deposits;
CREATE TRIGGER update_govlst_deposits_updated_at
  BEFORE UPDATE ON govlst_deposits
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_govlst_claim_history_updated_at ON govlst_claim_history;
CREATE TRIGGER update_govlst_claim_history_updated_at
  BEFORE UPDATE ON govlst_claim_history
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
