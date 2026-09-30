// Left-hand accompaniment generation from a chord progression.
// Runs client-side so difficulty switching is instant (no re-transcription).
// Pure functions, no I/O.

import type { ChordEvent, Difficulty, NoteEvent } from "./types";

export interface AccompanimentOptions {
  beatsPerBar?: number;
  bpm?: number;
}

/**
 * Pick a voicing for a chord: bass note (root, low octave) plus the chord
 * tones an octave up. `prevTop` nudges the voicing toward the previous
 * chord for smoother voice leading.
 */
function voiceChord(
  chord: ChordEvent,
  prevTop: number | null
): { bass: number; tones: number[] } {
  // Bass: root in octave 2 (MIDI 36-47).
  const bass = 36 + chord.root;
  // Chord tones around octave 3-4, near the previous voicing when possible.
  const base = prevTop == null ? 55 : prevTop;
  const pcs = chord.tones; // includes root at index 0
  // Build candidate tones in a two-octave window and pick the voicing
  // whose average distance to prevTop is smallest.
  let bestTones: number[] = [];
  let bestDist = Infinity;
  for (let oct = 3; oct <= 4; oct++) {
    const tones = pcs.map((pc) => oct * 12 + pc);
    const center = tones.reduce((s, t) => s + t, 0) / tones.length;
    const dist = Math.abs(center - base);
    if (dist < bestDist) {
      bestDist = dist;
      bestTones = tones;
    }
  }
  return { bass, tones: bestTones };
}

function note(
  start: number,
  end: number,
  midi: number,
  velocity = 0.8
): NoteEvent {
  return { start, end, midi, velocity, hand: "left" };
}

/**
 * Generate a left-hand part for a chord progression.
 *
 * easy:   block chords, one per bar (all tones together).
 * medium: oom-pah, bass on beats 1 and 3, chord tones on beats 2 and 4.
 * hard:   Alberti bass, eighth-note pattern root-fifth-third-fifth.
 */
export function generateLeftHand(
  chords: ChordEvent[],
  difficulty: Difficulty,
  opts: AccompanimentOptions = {}
): NoteEvent[] {
  const beatsPerBar = opts.beatsPerBar ?? 4;
  const out: NoteEvent[] = [];
  let prevTop: number | null = null;

  for (const chord of chords) {
    const { bass, tones } = voiceChord(chord, prevTop);
    prevTop = tones.reduce((s, t) => s + t, 0) / tones.length;
    const barLen = chord.end - chord.start;
    const beatLen = barLen / beatsPerBar;

    if (difficulty === "easy") {
      // One block chord per bar.
      for (const t of tones) {
        out.push(note(chord.start, chord.end - 0.05, t, 0.7));
      }
      out.push(note(chord.start, chord.start + beatLen * 1.5, bass, 0.85));
    } else if (difficulty === "medium") {
      // Oom-pah: bass on 1 and 3, chord stab on 2 and 4.
      for (let b = 0; b < beatsPerBar; b++) {
        const t0 = chord.start + b * beatLen;
        if (b % 2 === 0) {
          out.push(note(t0, t0 + beatLen * 0.9, bass, 0.85));
        } else {
          for (const t of tones) {
            out.push(note(t0, t0 + beatLen * 0.8, t, 0.65));
          }
        }
      }
    } else {
      // Alberti bass: bass - fifth - third - fifth in eighth notes.
      const third = tones[1] ?? tones[0];
      const fifth = tones[2] ?? tones[0];
      const eighth = beatLen / 2;
      const steps = beatsPerBar * 2;
      const seq = [bass, fifth, third, fifth];
      for (let s = 0; s < steps; s++) {
        const t0 = chord.start + s * eighth;
        out.push(note(t0, t0 + eighth * 0.9, seq[s % seq.length], 0.7));
      }
    }
  }

  return out.sort((a, b) => a.start - b.start);
}
