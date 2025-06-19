-- GovLst Claim History Table
CREATE TABLE IF NOT EXISTS govlst_claim_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  govlst_address TEXT NOT NULL CHECK (length(govlst_address) > 0),
  deposit_ids JSONB NOT NULL CHECK (jsonb_array_length(deposit_ids) > 0),
  claimed_reward TEXT NOT NULL CHECK (length(claimed_reward) > 0),
  payout_amount TEXT NOT NULL CHECK (length(payout_amount) > 0),
  profit TEXT NOT NULL CHECK (length(profit) > 0),
  transaction_hash TEXT CHECK (transaction_hash IS NULL OR length(transaction_hash) > 0),
  gas_used TEXT CHECK (gas_used IS NULL OR length(gas_used) > 0),
  gas_price TEXT CHECK (gas_price IS NULL OR length(gas_price) > 0),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_govlst_claim_history_address ON govlst_claim_history(govlst_address);
CREATE INDEX IF NOT EXISTS idx_govlst_claim_history_tx_hash ON govlst_claim_history(transaction_hash);

DROP TRIGGER IF EXISTS update_govlst_claim_history_updated_at ON govlst_claim_history;
CREATE TRIGGER update_govlst_claim_history_updated_at
  BEFORE UPDATE ON govlst_claim_history
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column(); 