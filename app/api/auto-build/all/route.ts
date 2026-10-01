import { NextResponse } from "next/server";
import { deleteSandbox, listSandboxes } from "@/lib/daytona";
import { cancelAllActiveBuilds } from "@/lib/auto-build-registry";

export const runtime = "nodejs";

/**
 * DELETE /api/auto-build/all — the kill switch. Cancels every in-flight
 * build on this server instance and deletes every Daytona sandbox on the
 * account, freeing the whole memory quota at once.
 */
export async function DELETE() {
  if (!process.env.DAYTONA_API_KEY) {
    return NextResponse.json(
      { error: "Automatic builds are not configured on this server yet." },
      { status: 503 }
    );
  }
  const stopped: string[] = [];
  const failed: string[] = [];
  for (const buildId of cancelAllActiveBuilds()) {
    stopped.push(`build:${buildId.slice(0, 8)}`);
  }
  try {
    const sandboxes = await listSandboxes();
    for (const sb of sandboxes) {
      try {
        await deleteSandbox(sb.id);
        stopped.push(`sandbox:${sb.id.slice(0, 8)}`);
      } catch {
        failed.push(sb.id.slice(0, 8));
      }
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to list sandboxes" },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, stopped, failed });
}
