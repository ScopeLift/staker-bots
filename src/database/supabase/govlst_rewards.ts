import { supabase } from './client';
import { GovLstDeposit, GovLstClaimHistory } from '../interfaces/types';

const SUPABASE_NOT_CONFIGURED_ERROR =
  'Supabase client is not available. Make sure SUPABASE_URL and SUPABASE_KEY are configured in your environment or config file.';

// GovLst Deposits Operations

export async function createGovLstDeposit(
  deposit: GovLstDeposit,
): Promise<void> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { error } = await client.from('govlst_deposits').insert([deposit]);
  if (error) throw error;
}

export async function updateGovLstDeposit(
  depositId: string,
  update: Partial<Omit<GovLstDeposit, 'deposit_id'>>,
): Promise<void> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { error } = await client
    .from('govlst_deposits')
    .update(update)
    .eq('deposit_id', depositId);
  if (error) throw error;
}

export async function getGovLstDeposit(
  depositId: string,
): Promise<GovLstDeposit | null> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('govlst_deposits')
    .select('*')
    .eq('deposit_id', depositId)
    .single();
  if (error) throw error;
  return data;
}

export async function getGovLstDepositsByAddress(
  govLstAddress: string,
): Promise<GovLstDeposit[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('govlst_deposits')
    .select('*')
    .eq('govlst_address', govLstAddress);
  if (error) throw error;
  return data || [];
}

export async function getAllGovLstDeposits(): Promise<GovLstDeposit[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client.from('govlst_deposits').select('*');
  if (error) throw error;
  return data || [];
}

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
    .single();
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
