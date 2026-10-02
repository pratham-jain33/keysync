import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  buildSongFromAudioStreaming,
  downloadYouTubeAudio,
  missingTools,
  parseSections,
  warmTranscriber,
  type Emit,
} from "@/lib/build-song";

/**
 * Background build-job worker.
 *
 * POST /api/jobs returns the job id immediately and calls enqueueJob(); the
 * Node process keeps working after the response is sent (Render runs `next
 * start`, a long-lived process — not serverless — so fire-and-forget
 * promises survive). The phone can sleep or the tab can close; progress and
 * the finished song are written to the build_jobs row, which the client
 * polls via GET /api/jobs.
 *
 * Jobs run strictly serially: the free-tier container has 512MB and each
 * build shells out to yt-dlp/ffmpeg, so concurrency risks OOM.
 */

interface QueuedJob {
  jobId: string;
  accessToken: string;
}

const queued = new Map<string, QueuedJob>();
const inFlight = new Set<string>();
let pumping = false;

function userClient(accessToken: string): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** Queue a job for background processing. Safe to call repeatedly. */
export function enqueueJob(jobId: string, accessToken: string): void {
  if (inFlight.has(jobId) || queued.has(jobId)) return;
  queued.set(jobId, { jobId, accessToken });
  void pump();
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queued.size > 0) {
      const next = queued.keys().next().value as string;
      const job = queued.get(next);
      queued.delete(next);
      if (!job) continue;
      inFlight.add(next);
      try {
        await runJob(job.jobId, job.accessToken);
      } catch (e) {
        console.error(`[jobs] ${job.jobId} crashed:`, e);
      } finally {
        inFlight.delete(next);
      }
    }
  } finally {
    pumping = false;
  }
}

async function runJob(jobId: string, accessToken: string): Promise<void> {
  const supa = userClient(accessToken);
  const { data: job, error } = await supa
    .from("build_jobs")
    .select("*")
    .eq("id", jobId)
    .single();
  if (error || !job) {
    console.error(`[jobs] ${jobId}: could not load job row:`, error?.message);
    return;
  }
  // A restart-recovery pass may have requeued this while another pump runs it.
  if (job.status !== "queued") return;

  const update = async (patch: Record<string, unknown>): Promise<void> => {
    const { error: uerr } = await supa
      .from("build_jobs")
      .update(patch)
      .eq("id", jobId);
    if (uerr) console.error(`[jobs] ${jobId}: row update failed:`, uerr.message);
  };

  const workDir = join(tmpdir(), `keysync-job-${randomBytes(8).toString("hex")}`);
  await fs.mkdir(workDir, { recursive: true });

  try {
    await update({ status: "processing", progress: 1, current_step: "Starting up" });

    const missing = missingTools();
    if (missing.length > 0) {
      throw new Error(`Missing required tools: ${missing.join(", ")}`);
    }

    // Overlap the transcription service's cold start with the download.
    warmTranscriber();

    // Progress writes are throttled: the transcription loop emits many
    // events and each write is a network round-trip.
    let lastPct = -1;
    let lastWrite = 0;
    const emit: Emit = (ev) => {
      if (ev.type === "progress" && typeof ev.pct === "number") {
        const now = Date.now();
        if (ev.pct - lastPct >= 3 || now - lastWrite > 5000) {
          lastPct = ev.pct;
          lastWrite = now;
          void update({
            progress: Math.round(ev.pct),
            current_step: ev.detail ?? null,
          });
        }
      } else if (ev.type === "log" && ev.line) {
        console.log(`[job ${jobId}] ${ev.line}`);
      }
    };

    const sections = parseSections(job.sections);
    let inputAudio: string;
    let title: string =
      typeof job.title === "string" && job.title ? job.title : "Untitled song";

    if (job.kind === "youtube") {
      if (typeof job.source_url !== "string" || !job.source_url) {
        throw new Error("This build has no YouTube link attached.");
      }
      await update({ current_step: "Downloading tutorial audio", progress: 3 });
      const dl = await downloadYouTubeAudio(job.source_url, title, workDir, emit);
      inputAudio = dl.wav;
      if (dl.title) title = dl.title;
    } else {
      if (typeof job.audio_path !== "string" || !job.audio_path) {
        throw new Error("This build has no uploaded audio attached.");
      }
      await update({ current_step: "Fetching your upload", progress: 3 });
      const { data: blob, error: dlErr } = await supa.storage
        .from("build-audio")
        .download(job.audio_path);
      if (dlErr || !blob) {
        throw new Error(
          "Could not fetch the uploaded audio. Please upload it again."
        );
      }
      inputAudio = join(workDir, "upload.bin");
      await fs.writeFile(inputAudio, Buffer.from(await blob.arrayBuffer()));
    }

    const song = await buildSongFromAudioStreaming(
      inputAudio,
      title,
      sections,
      emit
    );

    await update({
      status: "done",
      progress: 100,
      current_step: "Ready",
      title: song.title,
      song_data: song,
      error: null,
    });

    // Best-effort: the source upload has served its purpose.
    if (typeof job.audio_path === "string" && job.audio_path) {
      await supa.storage.from("build-audio").remove([job.audio_path]).catch(() => {});
    }
    console.log(`[jobs] ${jobId}: done — "${song.title}"`);
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Build failed for an unknown reason.";
    console.error(`[jobs] ${jobId}: failed:`, message);
    await update({ status: "failed", error: message, current_step: "Failed" });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
