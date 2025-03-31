import { createClient } from '@supabase/supabase-js';
import { CONFIG } from '../../config';

export const supabase = () => {
  if (!CONFIG.supabase.url || !CONFIG.supabase.key) return null;
  return createClient(CONFIG.supabase.url ?? '', CONFIG.supabase.key ?? '', {
    db: { schema: 'public' },
  });
};
