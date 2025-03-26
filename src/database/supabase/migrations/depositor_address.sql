-- Add depositor_address column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'deposits' AND column_name = 'depositor_address'
    ) THEN
        -- Add the column
        ALTER TABLE deposits ADD COLUMN depositor_address TEXT;

        -- Set default value for existing records (use owner_address as default)
        UPDATE deposits SET depositor_address = owner_address WHERE depositor_address IS NULL;

        -- Set to NOT NULL after populating
        ALTER TABLE deposits ALTER COLUMN depositor_address SET NOT NULL;
    END IF;
END
$$;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_deposits_depositor ON deposits(depositor_address);
