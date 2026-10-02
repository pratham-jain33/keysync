import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";

export const runtime = "nodejs";

/** GET /api/jobs/[id] — full job detail, including song_data once done. */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireUser(req);
  if ("response" in authResult) return authResult.response;
  const { supabase, user } = authResult.auth;

  const { data, error } = await supabase
    .from("build_jobs")
    .select("*")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Build not found." }, { status: 404 });
  }
  return NextResponse.json(data);
}
