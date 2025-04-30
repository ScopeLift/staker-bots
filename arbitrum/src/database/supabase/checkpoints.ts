import { supabase } from './client';
import { ProcessingCheckpoint } from '../interfaces/types';

export async function updateCheckpoint(
  checkpoint: ProcessingCheckpoint,
): Promise<void> {
  const { error } = await supabase
    .from('processing_checkpoints')
    .upsert(checkpoint, {
      onConflict: 'component_type',
    });

  if (error) throw error;
}

export async function getCheckpoint(
  componentType: string,
): Promise<ProcessingCheckpoint | null> {
  const { data, error } = await supabase
    .from('processing_checkpoints')
    .select('*')
    .eq('component_type', componentType)
    .single();

  if (error) throw error;
  return data;
}
