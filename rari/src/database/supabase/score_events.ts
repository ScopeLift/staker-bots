import { supabase } from './client';
import { ScoreEvent } from '../interfaces/types';

const SUPABASE_NOT_CONFIGURED_ERROR =
  'Supabase client is not available. Make sure SUPABASE_URL and SUPABASE_KEY are configured in your environment or config file.';

export async function createScoreEvent(event: ScoreEvent): Promise<void> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { error } = await client.from('score_events').insert([event]);
  if (error) throw error;
}

export async function getLatestScoreEvent(delegatee: string): Promise<ScoreEvent | null> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('score_events')
    .select('*')
    .eq('delegatee', delegatee)
    .order('block_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
} 