// Grand-piano sound for KeySync, used by the practice page's "Play demo".
//
// Playback is a real multisampled grand (Salamander, served from our own
// origin — see lib/piano-samples.ts). Each played note picks the nearest
// recorded pitch, shifts it to the exact note, and shapes it with a
// natural-piano envelope plus a velocity-driven brightness filter so soft
// notes sound dark and round and loud notes sound bright. A whole-mix
// compressor glues chords and keeps stacked notes from clipping.
//
// If a sample fails to decode (should not happen with same-origin files) the
// affected note falls back to a layered oscillator voice so the demo always
// plays.

import { midiToHz } from "./pitch";
import { PIANO_SAMPLES, nearestSample } from "./piano-samples";
import type { NoteEvent } from "./types";

export interface DemoHandle {
  /** seconds elapsed since demo start */
  elapsed(): number;
  stop(): void;
  readonly duration: number;
}

// name -> decoded AudioBuffer, and name -> raw mp3 bytes prefetched ahead of
// the first play so decoding on tap is near-instant.
const bufferCache = new Map<string, AudioBuffer>();
const rawCache = new Map<string, ArrayBuffer>();
let prefetchInflight: Promise<void> | null = null;
let decodeInflight: Promise<void> | null = null;

/** True once every sample is decoded and ready for instant playback. */
export function isPianoLoaded(): boolean {
  return bufferCache.size >= PIANO_SAMPLES.length;
}

/**
 * Fetch every sample's bytes (no AudioContext needed, so it can run on page
 * mount before any user gesture). Decoding still happens lazily on first play,
 * but the network cost is paid up front. Never throws.
 */
export function prefetchPianoBuffers(): Promise<void> {
  if (prefetchInflight) return prefetchInflight;
  prefetchInflight = (async () => {
    await Promise.all(
      PIANO_SAMPLES.map(async (s) => {
        if (rawCache.has(s.name) || bufferCache.has(s.name)) return;
        try {
          const res = await fetch(s.url);
          if (!res.ok) return;
          rawCache.set(s.name, await res.arrayBuffer());
        } catch {
          // Offline: loadPiano will retry, or the per-note synth covers it.
        }
      })
    );
  })();
  return prefetchInflight;
}

/**
 * Ensure every sample is decoded into an AudioBuffer on `ctx`. Uses prefetched
 * bytes when available, otherwise fetches. Deduped across concurrent calls and
 * never throws — a note whose sample is missing uses the synth fallback.
 */
export function loadPiano(ctx: AudioContext): Promise<void> {
  if (isPianoLoaded()) return Promise.resolve();
  if (decodeInflight) return decodeInflight;
  decodeInflight = (async () => {
    await Promise.all(
      PIANO_SAMPLES.map(async (s) => {
        if (bufferCache.has(s.name)) return;
        try {
          let raw = rawCache.get(s.name);
          if (!raw) {
            const res = await fetch(s.url);
            if (!res.ok) return;
            raw = await res.arrayBuffer();
          }
          // decodeAudioData detaches its input; decode a copy so a cached
          // buffer stays reusable if we ever decode onto a second context.
          const buf = await ctx.decodeAudioData(raw.slice(0));
          bufferCache.set(s.name, buf);
          rawCache.delete(s.name);
        } catch {
          // Leave this note to the oscillator fallback.
        }
      })
    );
  })().finally(() => {
    decodeInflight = null;
  });
  return decodeInflight;
}

/** Best decoded sample for a note, plus the pitch-shift ratio. Null if none. */
function pickSample(midi: number): { buf: AudioBuffer; rate: number } | null {
  // Try the nearest recorded pitch first; if its decode failed, scan outward
  // through whatever did decode so we never silently drop to the synth.
  const ideal = nearestSample(midi);
  let bestName = ideal.name;
  let bestMidi = ideal.midi;
  if (!bufferCache.has(bestName)) {
    let bestDist = Infinity;
    bestName = "";
    for (const s of PIANO_SAMPLES) {
      if (!bufferCache.has(s.name)) continue;
      const d = Math.abs(s.midi - midi);
      if (d < bestDist) {
        bestDist = d;
        bestName = s.name;
        bestMidi = s.midi;
      }
    }
    if (!bestName) return null;
  }
  const buf = bufferCache.get(bestName)!;
  return { buf, rate: Math.pow(2, (midi - bestMidi) / 12) };
}

/** Layered oscillator voice, used only when a sample is unavailable. */
function playSynthNote(
  ctx: AudioContext,
  master: AudioNode,
  n: NoteEvent,
  start: number,
  dur: number,
  peak: number
): void {
  const hz = midiToHz(n.midi);
  // A triangle fundamental with two quiet, quick-decaying partials reads more
  // like a struck string than a lone oscillator.
  const partials: Array<[OscillatorType, number, number, number]> = [
    ["triangle", 1, peak, dur],
    ["sine", 2, peak * 0.22, dur * 0.6],
    ["sine", 3, peak * 0.1, dur * 0.4],
  ];
  for (const [type, mult, amp, life] of partials) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = hz * mult;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp), start + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, start + life + 0.2);
    osc.connect(g).connect(master);
    osc.start(start);
    osc.stop(start + life + 0.3);
  }
}

/**
 * Play notes with the sampled grand through a fresh mix bus. Samples load on
 * first call (awaited); afterwards playback starts instantly. Returns a handle
 * that tracks the playhead on the audio clock and can stop early.
 */
export async function playDemo(
  ctx: AudioContext,
  notes: NoteEvent[]
): Promise<DemoHandle> {
  await loadPiano(ctx);

  // Mix bus: master gain -> gentle compressor -> output. The compressor glues
  // chords and stops stacked notes from clipping without audible pumping.
  const master = ctx.createGain();
  master.gain.value = 0.82;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 22;
  comp.ratio.value = 3;
  comp.attack.value = 0.004;
  comp.release.value = 0.25;
  master.connect(comp).connect(ctx.destination);

  const t0 = ctx.currentTime + 0.15;
  let end = 0;

  for (const n of notes) {
    const start = t0 + n.start;
    const dur = Math.max(0.12, Math.min(n.end - n.start, 6));
    end = Math.max(end, n.start + dur);

    // Velocity shapes both loudness (squared for a natural dynamic curve) and
    // brightness, like a real hammer hitting harder.
    const v = Math.max(0.05, Math.min(1, n.velocity ?? 0.7));
    const peak = 0.12 + 0.78 * v * v;

    const pick = pickSample(n.midi);
    if (!pick) {
      playSynthNote(ctx, master, n, start, dur, peak);
      continue;
    }

    const src = ctx.createBufferSource();
    src.buffer = pick.buf;
    src.playbackRate.value = pick.rate;

    // Velocity brightness: soft notes are filtered dark, hard notes stay open.
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = Math.min(13000, 1800 + 9000 * v);
    tone.Q.value = 0.5;

    // Natural piano envelope: a near-instant attack, hold while the sample's
    // own recorded decay rings, then a damper-style release when the note ends.
    const g = ctx.createGain();
    const release = 0.3;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.006);
    g.gain.setValueAtTime(peak, start + dur);
    g.gain.exponentialRampToValueAtTime(0.0008, start + dur + release);

    src.connect(tone).connect(g).connect(master);
    src.start(start);
    src.stop(start + dur + release + 0.1);
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
        comp.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}
