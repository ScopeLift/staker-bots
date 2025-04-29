import { supabase } from './client';
import {
  TransactionQueueItem,
  TransactionQueueStatus,
} from '../interfaces/types';

const SUPABASE_NOT_CONFIGURED_ERROR =
  'Supabase client is not available. Make sure SUPABASE_URL and SUPABASE_KEY are configured in your environment or config file.';

export async function createTransactionQueueItem(
  item: Omit<
    TransactionQueueItem,
    'id' | 'created_at' | 'updated_at' | 'attempts'
  >,
): Promise<TransactionQueueItem> {
  const newItem = {
    ...item,
    attempts: 0,
  };

  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  try {
    const { data, error } = await client
      .from('transaction_queue')
      .insert([newItem])
      .select('*')
      .single();

    if (error) throw error;
    if (!data) throw new Error('Failed to create transaction queue item');
    return data;
  } catch (error) {
    console.error('Error creating transaction queue item:', error);
    throw error;
  }
}

export async function updateTransactionQueueItem(
  id: string,
  update: Partial<
    Omit<TransactionQueueItem, 'id' | 'created_at' | 'updated_at'>
  >,
): Promise<void> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { error } = await client
    .from('transaction_queue')
    .update(update)
    .eq('id', id);

  if (error) throw error;
}

export async function getTransactionQueueItem(
  id: string,
): Promise<TransactionQueueItem | null> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  // Check if id is a valid UUID
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    // Not a valid UUID, likely a deposit_id is being used
    console.warn(`Invalid UUID format for transaction queue item: ${id}`);
    return null;
  }

  const { data, error } = await client
    .from('transaction_queue')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getTransactionQueueItemsByStatus(
  status: TransactionQueueStatus,
): Promise<TransactionQueueItem[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('transaction_queue')
    .select('*')
    .eq('status', status);

  if (error) throw error;
  return data || [];
}

export async function getTransactionQueueItemByDepositId(
  depositId: string,
): Promise<TransactionQueueItem | null> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  // First, try to find a direct match on deposit_id
  const { data, error } = await client
    .from('transaction_queue')
    .select('*')
    .eq('deposit_id', depositId)
    .maybeSingle();

  if (error) throw error;

  // If found, return it
  if (data) return data;

  // If not found directly, search inside tx_data for matches
  try {
    // Get all transaction queue items
    const { data: allData, error: allError } = await client
      .from('transaction_queue')
      .select('*');

    if (allError) throw allError;
    if (!allData) return null;

    // Search through tx_data for depositIds that include our target
    for (const item of allData) {
      if (item.tx_data) {
        try {
          const txData = JSON.parse(item.tx_data);
          if (
            Array.isArray(txData.depositIds) &&
            txData.depositIds.some((id: string) => id === depositId)
          ) {
            return item;
          }
        } catch (e) {
          // Ignore JSON parse errors
        }
      }
    }
  } catch (searchError) {
    console.error('Error searching tx_data for deposit ID:', searchError);
  }

  return null;
}

export async function getTransactionQueueItemsByHash(
  hash: string,
): Promise<TransactionQueueItem[]> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { data, error } = await client
    .from('transaction_queue')
    .select('*')
    .eq('hash', hash);

  if (error) throw error;
  return data || [];
}

export async function deleteTransactionQueueItem(id: string): Promise<void> {
  const client = supabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
  }

  const { error } = await client
    .from('transaction_queue')
    .delete()
    .eq('id', id);

  if (error) throw error;
}
