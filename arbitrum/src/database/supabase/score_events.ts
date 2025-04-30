import { ScoreEvent } from '../interfaces/types';
import { supabase } from './client';

export async function createScoreEvent(event: ScoreEvent): Promise<void> {
  const { error } = await supabase.from('score_events').insert([
    {
      delegatee: event.delegatee,
      score: event.score,
      block_number: event.block_number,
    },
  ]);

  if (error) throw error;
}

export async function updateScoreEvent(
  delegatee: string,
  blockNumber: number,
  update: Partial<ScoreEvent>,
): Promise<void> {
  const { error } = await supabase
    .from('score_events')
    .update({
      ...update,
      updated_at: new Date().toISOString(),
    })
    .eq('delegatee', delegatee)
    .eq('block_number', blockNumber);

  if (error) throw error;
}

export async function deleteScoreEvent(
  delegatee: string,
  blockNumber: number,
): Promise<void> {
  const { error } = await supabase
    .from('score_events')
    .delete()
    .eq('delegatee', delegatee)
    .eq('block_number', blockNumber);

  if (error) throw error;
}

export async function getScoreEvent(
  delegatee: string,
  blockNumber: number,
): Promise<ScoreEvent | null> {
  const { data, error } = await supabase
    .from('score_events')
    .select('*')
    .eq('delegatee', delegatee)
    .eq('block_number', blockNumber)
    .single();

  if (error) throw error;
  return data;
}

export async function getLatestScoreEvent(
  delegatee: string,
): Promise<ScoreEvent | null> {
  const { data, error } = await supabase
    .from('score_events')
    .select('*')
    .eq('delegatee', delegatee)
    .order('block_number', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') throw error; // Ignore not found error
  return data || null;
}

export async function getScoreEventsByBlockRange(
  fromBlock: number,
  toBlock: number,
): Promise<ScoreEvent[]> {
  const { data, error } = await supabase
    .from('score_events')
    .select('*')
    .gte('block_number', fromBlock)
    .lte('block_number', toBlock)
    .order('block_number', { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function deleteScoreEventsByBlockRange(
  fromBlock: number,
  toBlock: number,
): Promise<void> {
  const { error } = await supabase
    .from('score_events')
    .delete()
    .gte('block_number', fromBlock)
    .lte('block_number', toBlock);

  if (error) throw error;
}
