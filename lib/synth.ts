// Small Web Audio synth for the "Play demo" button. No external samples;
// a triangle wave plus a quiet octave harmonic with a piano-ish decay.

import { midiToHz } from "./pitch";
import type { NoteEvent } from "./types";

export interface DemoHandle {
  /** seconds elapsed since demo start */
  elapsed(): number;
  stop(): void;
  readonly duration: number;
}

/**
 * Play notes through a fresh master gain. Returns a handle to track
 * the playhead and stop early. The AudioContext is owned by the caller.
 */
export function playDemo(
  ctx: AudioContext,
  notes: NoteEvent[]
): DemoHandle {
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  const t0 = ctx.currentTime + 0.1;
  let end = 0;

  for (const n of notes) {
    const start = t0 + n.start;
    const dur = Math.max(0.12, Math.min(n.end - n.start, 2.0));
    end = Math.max(end, n.start + dur);
    const vel = 0.32 * (n.velocity ?? 0.8);

    // Fundamental: triangle.
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

    // Quiet octave-up harmonic for body.
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
