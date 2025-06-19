-- Add missing columns to transaction_queue table
-- This migration adds the transaction_type and profitability_check columns 
-- that are defined in TypeScript types but missing from the database schema

-- Add transaction_type column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transaction_queue' 
        AND column_name = 'transaction_type'
    ) THEN
        ALTER TABLE transaction_queue 
        ADD COLUMN transaction_type TEXT NOT NULL DEFAULT 'bump' 
        CHECK (transaction_type IN ('bump', 'claim_and_distribute'));
    END IF;
END $$;

-- Add profitability_check column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transaction_queue' 
        AND column_name = 'profitability_check'
    ) THEN
        ALTER TABLE transaction_queue 
        ADD COLUMN profitability_check TEXT 
        CHECK (profitability_check IS NULL OR length(profitability_check) > 0);
    END IF;
END $$;

-- After adding the transaction_type column with default, we should remove the default
-- so new inserts must explicitly specify the transaction type
DO $$ 
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transaction_queue' 
        AND column_name = 'transaction_type'
    ) THEN
        ALTER TABLE transaction_queue ALTER COLUMN transaction_type DROP DEFAULT;
    END IF;
END $$; 