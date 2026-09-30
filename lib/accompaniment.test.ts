import { describe, expect, it } from "vitest";
import { generateLeftHand } from "./accompaniment";
import type { ChordEvent } from "./types";

const C: ChordEvent = { start: 0, end: 2, root: 0, name: "C", tones: [0, 4, 7] };
const G: ChordEvent = { start: 2, end: 4, root: 7, name: "G", tones: [7, 11, 2] };

describe("generateLeftHand", () => {
  it("easy: plays block chords, one per bar", () => {
    const lh = generateLeftHand([C], "easy");
    // bass + 3 chord tones
    expect(lh).toHaveLength(4);
    const starts = new Set(lh.map((n) => n.start));
    expect(starts.size).toBe(1); // all together
    expect(lh.every((n) => n.hand === "left")).toBe(true);
    // bass is root in octave 2
    expect(lh.map((n) => n.midi % 12)).toContain(0);
    expect(Math.min(...lh.map((n) => n.midi))).toBe(36);
  });

  it("medium: plays oom-pah across the bar", () => {
    const lh = generateLeftHand([C], "medium");
    // beats 1,3 = bass; beats 2,4 = 3-note chord stab => 2 + 6 = 8 notes
    expect(lh).toHaveLength(8);
    const bassHits = lh.filter((n) => n.midi === 36);
    expect(bassHits.map((n) => n.start)).toEqual([0, 1]);
    const stabs = lh.filter((n) => n.midi !== 36);
    expect(stabs).toHaveLength(6);
  });

  it("hard: plays Alberti bass in eighth notes", () => {
    const lh = generateLeftHand([C], "hard");
    // 4 beats * 2 eighths = 8 notes per bar
    expect(lh).toHaveLength(8);
    const times = lh.map((n) => n.start);
    expect(times[1] - times[0]).toBeCloseTo(0.25, 5); // eighth at 120bpm-ish (2s bar)
    // pattern: bass, fifth, third, fifth
    const seq = lh.map((n) => n.midi);
    expect(seq[0]).toBe(36); // bass C2
    expect(seq[0]).toBe(seq[4]); // pattern repeats
  });

  it("keeps the left hand in a low octave", () => {
    const lh = generateLeftHand([C, G], "medium");
    expect(Math.max(...lh.map((n) => n.midi))).toBeLessThanOrEqual(67);
    expect(Math.min(...lh.map((n) => n.midi))).toBeGreaterThanOrEqual(31);
  });

  it("voice-leads smoothly between chords", () => {
    const lh = generateLeftHand([C, G], "easy");
    const cTones = lh.filter((n) => n.start === 0 && n.midi !== 36).map((n) => n.midi);
    const gTones = lh.filter((n) => n.start === 2 && n.midi !== 43).map((n) => n.midi);
    const cCenter = cTones.reduce((s, t) => s + t, 0) / cTones.length;
    const gCenter = gTones.reduce((s, t) => s + t, 0) / gTones.length;
    // G chord should voice near the C chord, not jump an octave
    expect(Math.abs(gCenter - cCenter)).toBeLessThan(12);
  });

  it("returns notes sorted by start time", () => {
    const lh = generateLeftHand([C, G], "hard");
    for (let i = 1; i < lh.length; i++) {
      expect(lh[i].start).toBeGreaterThanOrEqual(lh[i - 1].start);
    }
  });
});
