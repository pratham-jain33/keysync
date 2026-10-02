import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { enqueueJob } from "@/lib/job-processor";
import { missingTools, parseSections } from "@/lib/build-song";
import type { Section } from "@/lib/types";

export const runtime = "nodejs";

const YT_RE =
  /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/watch\?[^#]*v=|youtu\.be\/)([\w-]{11})/;

const MAX_BYTES = 100 * 1024 * 1024;
const ALLOWED_EXT = new Set([
  ".mp3",
  ".m4a",
  ".wav",
  ".ogg",
  ".flac",
  ".webm",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

/** Jobs stuck in 'processing' longer than this are assumed orphaned
 * (server restart / crash) and get requeued. */
const STALE_MS = 20 * 60 * 1000;

/**
 * POST /api/jobs — start a background build.
 *
 * Accepts either JSON { kind:'youtube', youtubeUrl, title?, sections? } or
 * multipart form data with an 'audio' file (+ 'title', 'sections').
 *
 * Returns { jobId } immediately; the build continues server-side after the
 * response, so the client can close the tab. Progress via GET /api/jobs.
 */
export async function POST(req: NextRequest) {
  const authResult = await requireUser(req);
  if ("response" in authResult) return authResult.response;
  const { supabase, user, accessToken } = authResult.auth;

  const missing = missingTools();
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: `Builds are unavailable right now (missing: ${missing.join(", ")}).`,
      },
      { status: 503 }
    );
  }

  const contentType = req.headers.get("content-type") || "";
  let kind: "youtube" | "audio";
  let youtubeUrl: string | null = null;
  let title = "Untitled song";
  let sections: Section[] = [];
  let audioFile: File | null = null;

  try {
    if (contentType.includes("application/json")) {
      const body = await req.json();
      if (body.kind !== "youtube" || typeof body.youtubeUrl !== "string") {
        return NextResponse.json(
          { error: "Send { kind: 'youtube', youtubeUrl }." },
          { status: 400 }
        );
      }
      if (!body.youtubeUrl.match(YT_RE)) {
        return NextResponse.json(
          { error: "That is not a valid YouTube watch URL." },
          { status: 400 }
        );
      }
      kind = "youtube";
      youtubeUrl = body.youtubeUrl;
      if (typeof body.title === "string" && body.title.trim()) {
        title = body.title.trim().slice(0, 120);
      }
      sections = parseSections(body.sections);
    } else {
      const form = await req.formData();
      const file = form.get("audio");
      if (!(file instanceof File) || file.size === 0) {
        return NextResponse.json(
          { error: "Attach an audio file as the 'audio' field." },
          { status: 400 }
        );
      }
      if (file.size > MAX_BYTES) {
        return NextResponse.json(
          { error: "Audio file is too large (max 100 MB)." },
          { status: 413 }
        );
      }
      const ext = extOf(file.name);
      if (!ALLOWED_EXT.has(ext)) {
        return NextResponse.json(
          {
            error: `Unsupported audio type '${ext || "(none)"}'. Use mp3, m4a, wav, ogg or flac.`,
          },
          { status: 400 }
        );
      }
      kind = "audio";
      audioFile = file;
      const rawTitle = form.get("title");
      if (typeof rawTitle === "string" && rawTitle.trim()) {
        title = rawTitle.trim().slice(0, 120);
      } else {
        title = file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Uploaded song";
      }
      const rawSections = form.get("sections");
      if (typeof rawSections === "string" && rawSections) {
        try {
          sections = parseSections(JSON.parse(rawSections));
        } catch {
          sections = [];
        }
      }
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Create the job row first so the id exists for the storage path.
  const { data: job, error: insertError } = await supabase
    .from("build_jobs")
    .insert({
      user_id: user.id,
      kind,
      title,
      source_url: youtubeUrl,
      sections,
    })
    .select("id")
    .single();

  if (insertError || !job) {
    console.error("[jobs] insert failed:", insertError?.message);
    return NextResponse.json(
      { error: "Could not start the build. Try again." },
      { status: 500 }
    );
  }

  if (kind === "audio" && audioFile) {
    const path = `${user.id}/${job.id}/${audioFile.name}`;
    const { error: uploadError } = await supabase.storage
      .from("build-audio")
      .upload(path, audioFile, {
        contentType: audioFile.type || "application/octet-stream",
        upsert: false,
      });
    if (uploadError) {
      console.error("[jobs] audio upload failed:", uploadError.message);
      await supabase
        .from("build_jobs")
        .update({ status: "failed", error: "The audio upload failed. Try again." })
        .eq("id", job.id);
      return NextResponse.json(
        { error: "The audio upload failed. Try again." },
        { status: 500 }
      );
    }
    await supabase
      .from("build_jobs")
      .update({ audio_path: path })
      .eq("id", job.id);
  }

  // Fire-and-forget: the worker keeps going after this response is sent.
  enqueueJob(job.id, accessToken);

  return NextResponse.json({ jobId: job.id });
}

/**
 * GET /api/jobs — newest-first list of the user's builds (without song_data).
 * Also performs stale recovery: jobs stuck in 'processing' for over
 * STALE_MS are requeued, and any 'queued' job not currently being worked
 * is (re)submitted to the in-process worker. This is what revives builds
 * after a server restart.
 */
export async function GET(req: NextRequest) {
  const authResult = await requireUser(req);
  if ("response" in authResult) return authResult.response;
  const { supabase, user, accessToken } = authResult.auth;

  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  await supabase
    .from("build_jobs")
    .update({ status: "queued", current_step: "Waiting to start" })
    .eq("user_id", user.id)
    .eq("status", "processing")
    .lt("updated_at", cutoff);

  const { data, error } = await supabase
    .from("build_jobs")
    .select(
      "id, kind, title, status, progress, current_step, error, created_at, updated_at"
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("[jobs] list failed:", error.message);
    return NextResponse.json(
      { error: "Could not load builds." },
      { status: 500 }
    );
  }

  for (const j of data ?? []) {
    if (j.status === "queued") enqueueJob(j.id, accessToken);
  }

  return NextResponse.json({ jobs: data ?? [] });
}
