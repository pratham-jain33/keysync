import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
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
  if (!toolAvailable("yt-dlp")) missing.push("yt-dlp");
  if (!toolAvailable("ffmpeg")) missing.push("ffmpeg");
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
 * Full song pipeline from an audio file: send to the transcription
 * microservice (which slices sections and runs Basic Pitch), then extract
 * melody, detect key/BPM/chords, save. Owns a temp working dir; the caller's
 * input file is left untouched. Throws NoNotesError when transcription finds
 * nothing.
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
    if (allNotes.length === 0) {
      throw new NoNotesError();
    }

    // Music analysis in TypeScript.
    const melody = extractMelody(allNotes);
    const bpm = estimateBpm(melody);
    const key = detectKey(melody);
    const chords = assignChords(melody, key, bpm);
    const duration = Math.max(...allNotes.map((n) => n.end));

    const song: SongData = { songId, title, melody, chords, key, bpm, duration };
    await fs.mkdir(SONGS_DIR, { recursive: true });
    await fs.writeFile(join(SONGS_DIR, `${songId}.json`), JSON.stringify(song));

    return song;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
