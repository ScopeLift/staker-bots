-- Create errors table
CREATE TABLE IF NOT EXISTS errors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    service_name TEXT NOT NULL,
    error_message TEXT NOT NULL,
    stack_trace TEXT,
    severity TEXT NOT NULL,
    meta JSONB,
    context JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL
);

-- Create index on service_name for filtering
CREATE INDEX IF NOT EXISTS idx_errors_service_name ON errors(service_name);

-- Create index on severity for filtering
CREATE INDEX IF NOT EXISTS idx_errors_severity ON errors(severity);

-- Create index on created_at for time-based queries
CREATE INDEX IF NOT EXISTS idx_errors_created_at ON errors(created_at);
