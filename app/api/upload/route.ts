import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  missingTools,
  parseSections,
  buildSongFromAudio,
  NoNotesError,
} from "@/lib/build-song";

export const runtime = "nodejs";

// Backup input when YouTube fetching is blocked: upload an audio file
// (mp3/m4a/wav/ogg) plus title and sections, get back the same song object.
const MAX_BYTES = 100 * 1024 * 1024;
const ALLOWED_EXT = new Set([".mp3", ".m4a", ".wav", ".ogg", ".flac", ".webm"]);

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = form.get("audio");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json(
      { error: "Attach an audio file as the 'audio' field" },
      { status: 400 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "Audio file is too large (max 100 MB)" },
      { status: 413 }
    );
  }
  const ext = extname(file.name).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json(
      { error: `Unsupported audio type '${ext || "(none)"}'. Use mp3, m4a, wav, ogg or flac.` },
      { status: 400 }
    );
  }

  const title =
    typeof form.get("title") === "string" && (form.get("title") as string).trim()
      ? (form.get("title") as string).trim().slice(0, 120)
      : file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Uploaded song";

  let sectionsRaw: unknown = [];
  const sectionsField = form.get("sections");
  if (typeof sectionsField === "string" && sectionsField) {
    try {
      sectionsRaw = JSON.parse(sectionsField);
    } catch {
      return NextResponse.json(
        { error: "'sections' must be JSON like [{\"start\":0,\"end\":60}]" },
        { status: 400 }
      );
    }
  }
  const sections = parseSections(sectionsRaw);

  const missing = missingTools();
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: `Missing required tools: ${missing.join(", ")}. See README.md for install instructions.`,
      },
      { status: 400 }
    );
  }

  const ulDir = join(tmpdir(), `keysync-ul-${randomBytes(8).toString("hex")}`);
  await fs.mkdir(ulDir, { recursive: true });

  try {
    const inPath = join(ulDir, `upload${ext}`);
    await fs.writeFile(inPath, Buffer.from(await file.arrayBuffer()));
    const song = await buildSongFromAudio(inPath, title, sections);
    return NextResponse.json({ song });
  } catch (e) {
    if (e instanceof NoNotesError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    const message = e instanceof Error ? e.message : "Build failed";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await fs.rm(ulDir, { recursive: true, force: true });
  }
}
