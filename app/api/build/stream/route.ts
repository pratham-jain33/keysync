import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  missingTools,
  parseSections,
  buildSongFromAudioStreaming,
  downloadYouTubeAudio,
  warmTranscriber,
} from "@/lib/build-song";
import { sseResponse } from "@/lib/sse";
import type { Section } from "@/lib/types";

export const runtime = "nodejs";

const YT_RE =
  /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/watch\?[^#]*v=|youtu\.be\/)([\w-]{11})/;

// Streaming twin of /api/build: same YouTube -> transcription -> song
// pipeline, but it reports real progress and backend log lines over SSE and
// slices locally so only 16kHz-mono chunks go to the transcription service.
export async function POST(req: NextRequest) {
  let body: { youtubeUrl?: string; sections?: Section[]; title?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const match =
    typeof body.youtubeUrl === "string" && body.youtubeUrl.match(YT_RE);
  if (!match) {
    return NextResponse.json(
      { error: "That is not a valid YouTube watch URL" },
      { status: 400 }
    );
  }
  const youtubeUrl = body.youtubeUrl as string;
  const sections = parseSections(body.sections);
  const fallbackTitle =
    typeof body.title === "string" ? body.title : "Untitled song";

  const missing = missingTools();
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: `Missing required tools: ${missing.join(", ")}. See README.md for install instructions.`,
      },
      { status: 400 }
    );
  }

  return sseResponse(async (emit) => {
    // Wake the (possibly cold) transcription service while we download.
    warmTranscriber();
    emit({ type: "progress", phase: "warming", pct: 2, detail: "Starting up" });

    const dlDir = join(tmpdir(), `keysync-dl-${randomBytes(8).toString("hex")}`);
    await fs.mkdir(dlDir, { recursive: true });
    try {
      emit({ type: "progress", phase: "downloading", pct: 3, detail: "Downloading tutorial audio" });
      const { wav, title } = await downloadYouTubeAudio(
        youtubeUrl,
        fallbackTitle,
        dlDir,
        emit
      );
      const song = await buildSongFromAudioStreaming(wav, title, sections, emit);
      emit({ type: "progress", phase: "done", pct: 100 });
      emit({ type: "done", song });
    } finally {
      await fs.rm(dlDir, { recursive: true, force: true });
    }
  });
}
