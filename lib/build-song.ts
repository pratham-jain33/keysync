import { execFile, execFileSync, spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { extractMelody, estimateBpm } from "@/lib/melody";
import { detectKey, assignChords } from "@/lib/theory";
import type { NoteEvent, Section, SongData } from "@/lib/types";

const SONGS_DIR = resolve(process.cwd(), "data", "songs");

// Transcription runs on a dedicated microservice (separate Render service with
// its own 512MB RAM) because basic-pitch's Python ML stack cannot share the
// web container's 512MB with Next.js.
const TRANSCRIBE_URL = process.env.TRANSCRIBE_SERVICE_URL || "";

// Binary locations. The Docker image puts yt-dlp and ffmpeg on PATH. On a
// runtime without apt or Python (e.g. Render's native Node), they are
// bundled instead: the standalone yt-dlp binary is downloaded to ./bin at
// build time (it needs no system Python) and ffmpeg ships via the
// ffmpeg-static npm package. Env vars override everything. Neither bundled
// path existing means "use PATH", so the Docker image keeps working.
const bundledYtDlp = join(process.cwd(), "bin", "yt-dlp");
const bundledFfmpeg = join(
  process.cwd(),
  "node_modules",
  "ffmpeg-static",
  "ffmpeg"
);
export const YT_DLP_BIN =
  process.env.YT_DLP_PATH ||
  (existsSync(bundledYtDlp) ? bundledYtDlp : "yt-dlp");
export const FFMPEG_BIN =
  process.env.FFMPEG_PATH ||
  (existsSync(bundledFfmpeg) ? bundledFfmpeg : "ffmpeg");

export function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolveP, reject) => {
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
        else resolveP(stdout);
      }
    );
  });
}

function toolAvailable(cmd: string): boolean {
  // ffmpeg 8.x on some builds rejects the double-dash form; try both.
  for (const flag of ["-version", "--version"]) {
    try {
      execFileSync(cmd, [flag], { stdio: "ignore" });
      return true;
    } catch {
      /* try next flag */
    }
  }
  return false;
}

// The installed tools never change while the server runs, so check once per
// process.
let cachedMissing: string[] | null = null;
export function missingTools(): string[] {
  if (cachedMissing) return cachedMissing;
  const missing: string[] = [];
  if (!toolAvailable(YT_DLP_BIN)) missing.push("yt-dlp");
  if (!toolAvailable(FFMPEG_BIN)) missing.push("ffmpeg");
  if (!TRANSCRIBE_URL) missing.push("TRANSCRIBE_SERVICE_URL env var");
  cachedMissing = missing;
  return missing;
}

export function parseSections(input: unknown): Section[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (s): s is Section =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as Section).start === "number" &&
        typeof (s as Section).end === "number" &&
        (s as Section).end > (s as Section).start &&
        (s as Section).start >= 0
    )
    .sort((a, b) => a.start - b.start);
}

function parseNotes(raw: unknown): NoteEvent[] {
  if (Array.isArray(raw)) {
    return (raw as NoteEvent[]).filter(
      (n) =>
        typeof n === "object" &&
        n !== null &&
        typeof n.start === "number" &&
        typeof n.end === "number" &&
        typeof n.midi === "number"
    );
  }
  throw new Error("transcription service returned unexpected output");
}

export class NoNotesError extends Error {
  constructor() {
    super(
      "No piano notes were detected in the selected sections. Try marking a section where the piano plays cleanly."
    );
    this.name = "NoNotesError";
  }
}

/**
 * Full song pipeline from note events: extract melody, detect key/BPM/chords,
 * save. Shared by the audio transcription path and the sheet-music (MIDI)
 * path. Owns a temp working dir; the caller's input file is left untouched.
 * Throws NoNotesError when transcription finds nothing.
 */
export async function buildSongFromNotes(
  allNotes: NoteEvent[],
  title: string
): Promise<SongData> {
  const songId = randomBytes(8).toString("hex");

  const notes = allNotes
    .filter(
      (n) =>
        typeof n === "object" &&
        n !== null &&
        typeof n.start === "number" &&
        typeof n.end === "number" &&
        typeof n.midi === "number"
    )
    .sort((a, b) => a.start - b.start);
  if (notes.length === 0) {
    throw new NoNotesError();
  }

  // Music analysis in TypeScript.
  const melody = extractMelody(notes);
  const bpm = estimateBpm(melody);
  const key = detectKey(melody);
  const chords = assignChords(melody, key, bpm);
  const duration = Math.max(...notes.map((n) => n.end));

  const song: SongData = { songId, title, melody, chords, key, bpm, duration };
  await fs.mkdir(SONGS_DIR, { recursive: true });
  await fs.writeFile(join(SONGS_DIR, `${songId}.json`), JSON.stringify(song));

  return song;
}

/**
 * Full song pipeline from an audio file: send to the transcription
 * microservice (which slices sections and runs Basic Pitch), then run the
 * shared note analysis. Owns a temp working dir; the caller's input file is
 * left untouched. Throws NoNotesError when transcription finds nothing.
 */
export async function buildSongFromAudio(
  inputAudio: string,
  title: string,
  sections: Section[]
): Promise<SongData> {
  const songId = randomBytes(8).toString("hex");
  const workDir = join(tmpdir(), `keysync-${songId}`);
  await fs.mkdir(workDir, { recursive: true });

  try {
    // Send the audio to the transcription microservice. It handles slicing,
    // 22050 Hz mono conversion, and Basic Pitch transcription, returning
    // note events with absolute timestamps.
    const audioBytes = await fs.readFile(inputAudio);
    const form = new FormData();
    form.append(
      "audio",
      new Blob([audioBytes], { type: "application/octet-stream" }),
      "input"
    );
    form.append("sections", JSON.stringify(sections));

    const resp = await fetch(`${TRANSCRIBE_URL}/transcribe`, {
      method: "POST",
      body: form,
      // Transcription takes minutes; allow 10 min.
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    const body: unknown = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `transcription service HTTP ${resp.status}`;
      if (resp.status === 422) throw new NoNotesError();
      throw new Error(msg);
    }
    const allNotes = parseNotes(
      (body as { notes?: unknown }).notes
    ).sort((a, b) => a.start - b.start);

    return buildSongFromNotes(allNotes, title);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Streaming build pipeline (real progress + live backend logs).
//
// Instead of uploading the whole file and blocking on one opaque request, the
// Node route slices the audio locally into 16kHz-mono 30s chunks (bundled
// ffmpeg) and transcribes them one at a time against the SAME /transcribe
// contract. Each chunk feeds the service identical audio to the old 30s
// server-side slicing, so the note output is byte-identical — only the
// visibility and the upload size change. Progress and log events are emitted
// as the work happens; the route turns them into Server-Sent Events.
// ---------------------------------------------------------------------------

export type BuildPhase =
  | "warming"
  | "downloading"
  | "preparing"
  | "transcribing"
  | "analyzing"
  | "done";

export interface BuildEvent {
  type: "log" | "progress" | "done" | "error";
  /** log: a backend line to show in the panel and mirror to console */
  line?: string;
  /** progress: coarse phase + overall 0..100 percentage */
  phase?: BuildPhase;
  pct?: number;
  detail?: string;
  /** done: the finished song */
  song?: SongData;
  /** error: human-readable message, optional http-like status (422 = no notes) */
  message?: string;
  status?: number;
}

export type Emit = (ev: BuildEvent) => void;

const CHUNK_SECONDS = 30;

/**
 * Run a child process, streaming each stdout/stderr line to `onLine` as it
 * arrives (so download/slice progress shows up live), and resolving with the
 * full stdout once it exits.
 */
export function runStream(
  cmd: string,
  args: string[],
  onLine?: (line: string) => void,
  cwd?: string
): Promise<string> {
  return new Promise((resolveP, reject) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderrTail = "";
    const pump = (buf: Buffer, keepStdout: boolean) => {
      const text = buf.toString();
      if (keepStdout) stdout += text;
      else stderrTail = (stderrTail + text).slice(-2000);
      // yt-dlp uses \r for its progress bar; treat both as line breaks.
      for (const line of text.split(/[\r\n]+/)) {
        const t = line.trim();
        if (t && onLine) onLine(t);
      }
    };
    child.stdout?.on("data", (b: Buffer) => pump(b, true));
    child.stderr?.on("data", (b: Buffer) => pump(b, false));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveP(stdout);
      else reject(new Error(`${cmd} failed: ${stderrTail || `exit ${code}`}`));
    });
  });
}

/**
 * Nudge the transcription service awake. Render's free tier spins the
 * container down after ~15min idle; firing /health at the very start of a
 * build overlaps that 30-60s cold start with the download/slice work instead
 * of paying for it serially. Fire-and-forget: errors are ignored.
 */
export function warmTranscriber(): void {
  if (!TRANSCRIBE_URL) return;
  fetch(`${TRANSCRIBE_URL}/health`, {
    method: "GET",
    signal: AbortSignal.timeout(30 * 1000),
  }).catch(() => {});
}

// yt-dlp needs a JS runtime for YouTube's player challenge (Node ships in the
// runner image), and the android player client dodges the datacenter-IP
// "sign in to confirm you're not a bot" block. Mirrors /api/build.
const YT_DLP_JS = ["--js-runtimes", "node"];
const YT_DLP_CLIENT = ["--extractor-args", "youtube:player_client=android"];
const FFMPEG_LOCATION_ARGS: string[] =
  FFMPEG_BIN === "ffmpeg" ? [] : ["--ffmpeg-location", FFMPEG_BIN];

async function youtubeCookieArgs(dir: string): Promise<string[]> {
  let cookiesTxt = process.env.YTDLP_COOKIES ?? "";
  if (cookiesTxt.includes("\\n") && !cookiesTxt.includes("\n")) {
    cookiesTxt = cookiesTxt.replace(/\\n/g, "\n");
  }
  if (!cookiesTxt.includes("youtube.com")) return [];
  const cookieFile = join(dir, "cookies.txt");
  await fs.writeFile(cookieFile, cookiesTxt, { mode: 0o600 });
  return ["--cookies", cookieFile];
}

/**
 * Download a YouTube video's audio to a wav in `workDir`, streaming yt-dlp's
 * progress lines through `emit`. The title lookup runs in parallel with the
 * download instead of blocking before it. Returns the wav path and title.
 */
export async function downloadYouTubeAudio(
  youtubeUrl: string,
  fallbackTitle: string,
  workDir: string,
  emit: Emit
): Promise<{ wav: string; title: string }> {
  const cookieArgs = await youtubeCookieArgs(workDir);
  const common = [
    ...YT_DLP_JS,
    ...YT_DLP_CLIENT,
    ...FFMPEG_LOCATION_ARGS,
    ...cookieArgs,
  ];

  const titleP = runStream(YT_DLP_BIN, [
    ...common,
    "--print",
    "%(title)s",
    "--skip-download",
    youtubeUrl,
  ])
    .then((t) => t.trim().slice(0, 120))
    .catch(() => "");

  const wav = join(workDir, "full.wav");
  emit({ type: "log", line: "downloading audio from youtube" });
  try {
    await runStream(
      YT_DLP_BIN,
      [
        ...common,
        "--extract-audio",
        "--audio-format",
        "wav",
        "--audio-quality",
        "0",
        "-o",
        wav,
        youtubeUrl,
      ],
      (line) => emit({ type: "log", line })
    );
  } catch (e) {
    const raw = e instanceof Error ? e.message : "yt-dlp failed";
    console.error("yt-dlp download failed:", raw);
    if (/429|not a bot|sign in to confirm|login required/i.test(raw)) {
      throw new Error(
        "YouTube blocked this download. It thinks our server is a bot, so the link route will not work right now. Upload the audio file instead with the upload button above."
      );
    }
    throw e;
  }
  const title = (await titleP) || fallbackTitle;
  return { wav, title };
}

interface AudioChunk {
  file: string;
  /** absolute offset of this chunk within the original audio, seconds */
  absStart: number;
}

/**
 * Slice the input into 16kHz-mono wav chunks of up to CHUNK_SECONDS using the
 * bundled ffmpeg's segment muxer (no ffprobe needed — ffmpeg-static ships
 * ffmpeg only). Marked sections are honored; no sections means the whole
 * file. Returns chunks in play order with their absolute start offset.
 */
async function sliceToChunks(
  inputAudio: string,
  sections: Section[],
  workDir: string,
  emit: Emit
): Promise<AudioChunk[]> {
  const ranges =
    sections.length > 0
      ? sections.map((s) => ({ start: s.start, dur: s.end - s.start }))
      : [{ start: 0, dur: 0 }]; // dur 0 => whole file

  const chunks: AudioChunk[] = [];
  for (let si = 0; si < ranges.length; si++) {
    const { start, dur } = ranges[si];
    const prefix = `s${si}-`;
    const args = ["-y"];
    if (dur > 0) args.push("-ss", String(start), "-t", String(dur));
    args.push(
      "-i",
      inputAudio,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "segment",
      "-segment_time",
      String(CHUNK_SECONDS),
      "-reset_timestamps",
      "1",
      join(workDir, `${prefix}%03d.wav`)
    );
    await runStream(FFMPEG_BIN, args);
    const produced = (await fs.readdir(workDir))
      .filter((f) => f.startsWith(prefix) && f.endsWith(".wav"))
      .sort();
    produced.forEach((f, idx) => {
      chunks.push({
        file: join(workDir, f),
        absStart: start + idx * CHUNK_SECONDS,
      });
    });
  }
  emit({
    type: "log",
    line: `prepared ${chunks.length} chunk(s) at 16 kHz mono`,
  });
  return chunks;
}

/**
 * Transcribe a single pre-sliced chunk against the existing /transcribe
 * endpoint (sections omitted => the whole chunk). Notes come back relative to
 * the chunk; the caller re-bases them to absolute time. A chunk of silence
 * returns 422 from the service, which here just means "no notes in this
 * chunk" — not a failure.
 */
async function transcribeChunkFile(file: string): Promise<NoteEvent[]> {
  const bytes = await fs.readFile(file);
  const form = new FormData();
  form.append(
    "audio",
    new Blob([bytes], { type: "audio/wav" }),
    "chunk.wav"
  );
  const resp = await fetch(`${TRANSCRIBE_URL}/transcribe`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  const body: unknown = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (resp.status === 422) return []; // silent chunk, nothing detected
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `transcription service HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return parseNotes((body as { notes?: unknown }).notes);
}

// Overall progress is split across the real stages so the bar reflects actual
// work: slicing is quick, transcription is the long pole, analysis is instant.
const PCT_PREPARED = 15;
const PCT_TRANSCRIBED = 92;

/**
 * Full streaming song pipeline from an audio file: slice locally, transcribe
 * chunk by chunk emitting real progress + logs, then run the shared note
 * analysis. Musically identical to buildSongFromAudio; only the transport and
 * visibility differ. Owns a temp working dir. Throws NoNotesError when nothing
 * is detected across all chunks.
 */
export async function buildSongFromAudioStreaming(
  inputAudio: string,
  title: string,
  sections: Section[],
  emit: Emit
): Promise<SongData> {
  const workDir = join(
    tmpdir(),
    `keysync-${randomBytes(8).toString("hex")}`
  );
  await fs.mkdir(workDir, { recursive: true });
  try {
    emit({ type: "progress", phase: "preparing", pct: 6, detail: "Preparing audio" });
    const chunks = await sliceToChunks(inputAudio, sections, workDir, emit);
    emit({ type: "progress", phase: "preparing", pct: PCT_PREPARED });
    if (chunks.length === 0) throw new NoNotesError();

    const total = chunks.length;
    const span = PCT_TRANSCRIBED - PCT_PREPARED;
    const allNotes: NoteEvent[] = [];
    for (let i = 0; i < total; i++) {
      const { file, absStart } = chunks[i];
      emit({
        type: "progress",
        phase: "transcribing",
        pct: Math.round(PCT_PREPARED + (i / total) * span),
        detail: `Transcribing chunk ${i + 1} of ${total}`,
      });
      emit({ type: "log", line: `transcribing chunk ${i + 1}/${total} (from ${Math.round(absStart)}s)` });
      const t0 = Date.now();
      const notes = await transcribeChunkFile(file);
      for (const n of notes) {
        n.start += absStart;
        n.end += absStart;
      }
      allNotes.push(...notes);
      emit({
        type: "log",
        line: `chunk ${i + 1}/${total} done: ${notes.length} notes in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      });
    }
    allNotes.sort((a, b) => a.start - b.start);
    emit({ type: "log", line: `detected ${allNotes.length} notes total` });

    emit({ type: "progress", phase: "analyzing", pct: PCT_TRANSCRIBED, detail: "Finding melody, key and chords" });
    const song = await buildSongFromNotes(allNotes, title);
    emit({ type: "progress", phase: "analyzing", pct: 99 });
    emit({
      type: "log",
      line: `built "${song.title}": ${song.melody.length} melody notes, ${song.key.name}, ${song.bpm} bpm`,
    });
    return song;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}





