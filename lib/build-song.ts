import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { extractMelody, estimateBpm } from "@/lib/melody";
import { detectKey, assignChords } from "@/lib/theory";
import type { NoteEvent, Section, SongData } from "@/lib/types";

const SONGS_DIR = resolve(process.cwd(), "data", "songs");
const SCRIPTS_DIR = resolve(process.cwd(), "scripts");

// Which Python to use for transcription. Point at a virtualenv Python if you
// installed basic-pitch there, e.g. PYTHON_BIN=/path/to/venv/bin/python
export const PYTHON_BIN = process.env.PYTHON_BIN || "python3";

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

function pythonHasBasicPitch(): boolean {
  try {
    execFileSync(PYTHON_BIN, ["-c", "import basic_pitch"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// The installed tools never change while the server runs, so check once per
// process. The basic-pitch import check spawns a Python interpreter and
// imports numpy/onnxruntime (slow, ~200MB transient); doing it per request
// risks OOM on small hosts and blocks the event loop for seconds.
let cachedMissing: string[] | null = null;
export function missingTools(): string[] {
  if (cachedMissing) return cachedMissing;
  const missing: string[] = [];
  if (!toolAvailable("yt-dlp")) missing.push("yt-dlp");
  if (!toolAvailable("ffmpeg")) missing.push("ffmpeg");
  if (!toolAvailable(PYTHON_BIN)) missing.push(PYTHON_BIN);
  // basic-pitch is a Python package, not a binary: check importability directly.
  if (missing.length === 0 && !pythonHasBasicPitch()) {
    missing.push("basic-pitch (pip install basic-pitch)");
  }
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

function parseNotes(raw: string): NoteEvent[] {
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return (parsed as NoteEvent[]).filter(
      (n) =>
        typeof n === "object" &&
        n !== null &&
        typeof n.start === "number" &&
        typeof n.end === "number" &&
        typeof n.midi === "number"
    );
  }
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    throw new Error(`transcribe.py: ${(parsed as { error: string }).error}`);
  }
  throw new Error("transcribe.py returned unexpected output");
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
 * Full song pipeline from an audio file: slice sections to 22050 Hz mono,
 * transcribe with Basic Pitch, extract melody, detect key/BPM/chords, save.
 * Owns a temp working dir; the caller's input file is left untouched.
 * Throws NoNotesError when transcription finds nothing.
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
    // Slice sections (or the whole file) to 22050 Hz mono wavs.
    // Sections longer than 30s are split into 30s chunks: each transcription
    // spawns a Python process loading basic-pitch (numpy + onnxruntime +
    // model, ~200MB fixed). Smaller chunks keep peak memory under Render's
    // 512MB free-tier limit.
    const MAX_CHUNK = 30;
    const jobs: { wav: string; offset: number }[] = [];
    const slices: { start: number; end: number }[] = [];
    if (sections.length === 0) {
      // Whole file: probe duration so we can chunk it too.
      const probe = await run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        inputAudio,
      ]);
      const totalDur = parseFloat(probe.trim()) || 0;
      let cur = 0;
      while (cur < totalDur) {
        slices.push({ start: cur, end: Math.min(cur + MAX_CHUNK, totalDur) });
        cur += MAX_CHUNK;
      }
      if (slices.length === 0) slices.push({ start: 0, end: totalDur });
    } else {
      for (const s of sections) {
        let cur = s.start;
        while (cur < s.end) {
          const chunkEnd = Math.min(cur + MAX_CHUNK, s.end);
          slices.push({ start: cur, end: chunkEnd });
          cur = chunkEnd;
        }
      }
    }
    let idx = 0;
    for (const sl of slices) {
      const wav = join(workDir, `section-${idx}.wav`);
      await run("ffmpeg", [
        "-y",
        "-ss",
        String(sl.start),
        "-to",
        String(sl.end),
        "-i",
        inputAudio,
        "-ar",
        "22050",
        "-ac",
        "1",
        wav,
      ]);
      jobs.push({ wav, offset: sl.start });
      idx++;
    }

    // Transcribe each section and merge with time offsets.
    const allNotes: NoteEvent[] = [];
    for (const job of jobs) {
      const raw = await run(PYTHON_BIN, [join(SCRIPTS_DIR, "transcribe.py"), job.wav]);
      const notes = parseNotes(raw);
      for (const n of notes) {
        allNotes.push({
          start: n.start + job.offset,
          end: n.end + job.offset,
          midi: n.midi,
          velocity: n.velocity,
        });
      }
    }
    allNotes.sort((a, b) => a.start - b.start);
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
