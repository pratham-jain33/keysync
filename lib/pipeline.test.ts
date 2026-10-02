// End-to-end test of the analysis half of POST /api/build:
// transcribed notes -> melody -> bpm -> key -> chords.
// The note list below is a representative Kong transcription of a
// synthetic C-D-E-F-G quarter-note melody (verified 2026-09-30).

import { describe, expect, it } from "vitest";
import { extractMelody, estimateBpm } from "./melody";
import { detectKey, assignChords } from "./theory";
import type { NoteEvent } from "./types";

const transcribed: NoteEvent[] = [
  { start: 0.012, end: 0.43, midi: 60, velocity: 0.758 },
  { start: 0.488, end: 0.94, midi: 62, velocity: 0.741 },
  { start: 0.987, end: 1.451, midi: 64, velocity: 0.727 },
  { start: 1.486, end: 1.962, midi: 65, velocity: 0.737 },
  { start: 1.987, end: 2.463, midi: 67, velocity: 0.743 },
];

describe("build analysis pipeline", () => {
  it("extracts the melody, detects C major, and assigns chords", () => {
    const melody = extractMelody(transcribed);
    expect(melody.map((n) => Math.round(n.midi))).toEqual([60, 62, 64, 65, 67]);
    expect(melody.every((n) => n.hand === "right")).toBe(true);

    const bpm = estimateBpm(melody);
    expect(bpm).toBeGreaterThan(90);
    expect(bpm).toBeLessThan(160);

    const key = detectKey(melody);
    expect(key.name).toBe("C major");

    const chords = assignChords(melody, key, bpm);
    expect(chords.length).toBeGreaterThan(0);
    // first chord should be C (root pc 0) for a C-D-E-F-G line in C major
    expect(chords[0].root).toBe(0);
    expect(chords[0].tones[0]).toBe(0); // root first
  });
});
