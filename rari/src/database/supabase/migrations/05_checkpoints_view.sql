-- Create a view to provide compatibility with code expecting 'checkpoints'
CREATE OR REPLACE VIEW checkpoints AS
SELECT 
  component_type,
  last_block_number,
  block_hash,
  last_update
FROM processing_checkpoints;

-- Insert default checkpoint values for required components
INSERT INTO processing_checkpoints (component_type, last_block_number, block_hash, last_update)
VALUES 
  ('staker-monitor', 0, '0x0000000000000000000000000000000000000000000000000000000000000000', NOW())
ON CONFLICT (component_type) DO NOTHING;

INSERT INTO processing_checkpoints (component_type, last_block_number, block_hash, last_update)
VALUES 
  ('executor', 0, '0x0000000000000000000000000000000000000000000000000000000000000000', NOW())
ON CONFLICT (component_type) DO NOTHING;

INSERT INTO processing_checkpoints (component_type, last_block_number, block_hash, last_update)
VALUES 
  ('profitability-engine', 0, '0x0000000000000000000000000000000000000000000000000000000000000000', NOW())
ON CONFLICT (component_type) DO NOTHING; 