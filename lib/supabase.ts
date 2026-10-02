import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/**
 * Create the Supabase client on first use, not at import time. The build
 * prerenders pages without env vars; throwing then would fail `next build`.
 * A missing config still throws loudly the moment auth or cloud saves are
 * actually called.
 */
function getClient(): SupabaseClient {
  if (!client) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error("Missing Supabase environment variables");
    }
    client = createClient(supabaseUrl, supabaseAnonKey);
  }
  return client;
}

/**
 * Lazily-initialized Supabase client. Import this as before; the underlying
 * client is only created when a method is actually called.
 */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const c = getClient() as unknown as Record<string | symbol, unknown>;
    const v = c[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(c) : v;
  },
});
