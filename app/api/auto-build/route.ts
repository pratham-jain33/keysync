import { extname } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { buildSongFromNotes } from "@/lib/build-song";
import { sseResponse } from "@/lib/sse";
import {
  createPipelineSandbox,
  waitForSandbox,
  waitForDaemon,
  uploadFile,
  execCommand,
  readTextFile,
  deleteSandbox,
  listSandboxes,
  sleep,
} from "@/lib/daytona";
import {
  registerBuild,
  getBuild,
  unregisterBuild,
  listActiveBuilds,
  newBuildId,
} from "@/lib/auto-build-registry";

export const runtime = "nodejs";

// Fully automatic song pipeline: the user supplies a YouTube link or an
// audio file of a MIXED song. A Daytona sandbox (Demucs piano isolation +
// Basic Pitch transcription) produces note events, which flow into the same
// song builder as every other path. The existing Kong transcription routes
// are untouched.
const YT_RE =
  /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/watch\?[^#]*v=|youtu\.be\/)([\w-]{11})/;
const MAX_BYTES = 100 * 1024 * 1024;
const ALLOWED_EXT = new Set([
  ".mp3",
  ".m4a",
  ".wav",
  ".ogg",
  ".flac",
  ".webm",
]);
const JOB_DIR = "/tmp/auto-job";

/** Cancel an in-flight automatic build and delete its sandbox. */
export async function DELETE(req: NextRequest) {
  const buildId = req.nextUrl.searchParams.get("buildId");
  if (!buildId) {
    return NextResponse.json({ error: "Missing buildId" }, { status: 400 });
  }
  const build = getBuild(buildId);
  if (!build) {
    return NextResponse.json({ error: "Build not found or already finished" }, { status: 404 });
  }
  build.cancelled = true;
  if (build.sandboxId) {
    try {
      await deleteSandbox(build.sandboxId);
    } catch {
      /* best effort: the polling loop will also try */
    }
  }
  unregisterBuild(buildId);
  return NextResponse.json({ ok: true });
}

/**
 * GET /api/auto-build — what is running right now.
 * Returns the in-flight SSE builds on this server instance plus every
 * Daytona sandbox on the account (the ground truth for running work).
 */
export async function GET() {
  if (!process.env.DAYTONA_API_KEY) {
    return NextResponse.json(
      { error: "Automatic builds are not configured on this server yet." },
      { status: 503 }
    );
  }
  try {
    const sandboxes = await listSandboxes();
    const builds = listActiveBuilds();
    return NextResponse.json({ builds, sandboxes });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to list processes" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  if (!process.env.DAYTONA_API_KEY) {
    return NextResponse.json(
      { error: "Automatic builds are not configured on this server yet." },
      { status: 503 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const youtubeUrl =
    typeof form.get("youtubeUrl") === "string"
      ? (form.get("youtubeUrl") as string).trim()
      : "";
  const file = form.get("audio");
  const hasFile = file instanceof File && file.size > 0;

  if (!hasFile && !YT_RE.test(youtubeUrl)) {
    return NextResponse.json(
      { error: "Provide a YouTube link or an audio file" },
      { status: 400 }
    );
  }
  if (hasFile) {
    const f = file as File;
    if (f.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "Audio file is too large (max 100 MB)" },
        { status: 413 }
      );
    }
    const ext = extname(f.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return NextResponse.json(
        { error: `Unsupported audio type '${ext || "(none)"}'. Use mp3, m4a, wav, ogg or flac.` },
        { status: 400 }
      );
    }
  }

  const title =
    typeof form.get("title") === "string" &&
    (form.get("title") as string).trim()
      ? (form.get("title") as string).trim().slice(0, 120)
      : hasFile
        ? (file as File).name.replace(/\.[^.]+$/, "").slice(0, 120) ||
          "Uploaded song"
        : "YouTube song";

  return sseResponse(async (emit) => {
    let sandboxId: string | null = null;
    const buildId = newBuildId();
    const active = registerBuild(buildId);
    const checkCancelled = () => {
      if (active.cancelled) throw new Error("Build cancelled.");
    };
    try {
      emit({ type: "progress", phase: "warming", pct: 2, detail: "Starting processing sandbox", buildId });
      emit({ type: "log", line: "Creating Daytona sandbox (keysync-pipeline snapshot)" });
      sandboxId = await createPipelineSandbox();
      active.sandboxId = sandboxId;
      checkCancelled();
      emit({ type: "log", line: `Sandbox ${sandboxId.slice(0, 8)} created, waiting for it to start` });
      await waitForSandbox(sandboxId, (line) => emit({ type: "log", line }));
      emit({ type: "log", line: "Sandbox is up, waiting for worker" });
      await waitForDaemon(sandboxId, (line) => emit({ type: "log", line }));
      emit({ type: "log", line: "Worker ready" });

      // Get the input into the sandbox: upload the file, or pass the URL.
      let mode: "file" | "youtube";
      let src: string;
      if (hasFile) {
        const f = file as File;
        emit({ type: "progress", phase: "downloading", pct: 5, detail: "Uploading audio to sandbox" });
        const buf = Buffer.from(await f.arrayBuffer());
        src = `/tmp/input${extname(f.name).toLowerCase() || ".mp3"}`;
        await uploadFile(sandboxId, src, buf, f.name, f.type || "audio/mpeg");
        mode = "file";
        emit({ type: "log", line: `Uploaded ${(buf.length / 1048576).toFixed(1)} MB` });
      } else {
        mode = "youtube";
        src = youtubeUrl;
        emit({ type: "log", line: "Using YouTube link (upload fallback available if blocked)" });
      }

      // Launch the pipeline in the background and poll its progress file.
      emit({ type: "progress", phase: "transcribing", pct: 8, detail: "Starting pipeline" });
      const launch = `mkdir -p ${JOB_DIR} && rm -f ${JOB_DIR}/progress.log ${JOB_DIR}/notes.json && cd /app && (nohup python3 cli.py ${mode} ${JSON.stringify(src)} ${JOB_DIR} > ${JOB_DIR}/stdout.log 2>&1 &) && echo launched`;
      await execCommand(sandboxId, launch);
      emit({ type: "log", line: "Pipeline launched in sandbox" });

      let notes: Array<{ pitch: number; start: number; end: number }> | null = null;
      let seenLines = 0;
      for (let i = 0; i < 120; i++) {
        checkCancelled();
        await sleep(15000);
        checkCancelled();
        const raw = await readTextFile(sandboxId, `${JOB_DIR}/progress.log`);
        if (raw) {
          const lines = raw.trim().split("\n").filter(Boolean);
          for (const line of lines.slice(seenLines)) {
            try {
              const ev = JSON.parse(line);
              if (typeof ev.pct === "number" && ev.pct >= 0) {
                const pct = 8 + Math.round(ev.pct * 0.84);
                emit({ type: "progress", phase: "transcribing", pct, detail: ev.msg });
              } else if (ev.pct === -1) {
                const msg = String(ev.msg || "Pipeline failed");
                const m = /^ERROR ([A-Z_]+): (.*)$/.exec(msg);
                throw new Error(
                  m && m[1] !== "INTERNAL" ? m[2] : "The processing server hit an unexpected error."
                );
              }
              emit({ type: "log", line: `[sandbox] ${ev.msg}` });
            } catch (e) {
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
          seenLines = lines.length;
        }
        const notesRaw = await readTextFile(sandboxId, `${JOB_DIR}/notes.json`);
        if (notesRaw) {
          notes = JSON.parse(notesRaw);
          break;
        }
      }
      if (!notes) {
        throw new Error("Processing timed out after 30 minutes. Try a shorter song.");
      }

      emit({ type: "progress", phase: "analyzing", pct: 95, detail: "Building practice track" });
      emit({ type: "log", line: `Transcribed ${notes.length} notes, building song` });
      const song = await buildSongFromNotes(
        notes.map((n) => ({ midi: n.pitch, start: n.start, end: n.end })),
        title
      );
      emit({ type: "progress", phase: "done", pct: 100 });
      emit({ type: "done", song });
    } finally {
      unregisterBuild(buildId);
      if (sandboxId) {
        emit({ type: "log", line: "Cleaning up sandbox" });
        await deleteSandbox(sandboxId);
      }
    }
  });
}
