import { NextRequest, NextResponse } from "next/server";
import {
  createClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";

export interface RequestAuth {
  /** Supabase client acting as the signed-in user (RLS applies). */
  supabase: SupabaseClient;
  user: User;
  /** Raw bearer token, for handing to background work started by this request. */
  accessToken: string;
}

/**
 * Resolve the signed-in user for an API route from the Authorization header.
 * The client sends `Bearer <supabase access token>` (see lib/jobs.ts).
 *
 * Returns `{ auth }` on success, or `{ response }` — a ready-made error
 * NextResponse the route should return directly.
 */
export async function requireUser(
  req: NextRequest
): Promise<{ auth: RequestAuth } | { response: NextResponse }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return {
      response: NextResponse.json(
        { error: "Server is not configured for accounts." },
        { status: 500 }
      ),
    };
  }
  const header = req.headers.get("authorization") || "";
  const accessToken = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!accessToken) {
    return {
      response: NextResponse.json(
        { error: "Sign in required." },
        { status: 401 }
      ),
    };
  }
  const supabase = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return {
      response: NextResponse.json(
        { error: "Sign in required." },
        { status: 401 }
      ),
    };
  }
  return { auth: { supabase, user: data.user, accessToken } };
}
