// Wait-mode practice engine: advances through the song only when the
// player plays the correct notes. Pure logic, no I/O, no DOM.

import type { NoteEvent } from "./types";

export interface PracticeStep {
  /** seconds from song start */
  time: number;
  /** MIDI notes expected at this step */
  midis: number[];
  /** lowest midi; chords pass when the bass/root is played (lenient) */
  bass: number;
  /** true when more than one note is expected */
  isChord: boolean;
  hand: "left" | "right";
}

export type PlayResult =
  | { status: "correct"; stepIndex: number; done: boolean }
  | { status: "wrong"; stepIndex: number; expected: number[]; played: number }
  | { status: "complete" }
  | { status: "idle" };

/** Notes starting within this window (seconds) form one chord step. */
export const CHORD_WINDOW = 0.06;

/**
 * Turn a note list into ordered practice steps. Simultaneous notes become a
 * single chord step; chords pass when the bass (lowest) note is played.
 */
export function buildSteps(notes: NoteEvent[]): PracticeStep[] {
  const byHand = new Map<"left" | "right", NoteEvent[]>();
  for (const n of notes) {
    const hand = n.hand ?? "right";
    const list = byHand.get(hand);
    if (list) list.push(n);
    else byHand.set(hand, [n]);
  }
  const steps: PracticeStep[] = [];
  // Left hand first so a both-hands moment starts from the bass foundation.
  for (const hand of ["left", "right"] as const) {
    const list = byHand.get(hand);
    if (!list) continue;
    const sorted = [...list].sort((a, b) => a.start - b.start);
    let last: PracticeStep | null = null;
    for (const n of sorted) {
      const midi = Math.round(n.midi);
      if (last && Math.abs(n.start - last.time) <= CHORD_WINDOW) {
        if (!last.midis.includes(midi)) {
          last.midis.push(midi);
          last.midis.sort((a, b) => a - b);
          last.bass = Math.min(last.bass, midi);
          last.isChord = last.midis.length > 1;
        }
      } else {
        last = { time: n.start, midis: [midi], bass: midi, isChord: false, hand };
        steps.push(last);
      }
    }
  }
  steps.sort((a, b) => a.time - b.time);
  return steps;
}

export interface PracticeEngine {
  readonly steps: PracticeStep[];
  readonly index: number;
  readonly done: boolean;
  current(): PracticeStep | null;
  /** Feed a played MIDI note. Returns what happened. */
  play(midi: number): PlayResult;
  reset(): void;
}

/**
 * Create a wait-mode engine. Single notes require the exact pitch;
 * chords pass when the bass (lowest) note is played, because full
 * polyphonic recognition through a laptop mic is unreliable.
 */
export function createPracticeEngine(steps: PracticeStep[]): PracticeEngine {
  let index = 0;

  return {
    steps,
    get index() {
      return index;
    },
    get done() {
      return index >= steps.length;
    },
    current() {
      return index < steps.length ? steps[index] : null;
    },
    play(midi: number): PlayResult {
      if (index >= steps.length) return { status: "complete" };
      const step = steps[index];
      const played = Math.round(midi);
      const ok = step.isChord ? played === step.bass : step.midis.includes(played);
      if (ok) {
        index++;
        const done = index >= steps.length;
        return { status: "correct", stepIndex: index - 1, done };
      }
      return { status: "wrong", stepIndex: index, expected: step.midis, played };
    },
    reset() {
      index = 0;
    },
  };
}
