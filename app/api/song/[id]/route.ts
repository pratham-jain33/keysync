import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import type { SongData } from "@/lib/types";

export const runtime = "nodejs";

const SONGS_DIR = resolve(process.cwd(), "data", "songs");
const ID_RE = /^[a-f0-9]{16}$/;

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!ID_RE.test(params.id)) {
    return NextResponse.json({ error: "Unknown song" }, { status: 404 });
  }
  try {
    const raw = await fs.readFile(join(SONGS_DIR, `${params.id}.json`), "utf8");
    const song = JSON.parse(raw) as SongData;
    return NextResponse.json({ song });
  } catch {
    return NextResponse.json({ error: "Unknown song" }, { status: 404 });
  }
}
