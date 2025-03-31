import { supabase } from './client';
import { Deposit } from '../interfaces/types';

const SUPABASE_NOT_CONFIGURED_ERROR =
  'Supabase client is not available. Make sure SUPABASE_URL and SUPABASE_KEY are configured in your environment or config file.';

export async function createDeposit(deposit: Deposit): Promise<void> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { error } = await client.from('deposits').insert([deposit]);
  if (error) throw error;
}

export async function updateDeposit(
  depositId: string,
  update: Partial<Omit<Deposit, 'deposit_id'>>,
): Promise<void> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { error } = await client
    .from('deposits')
    .update(update)
    .eq('deposit_id', depositId);
  if (error) throw error;
}

export async function getDeposit(depositId: string): Promise<Deposit | null> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('deposits')
    .select('*')
    .eq('deposit_id', depositId)
    .single();
  if (error) throw error;
  return data;
}

export async function getDepositsByDelegatee(
  delegateeAddress: string,
): Promise<Deposit[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('deposits')
    .select('*')
    .eq('delegatee_address', delegateeAddress);
  if (error) throw error;
  return data || [];
}

export async function getDepositsByOwner(
  ownerAddress: string,
): Promise<Deposit[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('deposits')
    .select('*')
    .eq('owner_address', ownerAddress);
  if (error) throw error;
  return data || [];
}

export async function getDepositsByDepositor(
  depositorAddress: string,
): Promise<Deposit[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('deposits')
    .select('*')
    .eq('depositor_address', depositorAddress);
  if (error) throw error;
  return data || [];
}

export async function getAllDeposits(): Promise<Deposit[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client.from('deposits').select('*');
  if (error) throw error;
  return data || [];
}
