"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Brand, LogoMark } from "@/components/Brand";
import { buildSteps, createPracticeEngine, MicNoteTracker } from "@/lib/practice";
import type { PracticeStep } from "@/lib/practice";
import { createPitchDetector } from "@/lib/pitch";
import type { FramePitchDetector } from "@/lib/pitch";
import {
  applyCalibration,
  clearCalibration,
  loadCalibration,
  DEFAULT_SILENCE_THRESHOLD,
  type MicCalibration,
} from "@/lib/mic-calibration";
import MicCalibrationWizard from "@/components/MicCalibrationWizard";
import { midiToName } from "@/lib/theory";
import { getSavedSong, isLocalId } from "@/lib/saved-songs";
import { playDemo, prefetchPianoBuffers, isPianoLoaded } from "@/lib/synth";
import type { DemoHandle } from "@/lib/synth";
import { useAuth } from "@/components/AuthProvider";
import { RequireAuth } from "@/components/AuthGate";
import { saveSong } from "@/lib/songs";
import type {
  NoteEvent,
  SongData,
} from "@/lib/types";

const GREEN = "#e6b45c";
const RED = "#ff4d5e";

// LocalStorage keys for display prefs, mastery and streaks.
const LS_DISPLAY = "keysync-display";
const LS_MASTERY = "keysync-mastery";
const LS_STREAK = "keysync-streak";

interface DisplayPrefs {
  noteLabels: boolean;
  hitEffects: boolean;
  highContrast: boolean;
}

const DEFAULT_DISPLAY: DisplayPrefs = {
  noteLabels: true,
  hitEffects: true,
  highContrast: false,
};

function loadDisplay(): DisplayPrefs {
  try {
    const raw = localStorage.getItem(LS_DISPLAY);
    if (raw) return { ...DEFAULT_DISPLAY, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULT_DISPLAY;
}

function todayStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}


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
  return (
    <RequireAuth>
      <Practice />
    </RequireAuth>
  );
}

function Practice() {
  const params = useParams<{ songId: string }>();
  const { user } = useAuth();
  const [song, setSong] = useState<SongData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [micState, setMicState] = useState<"off" | "starting" | "on" | "denied">("off");
  const [demoPlaying, setDemoPlaying] = useState(false);
  const [pianoLoading, setPianoLoading] = useState(false);
  const [progress, setProgress] = useState({ played: 0, total: 0 });
  const [complete, setComplete] = useState(false);
  // Bumped whenever a chord note is hit so the remaining-notes counter re-renders.
  const [chordVersion, setChordVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  // Tempo (demo playback speed), A/B loop, count-in.
  const [tempo, setTempo] = useState(1);
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const [countIn, setCountIn] = useState(0); // bars: 0, 1, 2
  const [countBeat, setCountBeat] = useState<number | null>(null);

  // Display preferences (persisted).
  const [display, setDisplay] = useState<DisplayPrefs>(DEFAULT_DISPLAY);
  useEffect(() => {
    setDisplay(loadDisplay());
  }, []);

  // Mic calibration (per-device: mic + piano + room). Null = defaults.
  const [calibration, setCalibration] = useState<MicCalibration | null>(null);
  const [calWizardOpen, setCalWizardOpen] = useState(false);
  useEffect(() => {
    setCalibration(loadCalibration());
  }, []);
  const calibrationRef = useRef<MicCalibration | null>(null);
  calibrationRef.current = calibration;
  const setDisplayPref = (k: keyof DisplayPrefs, v: boolean) => {
    setDisplay((prev) => {
      const next = { ...prev, [k]: v };
      try {
        localStorage.setItem(LS_DISPLAY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // Per-run stats for the post-run report.
  const statsRef = useRef({ correct: 0, wrong: 0, startedAt: 0 });
  const [runReport, setRunReport] = useState<{
    accuracy: number;
    mistakes: number;
    notes: number;
    seconds: number;
  } | null>(null);

  const recordCompletion = useCallback(() => {
    const s = statsRef.current;
    const total = engineRef.current.steps.length;
    const accuracy =
      total > 0 ? Math.round((100 * total) / Math.max(total, total + s.wrong)) : 100;
    const seconds = s.startedAt > 0 ? Math.round((Date.now() - s.startedAt) / 1000) : 0;
    setRunReport({ accuracy, mistakes: s.wrong, notes: total, seconds });
    // Persist best mastery for this song.
    try {
      const id = params.songId;
      const raw = localStorage.getItem(LS_MASTERY);
      const map: Record<string, number> = raw ? JSON.parse(raw) : {};
      if (accuracy > (map[id] ?? -1)) {
        map[id] = accuracy;
        localStorage.setItem(LS_MASTERY, JSON.stringify(map));
      }
    } catch {
      /* ignore */
    }
    // Practice streak (1-day grace for a missed day).
    try {
      const raw = localStorage.getItem(LS_STREAK);
      const st: { last: string; count: number } = raw
        ? JSON.parse(raw)
        : { last: "", count: 0 };
      const today = todayStr();
      if (st.last !== today) {
        const y = new Date();
        y.setDate(y.getDate() - 1);
        const diffDays = Math.round(
          (new Date(today).getTime() - new Date(st.last || today).getTime()) / 86400000
        );
        st.count = st.last === "" || diffDays > 2 ? 1 : st.count + 1;
        st.last = today;
        localStorage.setItem(LS_STREAK, JSON.stringify(st));
      }
    } catch {
      /* ignore */
    }
  }, [params.songId]);

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
  // Geometry mirrors for the mic tick (burst positioning) — populated by draw().
  const byMidiRef = useRef<Map<number, KeyGeom>>(new Map());
  const whiteCountRef = useRef(1);
  const micRef = useRef<MicNodes | null>(null);
  // Decides which detected pitches reach the practice engine (stability,
  // repeat suppression, onset re-arming). See lib/practice.ts.
  const trackerRef = useRef(new MicNoteTracker());
  // Live mic diagnostics, updated imperatively at 20fps (no re-renders).
  const levelBarRef = useRef<HTMLDivElement | null>(null);
  const heardRef = useRef<HTMLSpanElement | null>(null);
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
  // Bumped on every teardown (restart, new song, loop change).
  // An async demo load started under an old generation is discarded.
  const genRef = useRef(0);

  // ---- derived music data ----
  // Every transcribed note, no hand distinction.
  const expectedNotes: NoteEvent[] = useMemo(() => {
    if (!song) return [];
    // All notes, no hand distinction.
    return [...song.melody].sort((a, b) => a.start - b.start);
  }, [song]);
  const steps: PracticeStep[] = useMemo(
    () => buildSteps(expectedNotes),
    [expectedNotes]
  );

  // A/B loop: when enabled with valid markers, practice only the region.
  const loopValid = loopOn && loopA != null && loopB != null && loopB > loopA + 0.5;
  const activeSteps: PracticeStep[] = useMemo(
    () =>
      loopValid
        ? steps.filter((s) => s.time >= (loopA as number) && s.time < (loopB as number))
        : steps,
    [steps, loopValid, loopA, loopB]
  );
  // Wall offset added back when the demo plays a looped segment from A.
  const loopOffsetRef = useRef(0);
  // Live mirror for the mic tick closure (state would go stale mid-take).
  const loopStateRef = useRef({ valid: false, a: 0, b: 0 });
  useEffect(() => {
    loopStateRef.current = {
      valid: loopValid,
      a: loopA ?? 0,
      b: loopB ?? 0,
    };
  }, [loopValid, loopA, loopB]);

  interface Burst {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
  }
  const burstsRef = useRef<Burst[]>([]);
  const reducedMotionRef = useRef(false);
  useEffect(() => {
    try {
      reducedMotionRef.current = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;
    } catch {
      /* ignore */
    }
  }, []);

  const spawnBurst = (x: number, y: number) => {
    if (!display.hitEffects || reducedMotionRef.current) return;
    const arr = burstsRef.current;
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 140;
      arr.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 60,
        life: 0.5 + Math.random() * 0.3,
      });
    }
    if (arr.length > 240) arr.splice(0, arr.length - 240);
  };

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
  // A new step list means the song loaded or the loop region changed.
  // Tear everything down and rebuild from scratch so the view never shows a
  // stale demo or stale progress against the new note set.
  useEffect(() => {
    genRef.current++;
    stopDemo();
    engineRef.current = createPracticeEngine(activeSteps);
    songTimeRef.current = loopValid ? (loopA as number) : 0;
    loopOffsetRef.current = 0;
    burstsRef.current = [];
    wrongFlashRef.current = null;
    completeRef.current = false;
    setComplete(false);
    setRunReport(null);
    statsRef.current = { correct: 0, wrong: 0, startedAt: 0 };
    setProgress({ played: 0, total: activeSteps.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSteps]);

  const restart = () => {
    genRef.current++;
    stopDemo();
    engineRef.current.reset();
    trackerRef.current.reset();
    songTimeRef.current = loopValid ? (loopA as number) : 0;
    loopOffsetRef.current = 0;
    burstsRef.current = [];
    wrongFlashRef.current = null;
    completeRef.current = false;
    setComplete(false);
    setRunReport(null);
    statsRef.current = { correct: 0, wrong: 0, startedAt: 0 };
    setProgress({ played: 0, total: engineRef.current.steps.length });
  };

  const stopMic = () => {
    micRef.current?.stream.getTracks().forEach((t) => t.stop());
    micRef.current?.ctx.close().catch(() => undefined);
    micRef.current = null;
    trackerRef.current.reset();
    if (levelBarRef.current) levelBarRef.current.style.width = "0%";
    if (heardRef.current) heardRef.current.textContent = "—";
    setMicState("off");
  };

  // ---- mic calibration ----
  // The wizard opens its own mic stream, so the practice mic (if running)
  // is stopped first — two streams would fight over the device.
  const openCalWizard = () => {
    if (micStateRef.current === "on" || micStateRef.current === "starting") {
      stopMic();
    }
    setCalWizardOpen(true);
  };

  const clearCal = () => {
    clearCalibration();
    setCalibration(null);
  };

  // ---- microphone ----
  // Mic and demo are mutually exclusive: enabling one stops the other.
  const enableMic = async () => {
    if (micStateRef.current === "on" || micStateRef.current === "starting") return;
    stopDemo();
    setMicState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      // Default sample rate: requesting an explicit rate is unreliable on
      // some Android devices; the detector reads ctx.sampleRate anyway.
      const ctx = new AudioContext();
      await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      const silenceGate =
        calibrationRef.current?.silenceThreshold ?? DEFAULT_SILENCE_THRESHOLD;
      micRef.current = {
        ctx,
        analyser,
        detector: createPitchDetector(ctx.sampleRate, 2048, {
          minRms: silenceGate,
        }),
        stream,
        buf: new Float32Array(analyser.fftSize),
      };
      trackerRef.current = new MicNoteTracker({ silenceRms: silenceGate });
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

      // Live input meter + last-heard readout, updated imperatively so the
      // 20fps tick never triggers React re-renders. If the bar stays flat
      // while playing, the mic signal isn't reaching us (device/permission).
      if (levelBarRef.current) {
        const level = res ? Math.min(1, res.rms / 0.25) : 0;
        levelBarRef.current.style.width = `${Math.round(level * 100)}%`;
      }
      const cal = calibrationRef.current;
      const corrected = res ? applyCalibration(res.midi, cal) : null;
      if (heardRef.current) {
        heardRef.current.textContent =
          corrected != null ? midiToName(Math.round(corrected)) : "—";
      }

      const midi = trackerRef.current.feed(
        corrected != null ? Math.round(corrected) : null,
        res?.rms ?? 0
      );
      if (midi == null) return;

      const engine = engineRef.current;
      const r = engine.play(midi);
      if (r.status === "correct") {
        wrongFlashRef.current = null;
        const st = statsRef.current;
        if (st.startedAt === 0) st.startedAt = Date.now();
        st.correct++;
        // Chord partially hit: re-render so the remaining-notes counter updates.
        if (r.remaining.length > 0) setChordVersion((v) => v + 1);
        // Hit burst at the struck key.
        const k = byMidiRef.current.get(midi);
        if (k && wrapRef.current) {
          const wrapW = wrapRef.current.clientWidth;
          const whiteW = wrapW / Math.max(1, whiteCountRef.current);
          const blackW = whiteW * 0.62;
          const x = k.isBlack
            ? k.x * whiteW - blackW / 2 + blackW / 2
            : k.x * whiteW + whiteW / 2;
          const H = Math.max(
            360,
            Math.min(500, Math.round(window.innerHeight * 0.55))
          );
          spawnBurst(x, H - 140);
        }
        if (r.done) {
          const loop = loopStateRef.current;
          if (loop.valid) {
            // Loop the region instead of finishing.
            engine.reset();
            trackerRef.current.reset();
            songTimeRef.current = loop.a;
            statsRef.current = { correct: 0, wrong: 0, startedAt: Date.now() };
            setProgress({ played: 0, total: engine.steps.length });
          } else {
            completeRef.current = true;
            setComplete(true);
            recordCompletion();
          }
        }
      } else if (r.status === "wrong") {
        statsRef.current.wrong++;
        if (statsRef.current.startedAt === 0)
          statsRef.current.startedAt = Date.now();
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
    // Bump the generation so an in-flight demo start (count-in beats or
    // sample loading) aborts instead of starting behind our back.
    genRef.current++;
    demoRef.current?.stop();
    demoRef.current = null;
    loopOffsetRef.current = 0;
    setCountBeat(null);
    setDemoPlaying(false);
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const startDemo = async () => {
    // Samples load on first play; ignore taps while they are loading.
    if (demoLoadingRef.current) return;
    if (expectedNotes.length === 0) return;
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    const ctx = audioCtxRef.current;
    // Snapshot the notes, tempo and generation now; all can change while the
    // samples load. A stale demo is discarded so we never play old notes.
    const gen = genRef.current;
    const rate = tempo;
    const useLoop = loopValid;
    const a = useLoop ? (loopA as number) : 0;
    const b = useLoop ? (loopB as number) : null;
    const segNotes =
      useLoop && b != null
        ? expectedNotes
            .filter((n) => n.start >= a && n.start < b)
            .map((n) => ({ ...n, start: n.start - a, end: n.end - a }))
        : expectedNotes;
    if (segNotes.length === 0) return;
    await ctx.resume();

    // Count-in: show the beats, then start.
    if (countIn > 0 && song) {
      const beatMs = 60000 / Math.max(40, song.bpm);
      const total = countIn * 4;
      for (let i = 0; i < total; i++) {
        if (gen !== genRef.current) return;
        setCountBeat(total - i);
        await sleep(beatMs);
      }
      if (gen !== genRef.current) return;
      setCountBeat(null);
    }

    demoLoadingRef.current = true;
    const needsLoad = !isPianoLoaded();
    if (needsLoad) setPianoLoading(true);
    try {
      const handle = await playDemo(ctx, segNotes, { rate });
      if (gen !== genRef.current) {
        handle.stop();
        return;
      }
      demoRef.current = handle;
      loopOffsetRef.current = a;
      songTimeRef.current = a;
      setDemoPlaying(true);
    } finally {
      demoLoadingRef.current = false;
      if (needsLoad) setPianoLoading(false);
    }
  };

  const toggleDemo = async () => {
    if (demoPlayingRef.current) {
      stopDemo();
      return;
    }
    // Mic and demo are mutually exclusive: starting the demo stops the mic.
    if (micStateRef.current === "on" || micStateRef.current === "starting") {
      stopMic();
    }
    // Changing tempo or loop restarts cleanly from the top of the region.
    await startDemo();
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
        const handle = demoRef.current;
        const t = handle.elapsed();
        const segLen =
          loopValid && loopA != null && loopB != null ? loopB - loopA : Infinity;
        if (loopValid && t >= segLen - 0.05) {
          // Loop the demo segment seamlessly. startDemo captures the
          // generation itself and aborts if anything changed mid-load.
          void (async () => {
            stopDemo();
            await startDemo();
          })();
        } else {
          songTimeRef.current = loopOffsetRef.current + t;
          if (t >= handle.duration) stopDemo();
        }
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
    byMidiRef.current = byMidi;
    whiteCountRef.current = geom.whiteCount ?? 1;

    const hc = display.highContrast;
    const noteFill = hc ? "#ffd97a" : GREEN;

    // Falling notes — every note in one brass voice (no hand distinction).
    for (const n of expectedNotes) {
      const k = byMidi.get(Math.round(n.midi));
      if (!k) continue;
      const y = hitY - (n.start - songTime) * pxPerSec;
      const h = Math.max(5, (n.end - n.start) * pxPerSec);
      if (y + h < 0 || y > hitY + 4) continue;
      const played = n.start < songTime - 1e-6;
      const upcoming = !played && n.start - songTime < 0.8;
      ctx.globalAlpha = played ? 0.18 : hc ? 1 : 0.92;
      ctx.fillStyle = noteFill;
      const nx = keyX(k) + keyW(k) * 0.14;
      const nw = keyW(k) * 0.72;
      const r = Math.min(4, nw / 2);
      ctx.beginPath();
      ctx.roundRect(nx, y - h, nw, h, r);
      ctx.fill();
      if (hc) {
        ctx.globalAlpha = played ? 0.25 : 1;
        ctx.strokeStyle = "#0a0a0c";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      // Next-note marker: a bright leading edge on notes about to land.
      if (upcoming) {
        ctx.globalAlpha = hc ? 1 : 0.85;
        ctx.fillStyle = hc ? "#ffffff" : "rgba(255,255,255,0.75)";
        ctx.fillRect(nx, y - h, nw, 2.5);
      }
      // Note-name label for beginners (toggleable).
      if (display.noteLabels && h > 16 && !played) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = hc ? "#0a0a0c" : "rgba(10,10,12,0.8)";
        ctx.font = "600 10px system-ui, sans-serif";
        ctx.textAlign = "center";
        const label = midiToName(Math.round(n.midi)).replace(/-?\d+$/, "");
        ctx.fillText(label, nx + nw / 2, y - h / 2 + 3.5);
      }
    }
    ctx.globalAlpha = 1;

    // Hit bursts (correct mic notes).
    const bursts = burstsRef.current;
    if (bursts.length > 0) {
      const dt = 1 / 60;
      ctx.fillStyle = GREEN;
      for (let i = bursts.length - 1; i >= 0; i--) {
        const p = bursts[i];
        p.life -= dt;
        if (p.life <= 0) {
          bursts.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 320 * dt;
        ctx.globalAlpha = Math.min(1, p.life * 2.5);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Hit line — a brass rail where the notes land.
    ctx.fillStyle = hc ? "rgba(255,217,122,0.9)" : "rgba(230,180,92,0.7)";
    ctx.fillRect(0, hitY - 1.5, W, 3);
    ctx.fillStyle = "rgba(230,180,92,0.18)";
    ctx.fillRect(0, hitY - 7, W, 5);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, hitY + 1.5, W, 6);

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

    // Waiting glow on the expected key(s). Chord steps glow every note;
    // already-hit chord notes dim so the player sees what remains.
    if (next && micStateRef.current === "on" && !complete) {
      const pulse = 0.55 + 0.35 * Math.sin(now / 220);
      const remaining = new Set(engine.chordRemaining());
      for (const m of next.midis) {
        const k = byMidi.get(m);
        if (!k) continue;
        const hit = next.isChord && !remaining.has(m);
        ctx.globalAlpha = hit ? 0.16 : pulse;
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
  // current notes, geometry and completion state.
  drawRef.current = draw;

  // Keyboard shortcuts: Space toggles the demo (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        void toggleDemo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expectedNotes, tempo, loopValid, loopA, loopB, countIn, song]);

  const nextStep: PracticeStep | null =
    !demoPlaying && !complete ? engineRef.current.current() : null;
  // chordVersion is a re-render trigger only (bumped by the mic tick on
  // partial chord hits); the remaining count is read live from the engine.
  void chordVersion;
  const chordRemaining: number[] =
    nextStep && nextStep.isChord ? engineRef.current.chordRemaining() : [];

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
          <p className="mt-1.5 font-mono text-xs uppercase tracking-wider tabular-nums text-ink-faint">
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
          {song && (
            <button
              onClick={handleSaveToCloud}
              disabled={saving}
              className="h-11 flex-1 rounded-xl border border-line-strong px-5 font-medium text-ink-dim transition hover:border-accent hover:text-ink active:scale-[0.98] sm:flex-none disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save to cloud"}
            </button>
          )}
        </div>
      </header>
      {saveMessage && (
        <p
          className={`mt-3 text-sm ${
            saveMessage.includes("Saved") ? "text-accent" : "text-danger"
          }`}
        >
          {saveMessage}
        </p>
      )}

      {/* controls */}
      <div className="mt-6 card p-4 sm:p-6">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-5">
          {/* Tempo */}
          <div className="w-full sm:w-56">
            <p className="mb-2 label-eyebrow">Tempo</p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0.25}
                max={1}
                step={0.05}
                value={tempo}
                onChange={(e) => {
                  stopDemo();
                  setTempo(parseFloat(e.target.value));
                }}
                className="h-11 flex-1 accent-accent"
                aria-label="Playback tempo"
              />
              <span className="w-14 text-right font-mono text-sm tabular-nums text-ink">
                {tempo.toFixed(2)}×
              </span>
            </div>
          </div>

          {/* A/B loop */}
          <div className="w-full sm:w-auto">
            <p className="mb-2 label-eyebrow">Loop a section</p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => {
                  const t = Math.round(songTimeRef.current * 10) / 10;
                  setLoopA(t);
                  if (loopB != null && loopB <= t + 0.5) setLoopB(null);
                }}
                className="h-11 rounded-xl border border-line-strong px-4 text-sm font-medium text-ink-dim transition hover:border-accent hover:text-ink active:scale-[0.98]"
              >
                Set A{loopA != null ? ` · ${fmtTime(loopA)}` : ""}
              </button>
              <button
                onClick={() => {
                  const t = Math.round(songTimeRef.current * 10) / 10;
                  if (loopA == null || t > loopA + 0.5) setLoopB(t);
                }}
                className="h-11 rounded-xl border border-line-strong px-4 text-sm font-medium text-ink-dim transition hover:border-accent hover:text-ink active:scale-[0.98]"
              >
                Set B{loopB != null ? ` · ${fmtTime(loopB)}` : ""}
              </button>
              <button
                onClick={() => {
                  if (!loopValid) return;
                  setLoopOn((v) => !v);
                  restart();
                }}
                disabled={!loopValid}
                className={`h-11 rounded-xl px-4 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${
                  loopOn
                    ? "bg-accent text-accent-ink hover:brightness-110"
                    : "border border-line-strong text-ink-dim hover:border-accent hover:text-ink"
                }`}
              >
                {loopOn ? "Loop on" : "Loop off"}
              </button>
              {(loopA != null || loopB != null) && (
                <button
                  onClick={() => {
                    setLoopA(null);
                    setLoopB(null);
                    setLoopOn(false);
                  }}
                  className="btn-ghost h-11 text-sm"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Count-in */}
          <div className="w-full sm:w-auto">
            <p className="mb-2 label-eyebrow">Count-in</p>
            <div className="flex rounded-xl border border-line-strong p-1">
              {[0, 1, 2].map((b) => (
                <button
                  key={b}
                  onClick={() => setCountIn(b)}
                  className={`h-9 flex-1 whitespace-nowrap rounded-lg px-4 text-sm font-medium transition sm:flex-none ${
                    countIn === b
                      ? "bg-accent text-accent-ink"
                      : "text-ink-dim hover:text-ink"
                  }`}
                >
                  {b === 0 ? "Off" : `${b} bar${b > 1 ? "s" : ""}`}
                </button>
              ))}
            </div>
          </div>

          {/* Microphone */}
          <div className="w-full sm:w-auto">
            <p className="mb-2 label-eyebrow">Microphone</p>
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
            {micState === "on" && (
              <div className="mt-2 flex items-center gap-2">
                <div
                  className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2"
                  aria-hidden="true"
                >
                  <div
                    ref={levelBarRef}
                    className="h-full rounded-full bg-accent"
                    style={{ width: "0%" }}
                  />
                </div>
                <span className="font-mono text-xs tabular-nums text-ink-faint">
                  hearing <span ref={heardRef} className="text-ink-dim">—</span>
                </span>
              </div>
            )}
            {micState === "denied" && (
              <p className="mt-1 text-xs text-danger">
                Mic blocked. Allow access in the browser bar.
              </p>
            )}
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={openCalWizard}
                className="h-8 rounded-full px-3 text-xs font-medium text-ink-dim ring-1 ring-line transition hover:text-accent hover:ring-accent/50 active:scale-[0.98]"
              >
                Calibrate mic
              </button>
              {calibration && (
                <span className="flex items-center gap-1.5 rounded-full bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent ring-1 ring-accent/50">
                  Calibrated
                  <button
                    onClick={clearCal}
                    aria-label="Clear mic calibration"
                    title="Clear calibration and revert to defaults"
                    className="text-accent/70 transition hover:text-accent"
                  >
                    ✕
                  </button>
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Display toggles */}
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <span className="label-eyebrow mr-1">Display</span>
          {(
            [
              ["noteLabels", "Note labels"],
              ["hitEffects", "Hit effects"],
              ["highContrast", "High contrast"],
            ] as [keyof DisplayPrefs, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setDisplayPref(key, !display[key])}
              aria-pressed={display[key]}
              className={`h-9 rounded-full px-4 text-xs font-medium transition active:scale-[0.98] ${
                display[key]
                  ? "bg-accent/15 text-accent ring-1 ring-accent/50"
                  : "bg-surface-2 text-ink-faint ring-1 ring-line hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
          <span className="ml-auto hidden text-xs text-ink-faint sm:inline">
            Space = play/stop demo
          </span>
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
            Listening to the demo — follow the falling notes.
          </p>
        ) : micState !== "on" ? (
          <p key="mic-off" className="animate-fade text-ink-dim">
            Enable the microphone, then play the glowing key on your piano.
          </p>
        ) : nextStep ? (
          <p key="next" className="animate-fade text-ink">
            Play{" "}
            <span className="font-bold text-accent">
              {nextStep.midis.map(midiToName).join(" + ")}
            </span>
            {nextStep.isChord && (
              <span className="text-ink-dim">
                {" "}
                ({nextStep.midis.length - chordRemaining.length} of{" "}
                {nextStep.midis.length})
              </span>
            )}
          </p>
        ) : null}
      </div>

      {/* keyboard */}
      <div
        ref={wrapRef}
        className="relative mt-2 overflow-hidden rounded-2xl border border-line bg-surface-2"
      >
        <canvas ref={canvasRef} className="block w-full" />
        {countBeat != null && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span
              key={countBeat}
              className="animate-pop font-display text-7xl font-bold tabular-nums text-accent"
            >
              {countBeat}
            </span>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-center gap-2 text-xs text-ink-faint">
        <span className="inline-block h-3 w-3 rounded-sm bg-accent" />
        <span>All notes — play every falling bar on your piano</span>
      </div>

      {/* Post-run report */}
      {runReport && (
        <section className="animate-pop mt-6 card p-4 sm:p-6">
          <h2 className="label-eyebrow">Run report</h2>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl bg-surface-2 p-4 text-center">
              <p className="font-display text-3xl font-semibold tabular-nums text-accent">
                {runReport.accuracy}%
              </p>
              <p className="mt-1 text-xs text-ink-dim">Note accuracy</p>
            </div>
            <div className="rounded-xl bg-surface-2 p-4 text-center">
              <p className="font-display text-3xl font-semibold tabular-nums text-ink">
                {runReport.mistakes}
              </p>
              <p className="mt-1 text-xs text-ink-dim">Mistakes</p>
            </div>
            <div className="rounded-xl bg-surface-2 p-4 text-center">
              <p className="font-display text-3xl font-semibold tabular-nums text-ink">
                {runReport.notes}
              </p>
              <p className="mt-1 text-xs text-ink-dim">Notes played</p>
            </div>
            <div className="rounded-xl bg-surface-2 p-4 text-center">
              <p className="font-display text-3xl font-semibold tabular-nums text-ink">
                {Math.floor(runReport.seconds / 60)}:
                {String(runReport.seconds % 60).padStart(2, "0")}
              </p>
              <p className="mt-1 text-xs text-ink-dim">Time</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <button onClick={restart} className="btn-primary h-11 px-5 text-sm">
              Practice again
            </button>
            <Link href="/" className="btn-outline h-11 px-5 text-sm">
              Back to home
            </Link>
          </div>
        </section>
      )}

      {/* Mic calibration wizard */}
      {calWizardOpen && (
        <MicCalibrationWizard
          onClose={() => setCalWizardOpen(false)}
          onSaved={(c) => {
            setCalibration(c);
            setCalWizardOpen(false);
          }}
        />
      )}
    </main>
  );
}
