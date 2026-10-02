import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

// Built on first use, not at import time, so importing the app never requires
// env vars to be set. Keeps tests fast and app.ts free of side effects.
export function getSupabase(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.local)"
      );
    }

    // Server-only credential. Phase A migration removes anonymous table/RPC
    // access so clients cannot bypass mandatory signing or dashboard auth.
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  return client;
}
