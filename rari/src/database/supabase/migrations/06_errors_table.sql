-- Create errors table
CREATE TABLE IF NOT EXISTS errors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    service_name TEXT NOT NULL CHECK (length(service_name) > 0),
    error_message TEXT NOT NULL CHECK (length(error_message) > 0),
    stack_trace TEXT CHECK (stack_trace IS NULL OR length(stack_trace) > 0),
    severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warning', 'error', 'critical')),
    meta JSONB CHECK (meta IS NULL OR jsonb_typeof(meta) = 'object'),
    context JSONB CHECK (context IS NULL OR jsonb_typeof(context) = 'object'),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::TEXT, NOW()) NOT NULL
);

-- Create index on service_name for filtering
CREATE INDEX IF NOT EXISTS idx_errors_service_name ON errors(service_name);

-- Create index on severity for filtering
CREATE INDEX IF NOT EXISTS idx_errors_severity ON errors(severity);

-- Create index on created_at for time-based queries
CREATE INDEX IF NOT EXISTS idx_errors_created_at ON errors(created_at);