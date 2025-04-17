import { supabase } from './client';
import { ErrorLog } from '../interfaces/types';

const SUPABASE_NOT_CONFIGURED_ERROR =
  'Supabase client is not available. Make sure SUPABASE_URL and SUPABASE_KEY are configured in your environment or config file.';

/**
 * Create a new error log entry
 */
export async function createErrorLog(errorLog: ErrorLog): Promise<ErrorLog> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('errors')
    .insert([errorLog])
    .select()
    .single();

  if (error) throw error;
  if (!data) throw new Error('Failed to create error log');

  return data;
}

/**
 * Get error logs with pagination
 */
export async function getErrorLogs(
  limit = 50,
  offset = 0,
): Promise<ErrorLog[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('errors')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return data || [];
}

/**
 * Get error logs by service name with pagination
 */
export async function getErrorLogsByService(
  serviceName: string,
  limit = 50,
  offset = 0,
): Promise<ErrorLog[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('errors')
    .select('*')
    .eq('service_name', serviceName)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return data || [];
}

/**
 * Get error logs by severity with pagination
 */
export async function getErrorLogsBySeverity(
  severity: string,
  limit = 50,
  offset = 0,
): Promise<ErrorLog[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('errors')
    .select('*')
    .eq('severity', severity)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return data || [];
}

/**
 * Delete an error log by ID
 */
export async function deleteErrorLog(id: string): Promise<void> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { error } = await client.from('errors').delete().eq('id', id);
  if (error) throw error;
}
