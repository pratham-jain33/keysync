// Piano sound for the "Play demo" button. Uses Salamander Grand Piano
// samples (public-domain recordings) hosted by the Tone.js project, fetched
// lazily on first play and cached in memory. If the samples cannot be loaded
// (offline), falls back to the built-in oscillator synth so demo always plays.

import { midiToHz } from "./pitch";
import type { NoteEvent } from "./types";

export interface DemoHandle {
  /** seconds elapsed since demo start */
  elapsed(): number;
  stop(): void;
  readonly duration: number;
}

const SAMPLE_BASE = "https://tonejs.github.io/audio/salamander/";
// Salamander ships one recording every minor third: C, D#, F#, A.
const SAMPLED_PCS = [
  { pc: 0, name: "C" },
  { pc: 3, name: "Ds" },
  { pc: 6, name: "Fs" },
  { pc: 9, name: "A" },
] as const;

const PC_TO_MIDI: Record<string, number> = { C: 0, Ds: 3, Fs: 6, A: 9 };

function sampleName(sampledMidi: number): string {
  const octave = Math.floor(sampledMidi / 12) - 1;
  const pc = ((sampledMidi % 12) + 12) % 12;
  const s = SAMPLED_PCS.find((x) => x.pc === pc);
  // nearestSampled only returns sampled pitch classes, so this always hits.
  return `${s ? s.name : "C"}${octave}`;
}

function sampleMidi(name: string): number {
  const m = /^([A-Za-z]+)(-?\d+)$/.exec(name);
  if (!m) return 60;
  const pc = PC_TO_MIDI[m[1]] ?? 0;
  return (parseInt(m[2], 10) + 1) * 12 + pc;
}

/** Nearest sampled pitch (every minor third) to the given MIDI note. */
function nearestSampled(midi: number): number {
  const m = Math.max(21, Math.min(108, Math.round(midi)));
  let best = 60;
  let bestDist = Infinity;
  for (let oct = 1; oct <= 7; oct++) {
    for (const s of SAMPLED_PCS) {
      const sm = (oct + 1) * 12 + s.pc;
      const d = Math.abs(sm - m);
      if (d < bestDist) {
        bestDist = d;
        best = sm;
      }
    }
  }
  return best;
}

const bufferCache = new Map<string, AudioBuffer>();
let inflight: Promise<void> | null = null;

/** Fetch + decode the samples covering the notes' range. Never throws. */
function ensureSamples(ctx: AudioContext, midis: number[]): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    const needed = new Set(midis.map(nearestSampled));
    await Promise.all(
      Array.from(needed).map(async (sm) => {
        const name = sampleName(sm);
        if (bufferCache.has(name)) return;
        try {
          const res = await fetch(SAMPLE_BASE + name + ".mp3");
          if (!res.ok) return;
          const raw = await res.arrayBuffer();
          bufferCache.set(name, await ctx.decodeAudioData(raw));
        } catch {
          // Offline or missing file: the per-note synth fallback covers it.
        }
      })
    );
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Best cached sample for a note, with the pitch-shift ratio. Null if none. */
function pickSample(midi: number): { buf: AudioBuffer; rate: number } | null {
  let best: AudioBuffer | null = null;
  let bestDist = Infinity;
  let bestSm = 60;
  for (const [name, buf] of Array.from(bufferCache.entries())) {
    const sm = sampleMidi(name);
    const d = Math.abs(sm - midi);
    if (d < bestDist) {
      bestDist = d;
      best = buf;
      bestSm = sm;
    }
  }
  if (!best) return null;
  return { buf: best, rate: Math.pow(2, (midi - bestSm) / 12) };
}

/** The old oscillator synth, kept as the offline fallback. */
function playSynthNote(
  ctx: AudioContext,
  master: GainNode,
  n: NoteEvent,
  start: number,
  dur: number,
  vel: number
): void {
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = midiToHz(n.midi);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(vel, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.001, start + dur);
  osc.connect(g).connect(master);
  osc.start(start);
  osc.stop(start + dur + 0.05);

  const osc2 = ctx.createOscillator();
  osc2.type = "sine";
  osc2.frequency.value = midiToHz(n.midi) * 2;
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0, start);
  g2.gain.linearRampToValueAtTime(vel * 0.25, start + 0.012);
  g2.gain.exponentialRampToValueAtTime(0.001, start + dur * 0.7);
  osc2.connect(g2).connect(master);
  osc2.start(start);
  osc2.stop(start + dur + 0.05);
}

/**
 * Play notes with real piano samples through a fresh master gain. Samples
 * load on first call (awaited); afterwards playback starts instantly.
 * Returns a handle to track the playhead and stop early.
 */
export async function playDemo(
  ctx: AudioContext,
  notes: NoteEvent[]
): Promise<DemoHandle> {
  await ensureSamples(
    ctx,
    notes.map((n) => n.midi)
  );

  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  const t0 = ctx.currentTime + 0.15;
  let end = 0;

  for (const n of notes) {
    const start = t0 + n.start;
    const dur = Math.max(0.15, Math.min(n.end - n.start, 5));
    end = Math.max(end, n.start + dur);
    const vel = Math.min(1, 0.9 * (n.velocity ?? 0.8));

    const pick = pickSample(n.midi);
    if (pick) {
      const src = ctx.createBufferSource();
      src.buffer = pick.buf;
      src.playbackRate.value = pick.rate;
      const g = ctx.createGain();
      // Gentle attack, hold through the note, then a natural-style release.
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(vel, start + 0.008);
      g.gain.setValueAtTime(vel, start + dur);
      g.gain.exponentialRampToValueAtTime(0.001, start + dur + 0.9);
      src.connect(g).connect(master);
      src.start(start);
      src.stop(start + dur + 1.0);
    } else {
      playSynthNote(ctx, master, n, start, dur, vel);
    }
  }

  let stopped = false;
  return {
    duration: end,
    elapsed() {
      return stopped ? end : Math.max(0, ctx.currentTime - t0);
    },
    stop() {
      stopped = true;
      try {
        master.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}
