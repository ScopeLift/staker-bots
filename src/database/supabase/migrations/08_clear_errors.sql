-- Delete all rows from errors table
TRUNCATE TABLE errors;

-- Add a comment to confirm deletion
COMMENT ON TABLE errors IS 'Errors table - cleared by migration on ' || NOW()::TEXT; 