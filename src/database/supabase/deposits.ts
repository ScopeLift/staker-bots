import { supabase } from './client';
import { Deposit } from '../interfaces/types';

export async function createDeposit(deposit: Deposit): Promise<void> {
  const { error } = await supabase.from('deposits').insert([deposit]);
  if (error) throw error;
}

export async function updateDeposit(
  depositId: string,
  update: Partial<Omit<Deposit, 'deposit_id'>>,
): Promise<void> {
  const { error } = await supabase
    .from('deposits')
    .update(update)
    .eq('deposit_id', depositId);
  if (error) throw error;
}

export async function getDeposit(depositId: string): Promise<Deposit | null> {
  const { data, error } = await supabase
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
  const { data, error } = await supabase
    .from('deposits')
    .select('*')
    .eq('delegatee_address', delegateeAddress);
  if (error) throw error;
  return data || [];
}

export async function getAllDeposits(): Promise<Deposit[]> {
  const { data, error } = await supabase.from('deposits').select('*');
  if (error) throw error;
  return data || [];
}
