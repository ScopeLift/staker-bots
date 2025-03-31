import { supabase } from './client';
import {
  ProcessingQueueItem,
  ProcessingQueueStatus,
} from '../interfaces/types';

const SUPABASE_NOT_CONFIGURED_ERROR =
  'Supabase client is not available. Make sure SUPABASE_URL and SUPABASE_KEY are configured in your environment or config file.';

export async function createProcessingQueueItem(
  item: Omit<
    ProcessingQueueItem,
    'id' | 'created_at' | 'updated_at' | 'attempts'
  >,
): Promise<ProcessingQueueItem> {
  const newItem = {
    ...item,
    attempts: 0,
  };

  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('processing_queue')
    .insert([newItem])
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export async function updateProcessingQueueItem(
  id: string,
  update: Partial<
    Omit<ProcessingQueueItem, 'id' | 'created_at' | 'updated_at'>
  >,
): Promise<void> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { error } = await client
    .from('processing_queue')
    .update(update)
    .eq('id', id);

  if (error) throw error;
}

export async function getProcessingQueueItem(
  id: string,
): Promise<ProcessingQueueItem | null> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('processing_queue')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // No rows returned
    throw error;
  }

  return data;
}

export async function getProcessingQueueItemsByStatus(
  status: ProcessingQueueStatus,
): Promise<ProcessingQueueItem[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('processing_queue')
    .select('*')
    .eq('status', status);

  if (error) throw error;
  return data || [];
}

export async function getProcessingQueueItemByDepositId(
  depositId: string,
): Promise<ProcessingQueueItem | null> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('processing_queue')
    .select('*')
    .eq('deposit_id', depositId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // No rows returned
    throw error;
  }

  return data;
}

export async function getProcessingQueueItemsByDelegatee(
  delegatee: string,
): Promise<ProcessingQueueItem[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('processing_queue')
    .select('*')
    .eq('delegatee', delegatee);

  if (error) throw error;
  return data || [];
}

export async function deleteProcessingQueueItem(id: string): Promise<void> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { error } = await client.from('processing_queue').delete().eq('id', id);

  if (error) throw error;
}
