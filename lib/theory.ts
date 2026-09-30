// Music theory utilities: key detection (Krumhansl-Scholar) and
// chord assignment from a melody. Pure functions, no I/O.

import type { ChordEvent, KeyInfo, NoteEvent } from "./types";

export const NOTE_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

/** MIDI number -> note name, e.g. 60 -> "C4". */
export function midiToName(midi: number): string {
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  const octave = Math.floor(Math.round(midi) / 12) - 1;
  return `${NOTE_NAMES[pc]}${octave}`;
}

// Krumhansl-Scholar key profiles (probe-tone ratings).
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/**
 * Detect the key from note events. Notes are weighted by duration so
 * long melody notes count more than passing notes.
 */
export function detectKey(notes: NoteEvent[]): KeyInfo {
  const hist = new Array<number>(12).fill(0);
  for (const n of notes) {
    const pc = ((Math.round(n.midi) % 12) + 12) % 12;
    hist[pc] += Math.max(0.05, n.end - n.start);
  }

  let best: { tonic: number; mode: "major" | "minor"; score: number } = {
    tonic: 0,
    mode: "major",
    score: -Infinity,
  };
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ["major", "minor"] as const) {
      const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
      const rotated = Array.from(
        { length: 12 },
        (_, i) => profile[(i - tonic + 12) % 12]
      );
      const score = pearson(hist, rotated);
      if (score > best.score) best = { tonic, mode, score };
    }
  }
  return {
    tonic: best.tonic,
    mode: best.mode,
    name: `${NOTE_NAMES[best.tonic]} ${best.mode}`,
  };
}

export interface ChordTemplate {
  suffix: string;
  intervals: number[];
}

/**
 * Candidate chords for accompaniment. Deliberately limited to triads plus
 * the dominant 7th: a beginner practice app should suggest simple,
 * playable chords, and this keeps 7th-chord tone-count from gaming the
 * fit score on stepwise melodies.
 */
export const CHORD_TEMPLATES: ChordTemplate[] = [
  { suffix: "", intervals: [0, 4, 7] },
  { suffix: "m", intervals: [0, 3, 7] },
  { suffix: "dim", intervals: [0, 3, 6] },
  { suffix: "7", intervals: [0, 4, 7, 10] },
];

export function chordName(rootPc: number, template: ChordTemplate): string {
  return `${NOTE_NAMES[((rootPc % 12) + 12) % 12]}${template.suffix}`;
}

/** Pitch classes of the diatonic scale for a key (for tie-breaking). */
function diatonicPcs(key: KeyInfo): Set<number> {
  const steps = key.mode === "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  return new Set(steps.map((s) => (key.tonic + s) % 12));
}

/**
 * Assign one chord per bar of the melody. Each bar's pitch-class
 * histogram is scored against every chord template; chord tones add
 * weight, non-chord tones subtract. Ties prefer diatonic roots.
 */
export function assignChords(
  melody: NoteEvent[],
  key: KeyInfo,
  bpm: number,
  beatsPerBar = 4
): ChordEvent[] {
  if (melody.length === 0 || bpm <= 0) return [];
  const beat = 60 / bpm;
  const barLen = beat * beatsPerBar;
  const songEnd = Math.max(...melody.map((n) => n.end));
  const barCount = Math.max(1, Math.ceil(songEnd / barLen));
  const diatonic = diatonicPcs(key);

  const chords: ChordEvent[] = [];
  for (let b = 0; b < barCount; b++) {
    const start = b * barLen;
    const end = start + barLen;
    const hist = new Array<number>(12).fill(0);
    for (const n of melody) {
      const overlap = Math.min(n.end, end) - Math.max(n.start, start);
      if (overlap > 0) {
        const pc = ((Math.round(n.midi) % 12) + 12) % 12;
        hist[pc] += overlap;
      }
    }

    let best: { root: number; template: ChordTemplate; score: number } | null =
      null;
    for (let root = 0; root < 12; root++) {
      for (const template of CHORD_TEMPLATES) {
        const tones = new Set(
          template.intervals.map((iv) => (root + iv) % 12)
        );
        let score = 0;
        for (let pc = 0; pc < 12; pc++) {
          score += hist[pc] * (tones.has(pc) ? 2 : -1);
        }
        // Small bonus for diatonic roots and for the tonic.
        if (diatonic.has(root)) score += 0.5;
        if (root === key.tonic) score += 0.25;
        if (
          !best ||
          score > best.score + 1e-9 ||
          (Math.abs(score - best.score) < 1e-9 &&
            template.intervals.length < best.template.intervals.length)
        ) {
          best = { root, template, score };
        }
      }
    }
    if (!best) continue;
    chords.push({
      start,
      end,
      root: best.root,
      name: chordName(best.root, best.template),
      tones: best.template.intervals.map((iv) => (best!.root + iv) % 12),
    });
  }
  return chords;
}
