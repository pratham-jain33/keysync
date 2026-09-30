"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Section, SongData } from "@/lib/types";
import {
  deleteSavedSong,
  listSavedSongs,
  saveSong,
  type SavedSongMeta,
} from "@/lib/saved-songs";

// Minimal typings for the YouTube IFrame API (no extra dependency).
interface YTPlayerLike {
  getCurrentTime(): number;
  getDuration(): number;
  playVideo(): void;
  pauseVideo(): void;
  destroy(): void;
}
interface YTNamespaceLike {
  Player: new (
    el: HTMLElement,
    opts: { videoId: string; playerVars?: Record<string, number> }
  ) => YTPlayerLike;
}
declare global {
  interface Window {
    YT?: YTNamespaceLike;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const YT_RE =
  /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/watch\?[^#]*v=|youtu\.be\/)([\w-]{11})/;

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const BUILD_STAGES = [
  "Downloading tutorial audio…",
  "Cutting your marked sections…",
  "Transcribing notes (this takes a minute)…",
  "Finding the melody, key and chords…",
];

export default function Home() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [videoId, setVideoId] = useState<string | null>(null);
  const [urlError, setUrlError] = useState("");
  const [sections, setSections] = useState<Section[]>([]);
  const [pendingStart, setPendingStart] = useState<number | null>(null);
  const [building, setBuilding] = useState(false);
  const [stage, setStage] = useState(0);
  const [buildError, setBuildError] = useState("");
  const [saved, setSaved] = useState<SavedSongMeta[]>([]);

  // Load the on-device song library.
  useEffect(() => {
    listSavedSongs().then(setSaved).catch(() => {});
  }, []);

  const removeSaved = async (id: string) => {
    await deleteSavedSong(id).catch(() => {});
    setSaved((prev) => prev.filter((s) => s.id !== id));
  };

  const playerHostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayerLike | null>(null);

  const loadVideo = useCallback(() => {
    const m = url.trim().match(YT_RE);
    if (!m) {
      setUrlError("Paste a valid YouTube watch URL, e.g. youtube.com/watch?v=…");
      setVideoId(null);
      return;
    }
    setUrlError("");
    setSections([]);
    setPendingStart(null);
    setBuildError("");
    setVideoId(m[1]);
  }, [url]);

  // Create the YouTube player when a video id is set.
  useEffect(() => {
    if (!videoId || !playerHostRef.current) return;
    playerRef.current?.destroy();
    playerRef.current = null;

    const create = () => {
      if (!window.YT || !playerHostRef.current) return;
      playerRef.current = new window.YT.Player(playerHostRef.current, {
        videoId,
        playerVars: { rel: 0 },
      });
    };

    if (window.YT?.Player) {
      create();
    } else {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
      window.onYouTubeIframeAPIReady = create;
    }

    return () => {
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [videoId]);

  const markStart = () => {
    const t = playerRef.current?.getCurrentTime() ?? 0;
    setPendingStart(t);
  };

  const markEnd = () => {
    if (pendingStart == null) return;
    const t = playerRef.current?.getCurrentTime() ?? 0;
    if (t <= pendingStart + 1) return; // ignore accidental taps
    setSections((prev) =>
      [...prev, { start: pendingStart, end: t }].sort((a, b) => a.start - b.start)
    );
    setPendingStart(null);
  };

  const removeSection = (i: number) =>
    setSections((prev) => prev.filter((_, idx) => idx !== i));

  const build = async () => {
    if (!videoId || building) return;
    setBuilding(true);
    setBuildError("");
    setStage(0);
    const timer = setInterval(
      () => setStage((s) => Math.min(s + 1, BUILD_STAGES.length - 1)),
      20000
    );
    try {
      const res = await fetch("/api/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ youtubeUrl: url.trim(), sections }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Build failed");
      // Persist the finished song on this device so it survives server
      // redeploys (Render's free tier has no persistent disk). Saving never
      // fails the build: if storage is blocked we fall back to the server copy.
      const song = data.song as SongData;
      let routeId: string = song.songId;
      try {
        routeId = await saveSong(song, url.trim());
      } catch {
        /* use the server copy */
      }
      router.push(`/practice/${routeId}`);
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : "Build failed");
      setBuilding(false);
      clearInterval(timer);
    }
  };

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <header className="mb-10 text-center">
        <h1 className="text-4xl font-bold tracking-tight text-white">
          Key<span className="text-[#2bff88]">Sync</span>
        </h1>
        <p className="mt-3 text-neutral-400">
          Paste a YouTube piano tutorial. Get the melody plus a generated
          left hand. Practice it on your real piano.
        </p>
      </header>

      {/* Step 1: link */}
      <section className="rounded-2xl border border-neutral-800 bg-[#101311] p-6">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-500">
          1 · Tutorial link
        </h2>
        <div className="mt-4 flex gap-3">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && loadVideo()}
            placeholder="https://www.youtube.com/watch?v=…"
            spellCheck={false}
            className="h-12 flex-1 rounded-xl border border-neutral-700 bg-[#0a0c0a] px-4 text-neutral-100 placeholder:text-neutral-600 focus:border-[#2bff88] focus:outline-none"
          />
          <button
            onClick={loadVideo}
            className="h-12 rounded-xl bg-[#2bff88] px-6 font-semibold text-black transition hover:brightness-110 active:scale-[0.98]"
          >
            Load
          </button>
        </div>
        {urlError && <p className="mt-3 text-sm text-red-400">{urlError}</p>}
      </section>

      {/* Step 2: mark sections */}
      {videoId && (
        <section className="mt-6 rounded-2xl border border-neutral-800 bg-[#101311] p-6">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-500">
            2 · Mark the playing sections
          </h2>
          <p className="mt-2 text-sm text-neutral-400">
            Skip the parts where the teacher talks. Mark each clean playthrough.
            No marks means the whole video is used.
          </p>

          <div className="mt-4 overflow-hidden rounded-xl border border-neutral-800">
            <div ref={playerHostRef} className="aspect-video w-full" />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={markStart}
              disabled={pendingStart != null}
              className="h-11 rounded-xl border border-[#2bff88] px-5 font-medium text-[#2bff88] transition hover:bg-[#2bff88]/10 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pendingStart != null
                ? `Start: ${fmt(pendingStart)}`
                : "Mark start"}
            </button>
            <button
              onClick={markEnd}
              disabled={pendingStart == null}
              className="h-11 rounded-xl bg-[#2bff88] px-5 font-semibold text-black transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Mark end
            </button>
            {pendingStart != null && (
              <button
                onClick={() => setPendingStart(null)}
                className="h-11 rounded-xl px-4 text-sm text-neutral-400 transition hover:text-white"
              >
                Cancel
              </button>
            )}
          </div>

          {sections.length > 0 && (
            <ul className="mt-4 space-y-2">
              {sections.map((s, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between rounded-xl border border-neutral-800 bg-[#0a0c0a] px-4 py-3"
                >
                  <span className="text-sm text-neutral-200">
                    Section {i + 1} · {fmt(s.start)} → {fmt(s.end)}
                  </span>
                  <button
                    onClick={() => removeSection(i)}
                    className="rounded-lg px-3 py-1 text-sm text-neutral-500 transition hover:bg-neutral-800 hover:text-white"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Step 3: build */}
      {videoId && (
        <section className="mt-6 rounded-2xl border border-neutral-800 bg-[#101311] p-6">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-500">
            3 · Build your practice track
          </h2>
          <button
            onClick={build}
            disabled={building}
            className="mt-4 w-full rounded-xl bg-[#2bff88] py-4 text-lg font-bold text-black transition hover:brightness-110 active:scale-[0.99] disabled:cursor-wait disabled:opacity-70"
          >
            {building ? BUILD_STAGES[stage] : "Build practice track"}
          </button>
          {building && (
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-neutral-800">
              <div className="h-full w-1/3 animate-[slide_1.2s_ease-in-out_infinite] rounded-full bg-[#2bff88]" />
            </div>
          )}
          {buildError && (
            <p className="mt-3 text-sm text-red-400">{buildError}</p>
          )}
          {!building && !buildError && (
            <p className="mt-3 text-sm text-neutral-500">
              Transcription runs locally and takes a minute or two depending on
              the video length.
            </p>
          )}
        </section>
      )}

      {/* Saved songs library */}
      {saved.length > 0 && (
        <section className="mt-6 rounded-2xl border border-neutral-800 bg-[#101311] p-6">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-500">
            Your saved songs
          </h2>
          <ul className="mt-4 space-y-2">
            {saved.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-neutral-800 bg-[#0a0c0a] px-4 py-3"
              >
                <button
                  onClick={() => router.push(`/practice/${s.id}`)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm font-medium text-neutral-100">
                    {s.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-neutral-500">
                    {s.noteCount} notes · {fmt(s.duration)} ·{" "}
                    {new Date(s.createdAt).toLocaleDateString()}
                  </span>
                </button>
                <button
                  onClick={() => removeSaved(s.id)}
                  className="shrink-0 rounded-lg px-3 py-1 text-sm text-neutral-500 transition hover:bg-neutral-800 hover:text-white"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-neutral-600">
            Saved in this browser. They stay even when the server redeploys.
          </p>
        </section>
      )}

      <footer className="mt-12 text-center text-sm text-neutral-600">
        KeySync listens through your microphone. Nothing is uploaded; the audio
        never leaves your machine.
      </footer>

      <style>{`@keyframes slide { 0% { margin-left: -33%; } 100% { margin-left: 100%; } }`}</style>
    </main>
  );
}
