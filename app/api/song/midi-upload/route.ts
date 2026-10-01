import { NextRequest, NextResponse } from "next/server";
import {
  buildSongFromMidi,
  NoNotesError,
} from "@/lib/build-song";
import { parseMidiToNotes, looksLikeMidi } from "@/lib/midi";

export const runtime = "nodejs";

// Direct MIDI upload: the user grabs a .mid/.midi file from anywhere
// (MuseScore, a sheet-music store, their own export) and gets the same
// practice track without any transcription step.
const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json(
      { error: "Attach a MIDI file as the 'file' field" },
      { status: 400 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "MIDI file is too large (max 10 MB)" },
      { status: 413 }
    );
  }
  const name = (file.name || "").toLowerCase();
  if (!name.endsWith(".mid") && !name.endsWith(".midi")) {
    return NextResponse.json(
      { error: "Only .mid / .midi files are supported" },
      { status: 400 }
    );
  }

  const title =
    typeof form.get("title") === "string" && (form.get("title") as string).trim()
      ? (form.get("title") as string).trim().slice(0, 120)
      : file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Uploaded MIDI";

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    if (!looksLikeMidi(buf)) {
      return NextResponse.json(
        { error: "That file does not look like a MIDI file" },
        { status: 400 }
      );
    }
    const notes = parseMidiToNotes(buf);
    const song = await buildSongFromMidi(notes, title);
    return NextResponse.json({ song });
  } catch (e) {
    if (e instanceof NoNotesError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    const message = e instanceof Error ? e.message : "Build failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
