import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

// Built on first use, not at import time, so importing the app never requires
// env vars to be set. Keeps tests fast and app.ts free of side effects.
export function getSupabase(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;

    if (!url || !key) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_ANON_KEY must be set (see .env.local)"
      );
    }

    // The anon key is deliberately low-privilege: the webhook_events RLS policy
    // allows INSERT only, so a leaked key can't read or tamper with stored events.
    client = createClient(url, key);
  }

  return client;
}
