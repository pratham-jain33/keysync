import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { extractMelody, estimateBpm } from "@/lib/melody";
import { detectKey, assignChords } from "@/lib/theory";
import type { NoteEvent, Section, SongData } from "@/lib/types";

export const runtime = "nodejs";

const SONGS_DIR = resolve(process.cwd(), "data", "songs");
const SCRIPTS_DIR = resolve(process.cwd(), "scripts");

// Which Python to use for transcription. Point at a virtualenv Python if you
// installed basic-pitch there, e.g. PYTHON_BIN=/path/to/venv/bin/python
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";

const YT_RE =
  /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/watch\?[^#]*v=|youtu\.be\/)([\w-]{11})/;

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
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

function parseNotes(raw: string): NoteEvent[] {
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return (parsed as NoteEvent[]).filter(
      (n) =>
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

export async function POST(req: NextRequest) {
  let body: { youtubeUrl?: string; sections?: Section[]; title?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const match = typeof body.youtubeUrl === "string" && body.youtubeUrl.match(YT_RE);
  if (!match) {
    return NextResponse.json(
      { error: "That is not a valid YouTube watch URL" },
      { status: 400 }
    );
  }
  const youtubeUrl = body.youtubeUrl as string;

  const sections: Section[] =
    Array.isArray(body.sections) && body.sections.length > 0
      ? body.sections
          .filter(
            (s) =>
              typeof s.start === "number" &&
              typeof s.end === "number" &&
              s.end > s.start &&
              s.start >= 0
          )
          .sort((a, b) => a.start - b.start)
      : [];

  const missing: string[] = [];
  if (!toolAvailable("yt-dlp")) missing.push("yt-dlp");
  if (!toolAvailable("ffmpeg")) missing.push("ffmpeg");
  if (!toolAvailable(PYTHON_BIN)) missing.push(PYTHON_BIN);
  // basic-pitch is a Python package, not a binary: check importability directly.
  if (missing.length === 0 && !pythonHasBasicPitch()) {
    missing.push("basic-pitch (pip install basic-pitch)");
  }
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: `Missing required tools: ${missing.join(", ")}. See README.md for install instructions.`,
      },
      { status: 400 }
    );
  }

  const songId = randomBytes(8).toString("hex");
  const workDir = join(tmpdir(), `keysync-${songId}`);
  await fs.mkdir(workDir, { recursive: true });

  try {
    // Best-effort title lookup (never fails the build).
    let title = typeof body.title === "string" ? body.title : "Untitled song";
    try {
      const t = await run("yt-dlp", [
        "--print",
        "%(title)s",
        "--skip-download",
        youtubeUrl,
      ]);
      if (t.trim()) title = t.trim().slice(0, 120);
    } catch {
      /* keep default */
    }

    // 1. Download best audio and convert to wav.
    const fullWav = join(workDir, "full.wav");
    await run("yt-dlp", [
      "--extract-audio",
      "--audio-format",
      "wav",
      "--audio-quality",
      "0",
      "-o",
      fullWav,
      youtubeUrl,
    ]);

    // 2. Slice sections (or the whole file) to 22050 Hz mono wavs.
    const jobs: { wav: string; offset: number }[] = [];
    if (sections.length === 0) {
      const wav = join(workDir, "section-0.wav");
      await run("ffmpeg", [
        "-y",
        "-i",
        fullWav,
        "-ar",
        "22050",
        "-ac",
        "1",
        wav,
      ]);
      jobs.push({ wav, offset: 0 });
    } else {
      for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        const wav = join(workDir, `section-${i}.wav`);
        await run("ffmpeg", [
          "-y",
          "-ss",
          String(s.start),
          "-to",
          String(s.end),
          "-i",
          fullWav,
          "-ar",
          "22050",
          "-ac",
          "1",
          wav,
        ]);
        jobs.push({ wav, offset: s.start });
      }
    }

    // 3. Transcribe each section and merge with time offsets.
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
      return NextResponse.json(
        { error: "No piano notes were detected in the selected sections. Try marking a section where the piano plays cleanly." },
        { status: 422 }
      );
    }

    // 4. Music analysis in TypeScript.
    const melody = extractMelody(allNotes);
    const bpm = estimateBpm(melody);
    const key = detectKey(melody);
    const chords = assignChords(melody, key, bpm);
    const duration = Math.max(...allNotes.map((n) => n.end));

    const song: SongData = { songId, title, melody, chords, key, bpm, duration };
    await fs.mkdir(SONGS_DIR, { recursive: true });
    await fs.writeFile(join(SONGS_DIR, `${songId}.json`), JSON.stringify(song));

    return NextResponse.json({ song });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Build failed";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
