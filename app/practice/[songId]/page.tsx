"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { generateLeftHand } from "@/lib/accompaniment";
import { buildSteps, createPracticeEngine } from "@/lib/practice";
import type { PracticeStep } from "@/lib/practice";
import { createPitchDetector } from "@/lib/pitch";
import type { FramePitchDetector } from "@/lib/pitch";
import { midiToName } from "@/lib/theory";
import { getSavedSong, isLocalId } from "@/lib/saved-songs";
import { playDemo } from "@/lib/synth";
import type { DemoHandle } from "@/lib/synth";
import type {
  Difficulty,
  HandMode,
  NoteEvent,
  SongData,
} from "@/lib/types";

const GREEN = "#2bff88";
const BLUE = "#5aa9ff";
const RED = "#ff4d5e";

const DIFFICULTIES: { id: Difficulty; label: string; hint: string }[] = [
  { id: "easy", label: "Easy", hint: "Block chords" },
  { id: "medium", label: "Medium", hint: "Oom-pah bass" },
  { id: "hard", label: "Hard", hint: "Alberti bass" },
];
const MODES: { id: HandMode; label: string }[] = [
  { id: "right", label: "Right hand" },
  { id: "left", label: "Left hand" },
  { id: "both", label: "Both hands" },
];

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
  const [song, setSong] = useState<SongData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [handMode, setHandMode] = useState<HandMode>("both");
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [micState, setMicState] = useState<"off" | "starting" | "on" | "denied">("off");
  const [demoPlaying, setDemoPlaying] = useState(false);
  const [progress, setProgress] = useState({ played: 0, total: 0 });
  const [complete, setComplete] = useState(false);

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
  const micStateRef = useRef(micState);
  micStateRef.current = micState;
  const demoPlayingRef = useRef(demoPlaying);
  demoPlayingRef.current = demoPlaying;

  // ---- derived music data ----
  const leftNotes = useMemo(
    () => (song ? generateLeftHand(song.chords, difficulty) : []),
    [song, difficulty]
  );
  const expectedNotes: NoteEvent[] = useMemo(() => {
    if (!song) return [];
    const notes: NoteEvent[] = [];
    if (handMode !== "left") notes.push(...song.melody);
    if (handMode !== "right") notes.push(...leftNotes);
    return notes.sort((a, b) => a.start - b.start);
  }, [song, handMode, leftNotes]);
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

  // ---- rebuild engine when the step list changes ----
  useEffect(() => {
    engineRef.current = createPracticeEngine(steps);
    songTimeRef.current = 0;
    wrongFlashRef.current = null;
    setComplete(false);
    setProgress({ played: 0, total: steps.length });
  }, [steps]);

  const restart = () => {
    stopDemo();
    engineRef.current.reset();
    songTimeRef.current = 0;
    wrongFlashRef.current = null;
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
        if (r.done) setComplete(true);
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
    if (expectedNotes.length === 0) return;
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    const ctx = audioCtxRef.current;
    await ctx.resume();
    demoRef.current = playDemo(ctx, expectedNotes);
    songTimeRef.current = 0;
    setDemoPlaying(true);
  };

  // ---- main render / timing loop ----
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      const engine = engineRef.current;
      if (demoPlayingRef.current && demoRef.current) {
        const t = demoRef.current.elapsed();
        songTimeRef.current = t;
        if (t >= demoRef.current.duration) stopDemo();
      } else if (micStateRef.current === "on" && song && !complete) {
        const next = engine.current();
        if (next && songTimeRef.current >= next.time) {
          songTimeRef.current = next.time; // freeze: waiting for the note
        } else {
          songTimeRef.current = Math.min(songTimeRef.current + dt, song.duration);
        }
      }

      draw(now);

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
  }, [song, steps]);

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

    // Hit line.
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fillRect(0, hitY - 1, W, 2);

    // Keyboard.
    for (const k of geom.keys) {
      if (k.isBlack) continue;
      ctx.fillStyle = "#e9e9e6";
      ctx.strokeStyle = "#0a0c0a";
      ctx.lineWidth = 1;
      ctx.fillRect(keyX(k), hitY, keyW(k), keyH);
      ctx.strokeRect(keyX(k) + 0.5, hitY, keyW(k) - 1, keyH);
    }
    // C labels.
    ctx.fillStyle = "#8a8a86";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "center";
    for (const k of geom.keys) {
      if (!k.isBlack && k.midi % 12 === 0) {
        ctx.fillText(midiToName(k.midi), keyX(k) + keyW(k) / 2, hitY + keyH - 10);
      }
    }
    for (const k of geom.keys) {
      if (!k.isBlack) continue;
      ctx.fillStyle = "#101312";
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

  const nextStep: PracticeStep | null =
    !demoPlaying && !complete ? engineRef.current.current() : null;

  if (loadError) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-16 text-center">
        <p className="text-red-400">{loadError}</p>
        <Link href="/" className="mt-4 inline-block text-[#2bff88] underline">
          Back to home
        </Link>
      </main>
    );
  }

  if (!song) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-16 text-center text-neutral-400">
        Loading your practice track…
      </main>
    );
  }

  const pct =
    progress.total > 0 ? Math.round((progress.played / progress.total) * 100) : 0;

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      {/* header */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link
            href="/"
            className="text-sm font-bold tracking-tight text-white"
          >
            Key<span className="text-[#2bff88]">Sync</span>
          </Link>
          <h1 className="mt-1 text-xl font-bold text-white sm:text-2xl">{song.title}</h1>
          <p className="mt-1 text-sm text-neutral-400">
            {song.key.name} · {song.bpm} BPM · {progress.total} notes
          </p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <button
            onClick={toggleDemo}
            className={`h-11 flex-1 rounded-xl px-5 font-semibold transition active:scale-[0.98] sm:flex-none ${
              demoPlaying
                ? "bg-neutral-700 text-white hover:bg-neutral-600"
                : "bg-[#2bff88] text-black hover:brightness-110"
            }`}
          >
            {demoPlaying ? "Stop demo" : "Play demo"}
          </button>
          <button
            onClick={restart}
            className="h-11 flex-1 rounded-xl border border-neutral-700 px-5 font-medium text-neutral-300 transition hover:border-neutral-500 hover:text-white active:scale-[0.98] sm:flex-none"
          >
            Restart
          </button>
        </div>
      </header>

      {/* controls */}
      <div className="mt-6 flex flex-wrap items-center gap-4 rounded-2xl border border-neutral-800 bg-[#101311] p-4 sm:gap-6">
        <div className="w-full sm:w-auto">
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
            Hands
          </p>
          <div className="flex rounded-xl border border-neutral-700 p-1">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setHandMode(m.id)}
                className={`flex-1 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition sm:flex-none ${
                  handMode === m.id
                    ? "bg-[#2bff88] text-black"
                    : "text-neutral-400 hover:text-white"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div className="w-full sm:w-auto">
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
            Left hand difficulty
          </p>
          <div className="flex rounded-xl border border-neutral-700 p-1">
            {DIFFICULTIES.map((d) => (
              <button
                key={d.id}
                title={d.hint}
                onClick={() => setDifficulty(d.id)}
                className={`flex-1 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition sm:flex-none ${
                  difficulty === d.id
                    ? "bg-[#5aa9ff] text-black"
                    : "text-neutral-400 hover:text-white"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
        <div className="w-full sm:ml-auto sm:w-auto">
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
            Microphone
          </p>
          {micState === "on" ? (
            <button
              onClick={stopMic}
              title="Stop listening"
              className="flex h-11 items-center gap-2 rounded-xl border border-[#2bff88]/40 bg-[#2bff88]/10 px-4 transition hover:bg-[#2bff88]/20"
            >
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[#2bff88]" />
              <span className="text-sm font-medium text-[#2bff88]">
                Listening — tap to stop
              </span>
            </button>
          ) : (
            <button
              onClick={enableMic}
              disabled={micState === "starting"}
              className="h-11 w-full rounded-xl bg-[#2bff88] px-5 text-sm font-semibold text-black transition hover:brightness-110 active:scale-[0.98] disabled:opacity-60 sm:w-auto"
            >
              {micState === "starting" ? "Starting…" : "Enable microphone"}
            </button>
          )}
          {micState === "denied" && (
            <p className="mt-1 text-xs text-red-400">
              Mic blocked. Allow access in the browser bar.
            </p>
          )}
        </div>
      </div>

      {/* progress */}
      <div className="mt-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-neutral-400">
            {progress.played} / {progress.total} notes
          </span>
          <span className="font-semibold text-[#2bff88]">{pct}%</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full rounded-full bg-[#2bff88] transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* hint */}
      <div className="mt-4 h-8 text-center">
        {complete ? (
          <p className="text-lg font-semibold text-[#2bff88]">
            Song complete. Nicely played.
          </p>
        ) : demoPlaying ? (
          <p className="text-neutral-400">
            Listening to the demo — melody in green, left hand in blue.
          </p>
        ) : micState !== "on" ? (
          <p className="text-neutral-400">
            Enable the microphone, then play the glowing key on your piano.
          </p>
        ) : nextStep ? (
          <p className="text-neutral-200">
            Play{" "}
            <span className="font-bold text-[#2bff88]">
              {nextStep.isChord
                ? midiToName(nextStep.bass)
                : nextStep.midis.map(midiToName).join(" + ")}
            </span>
            {nextStep.hand === "left" && (
              <span className="text-neutral-400">
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
        className="mt-2 overflow-hidden rounded-2xl border border-neutral-800 bg-[#0d100e]"
      >
        <canvas ref={canvasRef} className="block w-full" />
      </div>

      <div className="mt-4 flex items-center justify-center gap-6 text-sm text-neutral-500">
        <span className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-sm bg-[#2bff88]" /> Right hand
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-sm bg-[#5aa9ff]" /> Left hand
        </span>
      </div>
    </main>
  );
}
