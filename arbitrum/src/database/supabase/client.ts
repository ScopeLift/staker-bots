import { createClient } from '@supabase/supabase-js';
import { CONFIG } from '../../config';

export const supabase = createClient(
  CONFIG.supabase.url!,
  CONFIG.supabase.key!,
  {
    db: { schema: 'public' },
  },
);
