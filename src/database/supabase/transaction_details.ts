import { supabase } from './client';
import {
  TransactionDetails,
  TransactionDetailsStatus,
} from '../interfaces/types';

const SUPABASE_NOT_CONFIGURED_ERROR =
  'Supabase client is not available. Make sure SUPABASE_URL and SUPABASE_KEY are configured in your environment or config file.';

export async function createTransactionDetails(
  details: Omit<TransactionDetails, 'id' | 'created_at' | 'updated_at'>,
): Promise<TransactionDetails> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  try {
    const { data, error } = await client
      .from('transaction_details')
      .insert([details])
      .select('*')
      .single();

    if (error) throw error;
    if (!data) throw new Error('Failed to create transaction details');
    return data;
  } catch (error) {
    console.error('Error creating transaction details:', error);
    throw error;
  }
}

export async function updateTransactionDetails(
  id: string,
  update: Partial<Omit<TransactionDetails, 'id' | 'created_at' | 'updated_at'>>,
): Promise<void> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { error } = await client
    .from('transaction_details')
    .update(update)
    .eq('id', id);

  if (error) throw error;
}

export async function getTransactionDetailsByTransactionId(
  transactionId: string,
): Promise<TransactionDetails | null> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('transaction_details')
    .select('*')
    .eq('transaction_id', transactionId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getTransactionDetailsByTransactionHash(
  transactionHash: string,
): Promise<TransactionDetails | null> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('transaction_details')
    .select('*')
    .eq('transaction_hash', transactionHash)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getTransactionDetailsByStatus(
  status: TransactionDetailsStatus,
): Promise<TransactionDetails[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('transaction_details')
    .select('*')
    .eq('status', status);

  if (error) throw error;
  return data || [];
}

export async function getTransactionDetailsByDepositId(
  depositId: string,
): Promise<TransactionDetails[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  // Use array contains operator to find transactions that include this deposit ID
  const { data, error } = await client
    .from('transaction_details')
    .select('*')
    .contains('deposit_ids', [depositId]);

  if (error) throw error;
  return data || [];
}

export async function getRecentTransactionDetails(
  limit = 50,
  offset = 0,
): Promise<TransactionDetails[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('transaction_details')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return data || [];
}
