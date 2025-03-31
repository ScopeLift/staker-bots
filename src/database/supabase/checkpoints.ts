import { supabase } from './client';
import { ProcessingCheckpoint } from '../interfaces/types';

const SUPABASE_NOT_CONFIGURED_ERROR =
  'Supabase client is not available. Make sure SUPABASE_URL and SUPABASE_KEY are configured in your environment or config file.';

export async function updateCheckpoint(
  checkpoint: ProcessingCheckpoint,
): Promise<void> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { error } = await client
    .from('processing_checkpoints')
    .upsert(checkpoint, {
      onConflict: 'component_type',
    });

  if (error) throw error;
}

export async function getCheckpoint(
  componentType: string,
): Promise<ProcessingCheckpoint | null> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('processing_checkpoints')
    .select('*')
    .eq('component_type', componentType)
    .single();

  if (error) throw error;
  return data;
}
