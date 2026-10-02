"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Brand, LogoMark } from "@/components/Brand";
import { buildSteps, createPracticeEngine } from "@/lib/practice";
import type { PracticeStep } from "@/lib/practice";
import { createPitchDetector } from "@/lib/pitch";
import type { FramePitchDetector } from "@/lib/pitch";
import { midiToName } from "@/lib/theory";
import { getSavedSong, isLocalId } from "@/lib/saved-songs";
import { playDemo, prefetchPianoBuffers, isPianoLoaded } from "@/lib/synth";
import type { DemoHandle } from "@/lib/synth";
import { useAuth } from "@/components/AuthProvider";
import { saveSong } from "@/lib/songs";
import type {
  NoteEvent,
  SongData,
} from "@/lib/types";

const GREEN = "#e6b45c";
const BLUE = "#79a9d6";
const RED = "#ff4d5e";


interface KeyGeom {
  midi: number;
  isBlack: boolean;
  x: number;
  w: number;
}

interface MicNodes {
  ctx: AudioContext;
  analyser: AnalyserNode;
  detector: FramePitchDetector;
  stream: MediaStream;
  buf: Float32Array<ArrayBuffer>;
}

export default function PracticePage() {
  const params = useParams<{ songId: string }>();
  const { user } = useAuth();
  const [song, setSong] = useState<SongData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [micState, setMicState] = useState<"off" | "starting" | "on" | "denied">("off");
  const [demoPlaying, setDemoPlaying] = useState(false);
  const [pianoLoading, setPianoLoading] = useState(false);
  const [progress, setProgress] = useState({ played: 0, total: 0 });
  const [complete, setComplete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  const handleSaveToCloud = async () => {
    if (!song || !user) return;
    setSaving(true);
    setSaveMessage("");
    try {
      await saveSong(song.title || "Untitled", song);
      setSaveMessage("Saved to cloud!");
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef(createPracticeEngine([]));
  const songTimeRef = useRef(0);
  const wrongFlashRef = useRef<{ midi: number; until: number } | null>(null);
  const micRef = useRef<MicNodes | null>(null);
  const pitchHistRef = useRef<number[]>([]);
  const lastFedRef = useRef(-1);
  const armedRef = useRef(true);
  const demoRef = useRef<DemoHandle | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const demoLoadingRef = useRef(false);
  const micStateRef = useRef(micState);
  micStateRef.current = micState;
  const demoPlayingRef = useRef(demoPlaying);
  demoPlayingRef.current = demoPlaying;
  // Mirrors read by the long-lived animation loop so it never closes over
  // a stale value from the render that created it.
  const completeRef = useRef(complete);
  completeRef.current = complete;
  const songRef = useRef(song);
  songRef.current = song;
  // Bumped on every teardown (mode/difficulty switch, restart, new song).
  // An async demo load started under an old generation is discarded.
  const genRef = useRef(0);

  // ---- derived music data ----
  // A MIDI upload carries its real left hand; use it as-is. Otherwise
  // (audio transcription) synthesize one from the chords at the chosen
  // difficulty.
  const expectedNotes: NoteEvent[] = useMemo(() => {
    if (!song) return [];
    // All notes, no hand distinction.
    return [...song.melody].sort((a, b) => a.start - b.start);
  }, [song]);
  const steps: PracticeStep[] = useMemo(
    () => buildSteps(expectedNotes),
    [expectedNotes]
  );

  // Keyboard range adapts to the song.
  const geom = useMemo(() => {
    if (expectedNotes.length === 0) return { keys: [] as KeyGeom[], whiteW: 0 };
    const midis = expectedNotes.map((n) => Math.round(n.midi));
    let lo = Math.floor((Math.min(...midis) - 3) / 12) * 12;
    let hi = Math.ceil((Math.max(...midis) + 4) / 12) * 12 - 1;
    if (hi - lo < 23) {
      const mid = Math.round((lo + hi) / 2);
      lo = Math.floor((mid - 12) / 12) * 12;
      hi = lo + 23;
    }
    const isBlack = (m: number) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
    const whites = [];
    for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
    const keys: KeyGeom[] = [];
    let wi = 0;
    const whiteIndexOf = new Map<number, number>();
    for (const m of whites) whiteIndexOf.set(m, wi++);
    for (let m = lo; m <= hi; m++) {
      if (isBlack(m)) {
        const after = whiteIndexOf.get(m + 1) ?? wi;
        keys.push({ midi: m, isBlack: true, x: after, w: 0.62 });
      } else {
        keys.push({ midi: m, isBlack: false, x: whiteIndexOf.get(m)!, w: 1 });
      }
    }
    return { keys, whiteW: 1, whiteCount: whites.length, lo, hi };
  }, [expectedNotes]);

  // ---- load song ----
  // Saved songs (route id starts with "local-") come from this device's
  // IndexedDB library; everything else comes from the server.
  useEffect(() => {
    const id = params.songId;
    if (isLocalId(id)) {
      getSavedSong(id)
        .then((song) => {
          if (!song)
            throw new Error(
              "Saved song not found on this device. Build it again from the home page."
            );
          setSong(song);
        })
        .catch((e) =>
          setLoadError(e instanceof Error ? e.message : "Load failed")
        );
      return;
    }
    fetch(`/api/song/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error("Song not found. Build it again from the home page.");
        const data = await r.json();
        setSong(data.song);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Load failed"));
  }, [params.songId]);

  // Warm the piano samples as soon as the page opens so the first "Play demo"
  // tap decodes instantly instead of waiting on a ~2MB download. Fetch only
  // (no AudioContext) — decoding happens lazily on first play, after a gesture.
  useEffect(() => {
    prefetchPianoBuffers();
  }, []);

  // ---- rebuild engine when the step list changes ----
  // A new step list means the song loaded or the mode/difficulty changed.
  // Tear everything down and rebuild from scratch so the view never shows a
  // stale demo or stale progress against the new note set.
  useEffect(() => {
    genRef.current++;
    stopDemo();
    engineRef.current = createPracticeEngine(steps);
    songTimeRef.current = 0;
    wrongFlashRef.current = null;
    completeRef.current = false;
    setComplete(false);
    setProgress({ played: 0, total: steps.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps]);

  const restart = () => {
    genRef.current++;
    stopDemo();
    engineRef.current.reset();
    songTimeRef.current = 0;
    wrongFlashRef.current = null;
    completeRef.current = false;
    setComplete(false);
    setProgress({ played: 0, total: engineRef.current.steps.length });
  };

  const stopMic = () => {
    micRef.current?.stream.getTracks().forEach((t) => t.stop());
    micRef.current?.ctx.close().catch(() => undefined);
    micRef.current = null;
    pitchHistRef.current = [];
    setMicState("off");
  };

  // ---- microphone ----
  const enableMic = async () => {
    if (micStateRef.current === "on" || micStateRef.current === "starting") return;
    setMicState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      micRef.current = {
        ctx,
        analyser,
        detector: createPitchDetector(ctx.sampleRate, 2048),
        stream,
        buf: new Float32Array(analyser.fftSize),
      };
      pitchHistRef.current = [];
      lastFedRef.current = -1;
      armedRef.current = true;
      setMicState("on");
    } catch {
      setMicState("denied");
    }
  };

  useEffect(() => {
    if (micState !== "on") return;
    const tick = () => {
      const mic = micRef.current;
      if (!mic) return;
      mic.analyser.getFloatTimeDomainData(mic.buf);
      const res = mic.detector.detect(mic.buf);
      const hist = pitchHistRef.current;
      hist.push(res ? Math.round(res.midi) : -1);
      if (hist.length > 3) hist.shift();

      if (res == null) {
        armedRef.current = true; // silence re-arms repeated notes
        return;
      }
      const stable =
        hist.length === 3 && hist[0] >= 0 && hist[0] === hist[1] && hist[1] === hist[2];
      if (!stable) return;
      const midi = hist[2];
      if (midi === lastFedRef.current && !armedRef.current) return;
      lastFedRef.current = midi;
      armedRef.current = false;

      const engine = engineRef.current;
      const r = engine.play(midi);
      if (r.status === "correct") {
        wrongFlashRef.current = null;
        if (r.done) {
          completeRef.current = true;
          setComplete(true);
        }
      } else if (r.status === "wrong") {
        wrongFlashRef.current = { midi: r.played, until: performance.now() + 600 };
      }
    };
    const id = setInterval(tick, 50);
    return () => clearInterval(id);
  }, [micState]);

  useEffect(
    () => () => {
      micRef.current?.stream.getTracks().forEach((t) => t.stop());
      micRef.current?.ctx.close().catch(() => undefined);
      // Stop demo audio and release its context so playback never
      // continues after the user navigates away from the practice page.
      demoRef.current?.stop();
      demoRef.current = null;
      audioCtxRef.current?.close().catch(() => undefined);
      audioCtxRef.current = null;
    },
    []
  );

  // ---- demo playback ----
  const stopDemo = () => {
    demoRef.current?.stop();
    demoRef.current = null;
    setDemoPlaying(false);
  };

  const toggleDemo = async () => {
    if (demoPlayingRef.current) {
      stopDemo();
      return;
    }
    // Samples load on first play; ignore taps while they are loading.
    if (demoLoadingRef.current) return;
    if (expectedNotes.length === 0) return;
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    const ctx = audioCtxRef.current;
    // Snapshot the notes and generation now; both can change while the
    // samples load (the user may switch mode or difficulty mid-load).
    const notes = expectedNotes;
    const gen = genRef.current;
    await ctx.resume();
    demoLoadingRef.current = true;
    // Samples are usually warm from the mount-time prefetch; only show the
    // loading state if decoding will actually make the user wait.
    const needsLoad = !isPianoLoaded();
    if (needsLoad) setPianoLoading(true);
    try {
      const handle = await playDemo(ctx, notes);
      if (gen !== genRef.current) {
        // Mode/difficulty changed (or restart ran) during the load — this
        // demo is stale. Discard it so we never play old notes against the
        // new view.
        handle.stop();
        return;
      }
      demoRef.current = handle;
      songTimeRef.current = 0;
      setDemoPlaying(true);
    } finally {
      demoLoadingRef.current = false;
      if (needsLoad) setPianoLoading(false);
    }
  };

  // ---- main render / timing loop ----
  // Mounted once and driven entirely through refs. Keeping a single
  // long-lived rAF loop (instead of tearing it down on every mode switch)
  // avoids a frame gap on each change and removes stale-closure bugs: the
  // loop reads live values via refs and draws through drawRef.
  const drawRef = useRef<(now: number) => void>(() => undefined);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      const engine = engineRef.current;
      const currentSong = songRef.current;
      if (demoPlayingRef.current && demoRef.current) {
        const t = demoRef.current.elapsed();
        songTimeRef.current = t;
        if (t >= demoRef.current.duration) stopDemo();
      } else if (micStateRef.current === "on" && currentSong && !completeRef.current) {
        const next = engine.current();
        if (next && songTimeRef.current >= next.time) {
          songTimeRef.current = next.time; // freeze: waiting for the note
        } else {
          songTimeRef.current = Math.min(songTimeRef.current + dt, currentSong.duration);
        }
      }

      drawRef.current(now);

      const played = engine.steps.filter((s) => s.time < songTimeRef.current - 1e-6).length;
      setProgress((p) =>
        p.played === played && p.total === engine.steps.length
          ? p
          : { played, total: engine.steps.length }
      );
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- canvas drawing ----
  const draw = (now: number) => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || geom.keys.length === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = wrap.clientWidth;
    // Fit the stage to the screen: phones get a shorter stage so the
    // keyboard stays visible without scrolling, desktops keep the full view.
    const H = Math.max(360, Math.min(500, Math.round(window.innerHeight * 0.55)));
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const whiteW = W / (geom.whiteCount ?? 1);
    const blackW = whiteW * 0.62;
    const keyH = 140;
    const hitY = H - keyH;
    const pxPerSec = 150;
    const songTime = songTimeRef.current;
    const engine = engineRef.current;
    const next = !demoPlayingRef.current ? engine.current() : null;

    const keyX = (k: KeyGeom) =>
      k.isBlack ? k.x * whiteW - blackW / 2 : k.x * whiteW;
    const keyW = (k: KeyGeom) => (k.isBlack ? blackW : whiteW);
    const byMidi = new Map(geom.keys.map((k) => [k.midi, k]));

    // Falling notes.
    for (const n of expectedNotes) {
      const k = byMidi.get(Math.round(n.midi));
      if (!k) continue;
      const y = hitY - (n.start - songTime) * pxPerSec;
      const h = Math.max(5, (n.end - n.start) * pxPerSec);
      if (y + h < 0 || y > hitY + 4) continue;
      const played = n.start < songTime - 1e-6;
      const color = n.hand === "left" ? BLUE : GREEN;
      ctx.globalAlpha = played ? 0.18 : 0.92;
      ctx.fillStyle = color;
      const nx = keyX(k) + keyW(k) * 0.14;
      const nw = keyW(k) * 0.72;
      const r = Math.min(4, nw / 2);
      ctx.beginPath();
      ctx.roundRect(nx, y - h, nw, h, r);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Hit line — a thin brass rail where the notes land.
    ctx.fillStyle = "rgba(230,180,92,0.55)";
    ctx.fillRect(0, hitY - 1, W, 2);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, hitY + 1, W, 6);

    // Keyboard — warm ivory white keys.
    for (const k of geom.keys) {
      if (k.isBlack) continue;
      ctx.fillStyle = "#ece7db";
      ctx.strokeStyle = "#0a0a0c";
      ctx.lineWidth = 1;
      ctx.fillRect(keyX(k), hitY, keyW(k), keyH);
      ctx.strokeRect(keyX(k) + 0.5, hitY, keyW(k) - 1, keyH);
    }
    // C labels.
    ctx.fillStyle = "#8a8580";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "center";
    for (const k of geom.keys) {
      if (!k.isBlack && k.midi % 12 === 0) {
        ctx.fillText(midiToName(k.midi), keyX(k) + keyW(k) / 2, hitY + keyH - 10);
      }
    }
    for (const k of geom.keys) {
      if (!k.isBlack) continue;
      ctx.fillStyle = "#0c0c0f";
      ctx.fillRect(keyX(k), hitY, keyW(k), keyH * 0.62);
    }

    // Waiting glow on the expected key(s). Chord steps only need the bass.
    if (next && micStateRef.current === "on" && !complete) {
      const pulse = 0.55 + 0.35 * Math.sin(now / 220);
      const glowMidis = next.isChord ? [next.bass] : next.midis;
      for (const m of glowMidis) {
        const k = byMidi.get(m);
        if (!k) continue;
        ctx.globalAlpha = pulse;
        ctx.fillStyle = GREEN;
        if (k.isBlack) ctx.fillRect(keyX(k), hitY, keyW(k), keyH * 0.62);
        else ctx.fillRect(keyX(k), hitY, keyW(k), keyH);
      }
      ctx.globalAlpha = 1;
    }

    // Wrong-note flash.
    const flash = wrongFlashRef.current;
    if (flash && now < flash.until) {
      const k = byMidi.get(flash.midi);
      if (k) {
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = RED;
        if (k.isBlack) ctx.fillRect(keyX(k), hitY, keyW(k), keyH * 0.62);
        else ctx.fillRect(keyX(k), hitY, keyW(k), keyH);
        ctx.globalAlpha = 1;
      }
    }
  };
  // Keep the loop pointed at the latest draw so it always renders the
  // current mode's notes, geometry and completion state.
  drawRef.current = draw;

  const nextStep: PracticeStep | null =
    !demoPlaying && !complete ? engineRef.current.current() : null;

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-[70vh] max-w-4xl flex-col items-center justify-center px-6 py-16 text-center">
        <LogoMark size={48} className="mb-6 opacity-80" />
        <p className="text-danger">{loadError}</p>
        <Link
          href="/"
          className="btn-outline mt-6 h-11 px-5"
        >
          Back to home
        </Link>
      </main>
    );
  }

  if (!song) {
    return (
      <main className="mx-auto flex min-h-[70vh] max-w-4xl flex-col items-center justify-center px-6 py-16 text-center">
        <span className="h-9 w-9 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
        <p className="mt-5 text-sm text-ink-dim">Loading your practice track…</p>
      </main>
    );
  }

  const pct =
    progress.total > 0 ? Math.round((progress.played / progress.total) * 100) : 0;

  return (
    <main className="animate-fade-up mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      {/* header */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <Brand size={22} wordClassName="text-sm" />
          <h1 className="mt-2 truncate font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            {song.title}
          </h1>
          <p className="mt-1.5 font-mono text-xs uppercase tracking-wider text-ink-faint">
            {song.key.name} · {song.bpm} BPM · {progress.total} notes
          </p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <button
            onClick={toggleDemo}
            disabled={pianoLoading}
            className={`flex h-11 flex-1 items-center justify-center gap-2 rounded-xl px-5 font-semibold transition active:scale-[0.98] disabled:cursor-wait disabled:opacity-80 sm:flex-none ${
              demoPlaying
                ? "bg-line-strong text-ink hover:bg-line"
                : "bg-accent text-accent-ink hover:brightness-110"
            }`}
          >
            {pianoLoading && (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent-ink/30 border-t-accent-ink" />
            )}
            {pianoLoading ? "Loading piano…" : demoPlaying ? "Stop demo" : "Play demo"}
          </button>
          <button
            onClick={restart}
            className="h-11 flex-1 rounded-xl border border-line-strong px-5 font-medium text-ink-dim transition hover:border-accent hover:text-ink active:scale-[0.98] sm:flex-none"
          >
            Restart
          </button>
          {user && song && (
            <button
              onClick={handleSaveToCloud}
              disabled={saving}
              className="h-11 flex-1 rounded-xl border border-line-strong px-5 font-medium text-ink-dim transition hover:border-accent hover:text-ink active:scale-[0.98] sm:flex-none disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save to cloud"}
            </button>
          )}
        </div>
        {saveMessage && (
          <p className={`mt-2 text-sm ${saveMessage.includes("Saved") ? "text-accent" : "text-danger"}`}>
            {saveMessage}
          </p>
        )}
      </header>

      {/* controls */}
      <div className="mt-6 flex flex-wrap items-center gap-4 card p-4 sm:gap-6">
        <div className="w-full sm:ml-auto sm:w-auto">
          <p className="mb-2 label-eyebrow">
            Microphone
          </p>
          {micState === "on" ? (
            <button
              onClick={stopMic}
              title="Stop listening"
              className="flex h-11 items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 px-4 transition hover:bg-accent/20"
            >
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent" />
              <span className="text-sm font-medium text-accent">
                Listening — tap to stop
              </span>
            </button>
          ) : (
            <button
              onClick={enableMic}
              disabled={micState === "starting"}
              className="h-11 w-full rounded-xl bg-accent px-5 text-sm font-semibold text-accent-ink transition hover:brightness-110 active:scale-[0.98] disabled:opacity-60 sm:w-auto"
            >
              {micState === "starting" ? "Starting…" : "Enable microphone"}
            </button>
          )}
          {micState === "denied" && (
            <p className="mt-1 text-xs text-danger">
              Mic blocked. Allow access in the browser bar.
            </p>
          )}
        </div>
      </div>

      {/* progress */}
      <div className="mt-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-dim">
            {progress.played} / {progress.total} notes
          </span>
          <span className="font-semibold text-accent">{pct}%</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
          <div
            className="relative h-full overflow-hidden rounded-full bg-accent transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          >
            {pct > 0 && pct < 100 && !complete && (
              <span className="progress-sheen" />
            )}
          </div>
        </div>
      </div>

      {/* hint */}
      <div className="mt-4 h-8 text-center">
        {complete ? (
          <p
            key="complete"
            className="animate-pop font-display text-xl font-semibold text-accent"
          >
            Song complete. Nicely played.
          </p>
        ) : demoPlaying ? (
          <p key="demo" className="animate-fade text-ink-dim">
            Listening to the demo — right-hand melody in amber, left hand in blue.
          </p>
        ) : micState !== "on" ? (
          <p key="mic-off" className="animate-fade text-ink-dim">
            Enable the microphone, then play the glowing key on your piano.
          </p>
        ) : nextStep ? (
          <p key="next" className="animate-fade text-ink">
            Play{" "}
            <span className="font-bold text-accent">
              {nextStep.isChord
                ? midiToName(nextStep.bass)
                : nextStep.midis.map(midiToName).join(" + ")}
            </span>
            {nextStep.hand === "left" && (
              <span className="text-ink-dim">
                {nextStep.isChord
                  ? " (left hand chord — bass note passes)"
                  : " (left hand)"}
              </span>
            )}
          </p>
        ) : null}
      </div>

      {/* keyboard */}
      <div
        ref={wrapRef}
        className="mt-2 overflow-hidden rounded-2xl border border-line bg-surface-2"
      >
        <canvas ref={canvasRef} className="block w-full" />
      </div>

      <div className="mt-4 flex items-center justify-center gap-6 text-sm text-ink-faint">
        <span className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-sm bg-accent" /> Right hand
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-sm bg-cool" /> Left hand
        </span>
      </div>
    </main>
  );
}
