import { createClient } from '@supabase/supabase-js';
import { CONFIG } from '@/configuration/constants';

export const supabase = () => {
  if (!CONFIG.supabase.url || !CONFIG.supabase.key) {
    throw new Error('Supabase configuration is missing. Check your environment variables.');
  }
  
  return createClient(CONFIG.supabase.url, CONFIG.supabase.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    db: {
      schema: 'public'
    }
  });
};