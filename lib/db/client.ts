import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Server-side Supabase client using the service role key.
 * NEVER expose this client or its key to the browser.
 * All database operations go through server-side API routes only.
 */
function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('Missing SUPABASE_URL environment variable');
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY environment variable');

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// Lazy singleton - initialized on first use, not at import time
let _client: SupabaseClient | null = null;

export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    if (!_client) _client = getSupabaseClient();
    return (_client as unknown as Record<string | symbol, unknown>)[prop];
  },
});
