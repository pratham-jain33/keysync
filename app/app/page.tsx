"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Section } from "@/lib/types";
import {
  deleteSavedSong,
  listSavedSongs,
  saveSong as saveToLocal,
  type SavedSongMeta,
} from "@/lib/saved-songs";
import { LogoMark, EmptyKeys } from "@/components/Brand";
import { useAuth } from "@/components/AuthProvider";
import { UserMenu } from "@/components/Auth";
import { RequireAuth } from "@/components/AuthGate";
import {
  deleteSong,
  loadUserSongs,
  type SavedSong as CloudSong,
} from "@/lib/songs";
import {
  createAudioJob,
  createYoutubeJob,
  getJob,
  listJobs,
  type BuildJob,
} from "@/lib/jobs";
import {
  Onboarding,
  isOnboarded,
  getOnboardingAnswers,
  type OnboardingAnswers,
} from "@/components/Onboarding";
import { Stars } from "@/components/Stars";

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

const JOB_STATUS_STYLE: Record<BuildJob["status"], string> = {
  queued: "bg-line text-ink-dim ring-line-strong",
  processing: "bg-accent/10 text-accent ring-accent/40",
  done: "bg-accent/15 text-accent ring-accent/50",
  failed: "bg-danger/10 text-danger ring-danger/40",
};

const JOB_STATUS_LABEL: Record<BuildJob["status"], string> = {
  queued: "Queued",
  processing: "Building",
  done: "Ready",
  failed: "Failed",
};

function StatusPill({ status }: { status: BuildJob["status"] }) {
  return (
    <span
      className={`inline-flex h-8 shrink-0 items-center rounded-full px-3 text-xs font-semibold ring-1 ${JOB_STATUS_STYLE[status]}`}
    >
      {JOB_STATUS_LABEL[status]}
    </span>
  );
}

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
  // Background builds: the song input starts a server-side job and returns
  // immediately, so the phone can sleep or the tab can close mid-build.
  const [jobs, setJobs] = useState<BuildJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobStarting, setJobStarting] = useState(false);
  const [jobError, setJobError] = useState("");
  const [openingJobId, setOpeningJobId] = useState<string | null>(null);
  // Cloud song deletion confirm.
  const [cloudDeleteId, setCloudDeleteId] = useState<string | null>(null);
  const [cloudDeleting, setCloudDeleting] = useState(false);
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
      setJobError("");
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
    setJobError("");
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

  const refreshJobs = useCallback(async () => {
    if (!user) return;
    try {
      setJobs(await listJobs());
    } catch {
      /* keep the last known list */
    }
  }, [user]);

  // Load builds on sign-in…
  useEffect(() => {
    if (!user) {
      setJobs([]);
      return;
    }
    setJobsLoading(true);
    refreshJobs().finally(() => setJobsLoading(false));
  }, [user, refreshJobs]);

  // …and poll every 5s while any build is still running. Polling stops on
  // its own once everything is done or failed.
  useEffect(() => {
    if (!user) return;
    const active = jobs.some(
      (j) => j.status === "queued" || j.status === "processing"
    );
    if (!active) return;
    const t = setInterval(refreshJobs, 5000);
    return () => clearInterval(t);
  }, [user, jobs, refreshJobs]);

  const startJob = async () => {
    if (jobStarting) return;
    if (!videoId && !audioFile) return;
    setJobStarting(true);
    setJobError("");
    try {
      if (audioFile) {
        await createAudioJob(
          audioFile,
          audioFile.name.replace(/\.[^.]+$/, ""),
          sections
        );
      } else if (videoId) {
        await createYoutubeJob(url.trim(), "YouTube tutorial", sections);
      }
      await refreshJobs();
      // Reset the form so starting another build is a fresh action.
      setUrl("");
      setVideoId(null);
      setSections([]);
      setPendingStart(null);
      clearAudio();
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e) {
      setJobError(
        e instanceof Error ? e.message : "Could not start the build."
      );
    } finally {
      setJobStarting(false);
    }
  };

  const openJob = async (job: BuildJob) => {
    if (openingJobId) return;
    setOpeningJobId(job.id);
    try {
      const full = await getJob(job.id);
      if (!full.song_data) throw new Error("This build has no song yet.");
      // Persist on this device so the practice page can open it.
      const localId = await saveToLocal(full.song_data, full.title);
      router.push(`/practice/${localId}`);
    } catch (e) {
      setJobError(
        e instanceof Error ? e.message : "Could not open this build."
      );
    } finally {
      setOpeningJobId(null);
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
            onClick={startJob}
            disabled={jobStarting}
            className="mt-4 w-full rounded-xl bg-accent py-4 text-lg font-bold text-accent-ink transition hover:brightness-110 active:scale-[0.99] disabled:cursor-wait disabled:opacity-70"
          >
            {jobStarting ? "Starting build…" : "Start build"}
          </button>
          {jobError && (
            <p className="mt-3 text-sm text-danger">{jobError}</p>
          )}
          {!jobStarting && !jobError && (
            <p className="mt-3 text-sm text-ink-faint">
              Builds run in the background — no need to keep this tab open.
              Come back anytime; finished builds appear below, ready to
              practice.
            </p>
          )}
        </section>
      )}

      {/* Background builds */}
      <section className="animate-fade-up mt-6 card p-4 sm:p-6">
        <h2 className="label-eyebrow">Your builds</h2>
        {jobsLoading ? (
          <p className="mt-4 text-sm text-ink-dim">Loading…</p>
        ) : jobs.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="rounded-xl border border-line bg-surface-2 px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">
                      {job.title || "Untitled build"}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-faint">
                      {job.kind === "youtube" ? "YouTube link" : "Audio upload"}{" "}
                      · {new Date(job.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <StatusPill status={job.status} />
                </div>
                {(job.status === "queued" || job.status === "processing") && (
                  <div className="mt-3">
                    <div className="flex items-center justify-between gap-2 text-xs text-ink-dim">
                      <span className="truncate">
                        {job.current_step ||
                          (job.status === "queued"
                            ? "Waiting to start…"
                            : "Working…")}
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-ink-faint">
                        {Math.round(job.progress)}%
                      </span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
                      <div
                        className="relative h-full overflow-hidden rounded-full bg-accent transition-[width] duration-500 ease-out"
                        style={{
                          width: `${Math.max(2, Math.min(100, job.progress))}%`,
                        }}
                      >
                        {job.progress < 100 && (
                          <span className="progress-sheen" />
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {job.status === "failed" && (
                  <p className="mt-2 text-sm text-danger">
                    {job.error || "This build failed."}
                  </p>
                )}
                {job.status === "done" && (
                  <button
                    onClick={() => openJob(job)}
                    disabled={openingJobId === job.id}
                    className="mt-3 h-11 w-full rounded-xl bg-accent font-semibold text-accent-ink transition hover:brightness-110 active:scale-[0.99] disabled:cursor-wait disabled:opacity-70"
                  >
                    {openingJobId === job.id ? "Opening…" : "Open practice"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-ink-dim">
            No builds yet. Start one above — it keeps running even if you close
            this tab.
          </p>
        )}
      </section>

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
                            <span className="flex items-center gap-2">
                              <span className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                                Mastery
                              </span>
                              <Stars accuracy={pct} size="sm" />
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
                  <button
                    onClick={() => setCloudDeleteId(s.id)}
                    aria-label={`Delete ${s.title} from cloud`}
                    className="btn-ghost h-11 shrink-0"
                  >
                    Delete
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

      {/* Cloud song delete confirmation */}
      {cloudDeleteId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => !cloudDeleting && setCloudDeleteId(null)}
        >
          <div
            className="card w-full max-w-sm p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-xl font-semibold text-ink">
              Delete cloud song?
            </h3>
            <p className="mt-2 text-sm text-ink-dim">
              &ldquo;
              {cloudSongs.find((s) => s.id === cloudDeleteId)?.title ??
                "This song"}
              &rdquo; will be removed from your cloud library. Anything saved
              on this device stays.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setCloudDeleteId(null)}
                disabled={cloudDeleting}
                className="btn-outline h-11 flex-1"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setCloudDeleting(true);
                  try {
                    await deleteSong(cloudDeleteId);
                    setCloudSongs((prev) =>
                      prev.filter((s) => s.id !== cloudDeleteId)
                    );
                  } catch {
                    /* the row stays visible on failure */
                  } finally {
                    setCloudDeleting(false);
                    setCloudDeleteId(null);
                  }
                }}
                disabled={cloudDeleting}
                className="h-11 flex-1 rounded-xl bg-danger font-semibold text-white transition hover:brightness-110 active:scale-[0.98] disabled:opacity-70"
              >
                {cloudDeleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
