CREATE TABLE score_events (
  delegatee TEXT NOT NULL,
  score NUMERIC NOT NULL,
  block_number BIGINT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (delegatee, block_number)
);

CREATE INDEX idx_score_events_block_number ON score_events(block_number);

-- Add trigger for updated_at
DROP TRIGGER IF EXISTS update_score_events_updated_at ON score_events;
CREATE TRIGGER update_score_events_updated_at
    BEFORE UPDATE ON score_events
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
