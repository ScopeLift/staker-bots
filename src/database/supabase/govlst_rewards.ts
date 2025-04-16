import { supabase } from './client';
import { GovLstClaimHistory } from '../interfaces/types';

const SUPABASE_NOT_CONFIGURED_ERROR =
  'Supabase client is not available. Make sure SUPABASE_URL and SUPABASE_KEY are configured in your environment or config file.';

// GovLst Claim History Operations

export async function createGovLstClaimHistory(
  claim: GovLstClaimHistory,
): Promise<GovLstClaimHistory> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('govlst_claim_history')
    .insert([claim])
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getGovLstClaimHistory(
  id: string,
): Promise<GovLstClaimHistory | null> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('govlst_claim_history')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getGovLstClaimHistoryByAddress(
  govLstAddress: string,
): Promise<GovLstClaimHistory[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('govlst_claim_history')
    .select('*')
    .eq('govlst_address', govLstAddress);
  if (error) throw error;
  return data || [];
}

export async function updateGovLstClaimHistory(
  id: string,
  update: Partial<Omit<GovLstClaimHistory, 'id' | 'created_at' | 'updated_at'>>,
): Promise<void> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { error } = await client
    .from('govlst_claim_history')
    .update(update)
    .eq('id', id);
  if (error) throw error;
}
