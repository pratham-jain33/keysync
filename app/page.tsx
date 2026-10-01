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
import { LogoMark, EmptyKeys } from "@/components/Brand";

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

const SONG_BUILD_STAGES = [
  "Fetching the sheet music…",
  "Reading the notes…",
  "Finding the melody, key and chords…",
];

type InputMode = "tutorial" | "song";

export default function Home() {
  const router = useRouter();
  const [mode, setMode] = useState<InputMode>("tutorial");
  const [url, setUrl] = useState("");
  const [videoId, setVideoId] = useState<string | null>(null);
  const [urlError, setUrlError] = useState("");
  const [sections, setSections] = useState<Section[]>([]);
  const [pendingStart, setPendingStart] = useState<number | null>(null);
  const [building, setBuilding] = useState(false);
  const [stage, setStage] = useState(0);
  const [buildError, setBuildError] = useState("");
  const [saved, setSaved] = useState<SavedSongMeta[]>([]);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  // Song-name mode (sheet music) state.
  const [songQuery, setSongQuery] = useState("");
  const [midiFile, setMidiFile] = useState<File | null>(null);
  const midiInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const clearAudio = useCallback(() => {
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setAudioFile(null);
  }, []);

  // Revoke the object URL on unmount.
  useEffect(() => {
    return () => {
      setAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return prev;
      });
    };
  }, []);

  const onAudioPicked = (f: File | null) => {
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return f ? URL.createObjectURL(f) : null;
    });
    setAudioFile(f);
    if (f) {
      setVideoId(null);
      setSections([]);
      setPendingStart(null);
      setBuildError("");
    }
  };

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
    clearAudio();
    if (fileInputRef.current) fileInputRef.current.value = "";
    setVideoId(m[1]);
  }, [url, clearAudio]);

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

  const currentTime = () =>
    audioFile ? (audioRef.current?.currentTime ?? 0) : (playerRef.current?.getCurrentTime() ?? 0);

  const markStart = () => {
    const t = currentTime();
    setPendingStart(t);
  };

  const markEnd = () => {
    if (pendingStart == null) return;
    const t = currentTime();
    if (t <= pendingStart + 1) return; // ignore accidental taps
    setSections((prev) =>
      [...prev, { start: pendingStart, end: t }].sort((a, b) => a.start - b.start)
    );
    setPendingStart(null);
  };

  const removeSection = (i: number) =>
    setSections((prev) => prev.filter((_, idx) => idx !== i));

  const build = async () => {
    if (building) return;
    if (!videoId && !audioFile) return;
    setBuilding(true);
    setBuildError("");
    setStage(0);
    const timer = setInterval(
      () => setStage((s) => Math.min(s + 1, BUILD_STAGES.length - 1)),
      20000
    );
    try {
      let song: SongData;
      if (audioFile) {
        // Backup path: user-supplied audio file (used when YouTube fetching
        // is blocked). Marked sections are honored; no marks means the
        // whole file is used.
        const form = new FormData();
        form.append("audio", audioFile);
        form.append("title", audioFile.name.replace(/\.[^.]+$/, ""));
        form.append("sections", JSON.stringify(sections));
        const res = await fetch("/api/upload", {
          method: "POST",
          body: form,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Build failed");
        song = data.song as SongData;
      } else {
        const res = await fetch("/api/build", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ youtubeUrl: url.trim(), sections }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Build failed");
        song = data.song as SongData;
      }
      // Persist the finished song on this device so it survives server
      // redeploys (Render's free tier has no persistent disk). Saving never
      // fails the build: if storage is blocked we fall back to the server copy.
      let routeId: string = song.songId;
      try {
        routeId = await saveSong(song, audioFile ? audioFile.name : url.trim());
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

  const finishSongBuild = async (song: SongData, sourceLabel: string) => {
    let routeId: string = song.songId;
    try {
      routeId = await saveSong(song, sourceLabel);
    } catch {
      /* use the server copy */
    }
    router.push(`/practice/${routeId}`);
  };

  const buildFromMidiFile = async () => {
    if (building || !midiFile) return;
    setBuilding(true);
    setBuildError("");
    setStage(0);
    const timer = setInterval(
      () => setStage((s) => Math.min(s + 1, SONG_BUILD_STAGES.length - 1)),
      15000
    );
    try {
      const form = new FormData();
      form.append("file", midiFile);
      const title = songQuery.trim()
        ? songQuery.trim().slice(0, 120)
        : midiFile.name.replace(/\.[^.]+$/, "");
      form.append("title", title);
      const res = await fetch("/api/song/midi-upload", {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Build failed");
      await finishSongBuild(data.song as SongData, midiFile.name);
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : "Build failed");
      setBuilding(false);
      clearInterval(timer);
    }
  };
  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-16">
      <header className="mb-10 flex flex-col items-center text-center sm:mb-14">
        <LogoMark size={60} className="mb-5" />
        <h1 className="font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          Key<span className="text-accent">Sync</span>
        </h1>
        <p className="mt-4 max-w-xl text-balance leading-relaxed text-ink-dim">
          Paste a YouTube piano tutorial, or search a song name for free sheet
          music. Get the melody plus a generated left hand, then practice it on
          your real piano.
        </p>
      </header>

      {/* Step 1: input mode toggle */}
      <div className="mb-6 flex card p-1.5">
        {(["tutorial", "song"] as InputMode[]).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setBuildError("");
            }}
            className={`h-11 flex-1 rounded-xl text-sm font-semibold transition ${
              mode === m
                ? "bg-accent text-accent-ink"
                : "text-ink-dim hover:text-ink"
            }`}
          >
            {m === "tutorial" ? "Tutorial link" : "Song name"}
          </button>
        ))}
      </div>

      {mode === "tutorial" ? (
      <>
      {/* Step 1: link */}
      <section className="card p-4 sm:p-6">
        <h2 className="label-eyebrow text-xs">
          1 · Tutorial link
        </h2>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && loadVideo()}
            placeholder="https://www.youtube.com/watch?v=…"
            spellCheck={false}
            className="h-12 flex-1 rounded-xl border border-line-strong bg-surface-2 px-4 text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <button
            onClick={loadVideo}
            className="h-12 rounded-xl bg-accent px-6 font-semibold text-accent-ink transition hover:brightness-110 active:scale-[0.98]"
          >
            Load
          </button>
        </div>
        {urlError && <p className="mt-3 text-sm text-danger">{urlError}</p>}

        <div className="mt-4 flex items-center gap-3 text-xs text-ink-faint">
          <span className="h-px flex-1 bg-line" />
          or upload an audio file
          <span className="h-px flex-1 bg-line" />
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac"
          className="hidden"
          onChange={(e) => onAudioPicked(e.target.files?.[0] ?? null)}
        />
        {audioFile ? (
          <div className="mt-3 flex items-center justify-between rounded-xl border border-line-strong bg-surface-2 px-4 py-3">
            <span className="truncate text-sm text-ink">
              {audioFile.name}
            </span>
            <button
              onClick={() => {
                clearAudio();
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              className="ml-3 shrink-0 rounded-lg px-3 py-1 text-sm text-ink-faint transition hover:bg-line hover:text-ink"
            >
              Remove
            </button>
          </div>
        ) : (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="mt-3 h-11 w-full rounded-xl border border-dashed border-line-strong text-sm text-ink-dim transition hover:border-accent hover:text-accent"
          >
            Choose mp3 / m4a / wav (backup when YouTube blocks downloads)
          </button>
        )}
      </section>
      </>

      ) : (
      <>
      {/* Song-name mode: guided MIDI flow.
          MuseScore blocks datacenter IPs (Cloudflare), so the server cannot
          fetch scores itself. The user grabs the MIDI in their own browser
          (free MuseScore account) and uploads the .mid here. */}
      <section className="card p-4 sm:p-6">
        <h2 className="label-eyebrow text-xs">
          1 · Song name
        </h2>
        <p className="mt-2 text-sm text-ink-dim">
          Type the song, grab its free MIDI from MuseScore, upload it here.
          The exact notes go straight into your practice track, no
          transcription wait.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            value={songQuery}
            onChange={(e) => setSongQuery(e.target.value)}
            placeholder="e.g. Husn Anuv Jain"
            spellCheck={false}
            className="h-12 flex-1 rounded-xl border border-line-strong bg-surface-2 px-4 text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <a
            href={songQuery.trim() ? `https://musescore.com/sheetmusic?text=${encodeURIComponent(songQuery.trim())}` : "https://musescore.com/sheetmusic"}
            target="_blank"
            rel="noreferrer"
            className="flex h-12 items-center justify-center rounded-xl bg-accent px-6 font-semibold text-accent-ink transition hover:brightness-110 active:scale-[0.98]"
          >
            Find free sheet music
          </a>
        </div>
        <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm text-ink-dim">
          <li>Open a free Piano score on MuseScore (skip the ones marked Official, those are paid).</li>
          <li>Hit Download and pick MIDI. A free MuseScore account is enough.</li>
          <li>Upload the .mid file below and build your practice track.</li>
        </ol>

        <div className="mt-6 flex items-center gap-3 text-xs text-ink-faint">
          <span className="h-px flex-1 bg-line" />
          upload the .mid file
          <span className="h-px flex-1 bg-line" />
        </div>
        <input
          ref={midiInputRef}
          type="file"
          accept=".mid,.midi,audio/midi"
          className="hidden"
          onChange={(e) => {
            setMidiFile(e.target.files?.[0] ?? null);
            setBuildError("");
          }}
        />
        {midiFile ? (
          <div className="mt-3">
            <div className="flex items-center justify-between rounded-xl border border-line-strong bg-surface-2 px-4 py-3">
              <span className="truncate text-sm text-ink">
                {midiFile.name}
              </span>
              <button
                onClick={() => {
                  setMidiFile(null);
                  if (midiInputRef.current) midiInputRef.current.value = "";
                }}
                className="ml-3 shrink-0 rounded-lg px-3 py-1 text-sm text-ink-faint transition hover:bg-line hover:text-ink"
              >
                Remove
              </button>
            </div>
            <button
              onClick={buildFromMidiFile}
              disabled={building}
              className="mt-3 w-full rounded-xl bg-accent py-4 text-lg font-bold text-accent-ink transition hover:brightness-110 active:scale-[0.99] disabled:cursor-wait disabled:opacity-70"
            >
              {building ? SONG_BUILD_STAGES[stage] : "Build practice track"}
            </button>
          </div>
        ) : (
          <button
            onClick={() => midiInputRef.current?.click()}
            className="mt-3 h-11 w-full rounded-xl border border-dashed border-line-strong text-sm text-ink-dim transition hover:border-accent hover:text-accent"
          >
            Choose a .mid file
          </button>
        )}
        {building && (
          <div className="mt-4">
            <p className="text-sm text-ink-dim">
              {SONG_BUILD_STAGES[stage]}
            </p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
              <div className="h-full w-1/3 animate-[slide_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
            </div>
          </div>
        )}
        {buildError && (
          <p className="mt-3 text-sm text-danger">{buildError}</p>
        )}
      </section>
      </>
      )}

      {/* Step 2: mark sections */}
      {(mode === "tutorial" && (videoId || audioFile)) && (
        <section className="mt-6 card p-4 sm:p-6">
          <h2 className="label-eyebrow text-xs">
            2 · Mark the playing sections
          </h2>
          <p className="mt-2 text-sm text-ink-dim">
            Skip the parts where the teacher talks. Mark each clean playthrough.
            No marks means the whole {audioFile ? "file" : "video"} is used.
          </p>

          {videoId ? (
            <div className="mt-4 overflow-hidden rounded-xl border border-line">
              <div ref={playerHostRef} className="aspect-video w-full" />
            </div>
          ) : (
            audioUrl && (
              <audio
                ref={audioRef}
                src={audioUrl}
                controls
                preload="metadata"
                className="mt-4 w-full"
              />
            )
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={markStart}
              disabled={pendingStart != null}
              className="h-11 rounded-xl border border-accent px-5 font-medium text-accent transition hover:bg-accent/10 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pendingStart != null
                ? `Start: ${fmt(pendingStart)}`
                : "Mark start"}
            </button>
            <button
              onClick={markEnd}
              disabled={pendingStart == null}
              className="h-11 rounded-xl bg-accent px-5 font-semibold text-accent-ink transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Mark end
            </button>
            {pendingStart != null && (
              <button
                onClick={() => setPendingStart(null)}
                className="h-11 rounded-xl px-4 text-sm text-ink-dim transition hover:text-ink"
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
                  className="flex items-center justify-between rounded-xl border border-line bg-surface-2 px-4 py-3"
                >
                  <span className="text-sm text-ink">
                    Section {i + 1} · {fmt(s.start)} → {fmt(s.end)}
                  </span>
                  <button
                    onClick={() => removeSection(i)}
                    className="rounded-lg px-3 py-1 text-sm text-ink-faint transition hover:bg-line hover:text-ink"
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
      {(mode === "tutorial" && (videoId || audioFile)) && (
        <section className="mt-6 card p-4 sm:p-6">
          <h2 className="label-eyebrow text-xs">
            3 · Build your practice track
          </h2>
          <button
            onClick={build}
            disabled={building}
            className="mt-4 w-full rounded-xl bg-accent py-4 text-lg font-bold text-accent-ink transition hover:brightness-110 active:scale-[0.99] disabled:cursor-wait disabled:opacity-70"
          >
            {building ? BUILD_STAGES[stage] : "Build practice track"}
          </button>
          {building && (
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-line">
              <div className="h-full w-1/3 animate-[slide_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
            </div>
          )}
          {buildError && (
            <p className="mt-3 text-sm text-danger">{buildError}</p>
          )}
          {!building && !buildError && (
            <p className="mt-3 text-sm text-ink-faint">
              Transcription runs locally and takes a minute or two depending on
              the video length.
            </p>
          )}
        </section>
      )}

      {/* Saved songs library */}
      <section className="mt-6 card p-4 sm:p-6">
        <h2 className="label-eyebrow">Your practice library</h2>
        {saved.length > 0 ? (
          <>
            <ul className="mt-4 space-y-2">
              {saved.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3 transition-colors hover:border-line-strong"
                >
                  <button
                    onClick={() => router.push(`/practice/${s.id}`)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-sm font-medium text-ink">
                      {s.title}
                    </span>
                    <span className="mt-1 block font-mono text-xs text-ink-faint">
                      {s.noteCount} notes · {fmt(s.duration)} ·{" "}
                      {new Date(s.createdAt).toLocaleDateString()}
                    </span>
                  </button>
                  <button
                    onClick={() => removeSaved(s.id)}
                    className="btn-ghost shrink-0"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-faint">
              Saved in this browser. They stay even when the server redeploys.
            </p>
          </>
        ) : (
          <div className="mt-4 flex flex-col items-center rounded-xl border border-dashed border-line bg-surface-2 px-6 py-10 text-center">
            <EmptyKeys className="h-16 w-auto opacity-80" />
            <p className="mt-5 text-sm font-medium text-ink">
              No practice tracks yet
            </p>
            <p className="mt-1 max-w-xs text-balance text-sm text-ink-faint">
              Build one from a tutorial link or a song name and it will be saved
              here on this device.
            </p>
          </div>
        )}
      </section>

      <footer className="mt-12 border-t border-line pt-6 text-center text-sm text-ink-faint">
        KeySync listens through your microphone. Nothing is uploaded; the audio
        never leaves your machine.
      </footer>

      <style>{`@keyframes slide { 0% { margin-left: -33%; } 100% { margin-left: 100%; } }`}</style>
    </main>
  );
}
