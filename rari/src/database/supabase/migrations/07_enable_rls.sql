-- Enable RLS on all tables
ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE score_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE govlst_rewards ENABLE ROW LEVEL SECURITY;

-- Create policies that allow service_role full access
CREATE POLICY "service_role_access_deposits" ON deposits 
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_access_checkpoints" ON checkpoints 
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_access_processing_queue" ON processing_queue 
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_access_transaction_queue" ON transaction_queue 
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_access_score_events" ON score_events 
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_access_errors" ON errors 
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_access_govlst_rewards" ON govlst_rewards 
    FOR ALL USING (auth.role() = 'service_role');

-- Grant necessary permissions to service_role
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Create secure views
CREATE OR REPLACE VIEW public.checkpoints WITH (security_invoker = on) AS
SELECT * FROM checkpoints;

CREATE OR REPLACE VIEW public.deposits WITH (security_invoker = on) AS
SELECT * FROM deposits;

CREATE OR REPLACE VIEW public.processing_queue WITH (security_invoker = on) AS
SELECT * FROM processing_queue;

CREATE OR REPLACE VIEW public.transaction_queue WITH (security_invoker = on) AS
SELECT * FROM transaction_queue;

CREATE OR REPLACE VIEW public.score_events WITH (security_invoker = on) AS
SELECT * FROM score_events;

CREATE OR REPLACE VIEW public.errors WITH (security_invoker = on) AS
SELECT * FROM errors;

CREATE OR REPLACE VIEW public.govlst_rewards WITH (security_invoker = on) AS
SELECT * FROM govlst_rewards; 