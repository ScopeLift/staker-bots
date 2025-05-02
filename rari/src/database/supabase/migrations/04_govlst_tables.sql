-- GovLst Claim History Table
CREATE TABLE IF NOT EXISTS govlst_claim_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  govlst_address TEXT NOT NULL,
  deposit_ids JSONB NOT NULL,
  claimed_reward TEXT NOT NULL,
  payout_amount TEXT NOT NULL,
  profit TEXT NOT NULL,
  transaction_hash TEXT,
  gas_used TEXT,
  gas_price TEXT,
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