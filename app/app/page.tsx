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
import { runStreamingBuild, type BuildPhase } from "@/lib/build-client";
import { useAuth } from "@/components/AuthProvider";
import { UserMenu } from "@/components/Auth";
import { RequireAuth } from "@/components/AuthGate";
import { loadUserSongs, type SavedSong as CloudSong } from "@/lib/songs";
import { saveSong as saveToLocal } from "@/lib/saved-songs";
import {
  Onboarding,
  isOnboarded,
  getOnboardingAnswers,
  type OnboardingAnswers,
} from "@/components/Onboarding";

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

// Fallback labels when a progress event carries no detail of its own.
const PHASE_LABEL: Record<BuildPhase, string> = {
  warming: "Starting up…",
  downloading: "Downloading tutorial audio…",
  preparing: "Preparing audio…",
  transcribing: "Transcribing notes…",
  analyzing: "Analyzing key, chords and tempo…",
  done: "Done",
};

function readStreak(): number {
  try {
    const raw = localStorage.getItem("keysync-streak");
    if (!raw) return 0;
    return JSON.parse(raw).count ?? 0;
  } catch {
    return 0;
  }
}

function readMastery(): Record<string, number> {
  try {
    const raw = localStorage.getItem("keysync-mastery");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export default function AppHome() {
  return (
    <RequireAuth>
      <Home />
    </RequireAuth>
  );
}

function Home() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [cloudSongs, setCloudSongs] = useState<CloudSong[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingAnswers, setOnboardingAnswers] =
    useState<OnboardingAnswers | null>(null);
  const [streak, setStreak] = useState(0);
  const [mastery, setMastery] = useState<Record<string, number>>({});

  // First-visit onboarding + streak/mastery (all on-device).
  useEffect(() => {
    setStreak(readStreak());
    setMastery(readMastery());
    setOnboardingAnswers(getOnboardingAnswers());
    if (!isOnboarded()) {
      // Let the hero animate in first.
      const t = setTimeout(() => setShowOnboarding(true), 900);
      return () => clearTimeout(t);
    }
  }, []);

  // Load cloud songs when user logs in
  useEffect(() => {
    if (user) {
      setCloudLoading(true);
      loadUserSongs()
        .then(setCloudSongs)
        .catch(() => setCloudSongs([]))
        .finally(() => setCloudLoading(false));
    } else {
      setCloudSongs([]);
    }
  }, [user]);

  const [url, setUrl] = useState("");
  const [videoId, setVideoId] = useState<string | null>(null);
  const [urlError, setUrlError] = useState("");
  const [sections, setSections] = useState<Section[]>([]);
  const [pendingStart, setPendingStart] = useState<number | null>(null);
  const [building, setBuilding] = useState(false);
  // Kill-switch panel: live view of everything running on the account.
  const [buildError, setBuildError] = useState("");
  // Real end-to-end progress for the transcription build (0..100), the
  // current human-readable phase, and the live backend log lines.
  const [progress, setProgress] = useState(0);
  const [phaseLabel, setPhaseLabel] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<SavedSongMeta[]>([]);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  // Song-name mode (sheet music) state.
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

  // Auto-scroll the log panel to the newest line when it is open.
  useEffect(() => {
    if (logsOpen) logEndRef.current?.scrollIntoView({ block: "end" });
  }, [logs, logsOpen]);

  // Shared streaming-build callbacks: mirror backend lines to the console and
  // the on-screen log panel, and drive the progress bar.
  const streamCallbacks = () => ({
    onLog: (line: string) => {
      console.log(`[KeySync] ${line}`);
      setLogs((prev) => [...prev, line]);
    },
    onProgress: (pct: number, phase: BuildPhase | undefined, detail?: string) => {
      setProgress(pct);
      setPhaseLabel(detail || (phase ? PHASE_LABEL[phase] : ""));
    },
  });

  const build = async () => {
    if (building) return;
    if (!videoId && !audioFile) return;
    setBuilding(true);
    setBuildError("");
    setProgress(0);
    setPhaseLabel("Starting up…");
    setLogs([]);

    const cb = streamCallbacks();

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
        song = await runStreamingBuild<SongData>(
          "/api/upload/stream",
          { method: "POST", body: form },
          cb
        );
      } else {
        song = await runStreamingBuild<SongData>(
          "/api/build/stream",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ youtubeUrl: url.trim(), sections }),
          },
          cb
        );
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
    }
  };



  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-16">
      {/* Auth header */}
      <div className="mb-6 flex min-h-[44px] items-center justify-between gap-3">
        <div>
          {streak > 0 && (
            <span className="inline-flex h-11 items-center gap-2 rounded-full bg-accent/10 px-4 text-sm font-semibold text-accent ring-1 ring-accent/40">
              {streak}-day streak
            </span>
          )}
        </div>
        <UserMenu email={user?.email || ""} onSignOut={signOut} />
      </div>
      {showOnboarding && (
        <Onboarding
          onDone={(a) => {
            setShowOnboarding(false);
            setOnboardingAnswers(a);
          }}
        />
      )}
      <header className="mb-10 flex flex-col items-center text-center sm:mb-14">
        <LogoMark size={60} className="animate-pop mb-5" />
        <h1 className="animate-fade-up font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          Key<span className="text-accent">Sync</span>
        </h1>
        <p
          className="animate-fade-up mt-4 max-w-xl text-balance leading-relaxed text-ink-dim"
          style={{ animationDelay: "80ms" }}
        >
          Paste a YouTube piano tutorial or upload audio. KeySync transcribes
          every note into falling notes, then listens through your microphone
          as you play them on your real piano.
        </p>
        {onboardingAnswers?.firstSong && (
          <p className="animate-fade-up mt-3 rounded-full bg-surface-2 px-4 py-2 text-sm text-ink-dim ring-1 ring-line">
            Your first song:{" "}
            <span className="font-medium text-accent">
              {onboardingAnswers.firstSong}
            </span>{" "}
            — paste a tutorial link below to start.
          </p>
        )}
      </header>

      {/* Step 1: link */}
      <section className="card p-4 sm:p-6">
        <h2 className="label-eyebrow text-xs">
          1 · Your song
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

      {/* Step 2: mark sections */}
      {(videoId || audioFile) && (
        <section className="animate-fade-up mt-6 card p-4 sm:p-6">
          <h2 className="label-eyebrow text-xs">
            2 · Choose sections
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
      {(videoId || audioFile) && (
        <section className="animate-fade-up mt-6 card p-4 sm:p-6">
          <h2 className="label-eyebrow text-xs">
            3 · Build
          </h2>
          <button
            onClick={build}
            disabled={building}
            className="mt-4 w-full rounded-xl bg-accent py-4 text-lg font-bold text-accent-ink transition hover:brightness-110 active:scale-[0.99] disabled:cursor-wait disabled:opacity-70"
          >
            {building ? phaseLabel || "Building…" : "Build practice track"}
          </button>
          {building && (
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs text-ink-dim">
                <span>{phaseLabel}</span>
                <span className="font-mono tabular-nums text-ink-faint">
                  {Math.round(progress)}%
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
                <div
                  className="relative h-full overflow-hidden rounded-full bg-accent transition-[width] duration-500 ease-out"
                  style={{ width: `${Math.max(2, Math.min(100, progress))}%` }}
                >
                  {progress < 100 && <span className="progress-sheen" />}
                </div>
              </div>
            </div>
          )}
          {(building || logs.length > 0) && (
            <div className="mt-4 overflow-hidden rounded-xl border border-line bg-surface-2">
              <button
                onClick={() => setLogsOpen((o) => !o)}
                className="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs font-medium text-ink-dim transition hover:text-ink"
              >
                <span className="label-eyebrow text-[0.65rem]">
                  Processing log{logs.length > 0 ? ` · ${logs.length}` : ""}
                </span>
                <svg
                  viewBox="0 0 16 16"
                  className={`h-3.5 w-3.5 shrink-0 transition-transform ${logsOpen ? "rotate-180" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {logsOpen && (
                <div className="max-h-48 overflow-y-auto border-t border-line px-4 py-3 font-mono text-xs leading-relaxed text-ink-dim">
                  {logs.length === 0 ? (
                    <p className="text-ink-faint">Waiting for the first line…</p>
                  ) : (
                    logs.map((l, i) => (
                      <div key={i} className="whitespace-pre-wrap break-words">
                        <span className="text-ink-faint">›</span> {l}
                      </div>
                    ))
                  )}
                  <div ref={logEndRef} />
                </div>
              )}
            </div>
          )}
          {buildError && (
            <p className="mt-3 text-sm text-danger">{buildError}</p>
          )}
          {!building && !buildError && (
            <p className="mt-3 text-sm text-ink-faint">
              Transcription runs on our note engine and takes a minute or two
              depending on how much you marked. You can watch each step in the
              processing log.
            </p>
          )}
        </section>
      )}

      {/* Saved songs library */}
      <section className="animate-fade-up mt-6 card p-4 sm:p-6">
        <h2 className="label-eyebrow">Your practice library</h2>
        {saved.length > 0 ? (
          <>
            <ul className="mt-4 space-y-2">
              {saved.map((s, i) => {
                const pct = mastery[s.id];
                return (
                  <li
                    key={s.id}
                    className="hover-lift animate-fade-up flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3 transition-colors hover:border-line-strong"
                    style={{ animationDelay: `${Math.min(i, 8) * 50}ms` }}
                  >
                    <button
                      onClick={() => router.push(`/practice/${s.id}`)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block truncate text-sm font-medium text-ink">
                        {s.title}
                      </span>
                      <span className="mt-1 block font-mono text-xs tabular-nums text-ink-faint">
                        {s.noteCount} notes · {fmt(s.duration)} ·{" "}
                        {new Date(s.createdAt).toLocaleDateString()}
                      </span>
                      {pct != null && (
                        <span className="mt-2 block">
                          <span className="mb-1 flex items-center justify-between">
                            <span className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                              Mastery
                            </span>
                            <span className="font-mono text-[11px] tabular-nums text-accent">
                              {pct}%
                            </span>
                          </span>
                          <span className="block h-1.5 w-full overflow-hidden rounded-full bg-line">
                            <span
                              className="block h-full rounded-full bg-accent transition-[width]"
                              style={{ width: `${Math.min(100, pct)}%` }}
                            />
                          </span>
                        </span>
                      )}
                    </button>
                    <button
                      onClick={() => removeSaved(s.id)}
                      className="btn-ghost h-11 shrink-0"
                    >
                      Delete
                    </button>
                  </li>
                );
              })}
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
              Paste a tutorial link or upload an audio file above and it will be
              saved here on this device.
            </p>
          </div>
        )}
      </section>

      {/* Cloud songs (Supabase) */}
      {user && (
        <section className="animate-fade-up mt-6 card p-4 sm:p-6">
          <h2 className="label-eyebrow">Your cloud songs</h2>
          {cloudLoading ? (
            <p className="mt-4 text-sm text-ink-dim">Loading…</p>
          ) : cloudSongs.length > 0 ? (
            <ul className="mt-4 space-y-2">
              {cloudSongs.map((s) => (
                <li
                  key={s.id}
                  className="hover-lift flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3 transition-colors hover:border-line-strong"
                >
                  <button
                    onClick={async () => {
                      // Save cloud song to local IndexedDB, then open in practice page
                      const localId = await saveToLocal(s.song_data, "");
                      router.push(`/practice/${localId}`);
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-sm text-ink">
                      {s.title}
                    </span>
                    <span className="text-xs text-ink-faint">
                      {new Date(s.created_at).toLocaleDateString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-ink-dim">
              No cloud songs yet. Save one from the practice page.
            </p>
          )}
        </section>
      )}

      <footer className="mt-12 border-t border-line pt-6 text-center text-sm text-ink-faint">
        The audio you provide is uploaded for transcription. When you practice,
        KeySync listens through your microphone and that audio never leaves
        your machine.
      </footer>
    </main>
  );
}
