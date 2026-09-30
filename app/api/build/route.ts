import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  run,
  missingTools,
  parseSections,
  buildSongFromAudio,
  NoNotesError,
} from "@/lib/build-song";
import type { Section } from "@/lib/types";

export const runtime = "nodejs";

const YT_RE =
  /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/watch\?[^#]*v=|youtu\.be\/)([\w-]{11})/;

// YouTube's player challenge needs a JavaScript runtime. The Docker runner
// image already ships Node 20, so point yt-dlp at it (deno is yt-dlp's
// default, but it is not installed in the image).
const YT_DLP_JS = ["--js-runtimes", "node"];
// YouTube's web client now hits datacenter IPs with "Sign in to confirm
// you're not a bot". The android player client still works without sign-in.
const YT_DLP_CLIENT = ["--extractor-args", "youtube:player_client=android"];

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

  const missing = missingTools();
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: `Missing required tools: ${missing.join(", ")}. See README.md for install instructions.`,
      },
      { status: 400 }
    );
  }

  const dlDir = join(tmpdir(), `keysync-dl-${randomBytes(8).toString("hex")}`);
  await fs.mkdir(dlDir, { recursive: true });

  // Optional YouTube authorization. If YTDLP_COOKIES holds a Netscape-format
  // cookies.txt exported from a logged-in browser, yt-dlp's requests look
  // like a signed-in user instead of a datacenter bot, which clears the
  // "Sign in to confirm you're not a bot" block. Without the env var,
  // downloads run unauthenticated exactly as before.
  const cookieArgs: string[] = [];
  let cookiesTxt = process.env.YTDLP_COOKIES ?? "";
  if (cookiesTxt.includes("\\n") && !cookiesTxt.includes("\n")) {
    cookiesTxt = cookiesTxt.replace(/\\n/g, "\n");
  }
  if (cookiesTxt.includes("youtube.com")) {
    const cookieFile = join(dlDir, "cookies.txt");
    await fs.writeFile(cookieFile, cookiesTxt, { mode: 0o600 });
    cookieArgs.push("--cookies", cookieFile);
  }

  try {
    // Best-effort title lookup (never fails the build).
    let title = typeof body.title === "string" ? body.title : "Untitled song";
    try {
      const t = await run("yt-dlp", [
        ...YT_DLP_JS,
        ...YT_DLP_CLIENT,
        ...cookieArgs,
        "--print",
        "%(title)s",
        "--skip-download",
        youtubeUrl,
      ]);
      if (t.trim()) title = t.trim().slice(0, 120);
    } catch {
      /* keep default */
    }

    // Download best audio and convert to wav.
    const fullWav = join(dlDir, "full.wav");
    try {
      await run("yt-dlp", [
        ...YT_DLP_JS,
        ...YT_DLP_CLIENT,
        ...cookieArgs,
        "--extract-audio",
        "--audio-format",
        "wav",
        "--audio-quality",
        "0",
        "-o",
        fullWav,
        youtubeUrl,
      ]);
    } catch (e) {
      // YouTube aggressively blocks datacenter IPs ("Sign in to confirm
      // you're not a bot", HTTP 429). The raw yt-dlp dump is useless to a
      // user, so log it server-side and return a plain explanation that
      // points at the audio-upload fallback.
      const raw = e instanceof Error ? e.message : "yt-dlp failed";
      console.error("yt-dlp download failed:", raw);
      if (/429|not a bot|sign in to confirm|login required/i.test(raw)) {
        throw new Error(
          "YouTube blocked this download. It thinks our server is a bot, so the link route will not work right now. Upload the audio file instead with the upload button above."
        );
      }
      throw e;
    }

    const song = await buildSongFromAudio(fullWav, title, sections);
    return NextResponse.json({ song });
  } catch (e) {
    if (e instanceof NoNotesError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    const message = e instanceof Error ? e.message : "Build failed";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await fs.rm(dlDir, { recursive: true, force: true });
  }
}
