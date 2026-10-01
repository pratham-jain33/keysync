import { describe, expect, it } from "vitest";
import {
  estimateBpm,
  extractMelody,
  isTwoHanded,
  quantizeNotes,
  splitHands,
} from "./melody";
import type { NoteEvent } from "./types";

describe("extractMelody", () => {
  it("drops notes overlapped by a higher note", () => {
    const notes: NoteEvent[] = [
      { start: 0, end: 1, midi: 60 }, // melody
      { start: 0, end: 1, midi: 48 }, // bass, same time -> dropped
      { start: 1, end: 2, midi: 62 },
      { start: 1, end: 2, midi: 55 }, // lower -> dropped
    ];
    const melody = extractMelody(notes);
    expect(melody.map((n) => n.midi).sort()).toEqual([60, 62]);
  });

  it("keeps sequential notes and tags hand as right", () => {
    const notes: NoteEvent[] = [
      { start: 0, end: 0.5, midi: 60 },
      { start: 0.5, end: 1, midi: 64 },
      { start: 1, end: 1.5, midi: 67 },
    ];
    const melody = extractMelody(notes);
    expect(melody).toHaveLength(3);
    expect(melody.every((n) => n.hand === "right")).toBe(true);
  });

  it("keeps the highest of a chord played together", () => {
    const notes: NoteEvent[] = [
      { start: 0, end: 1, midi: 48 },
      { start: 0, end: 1, midi: 52 },
      { start: 0, end: 1, midi: 55 },
      { start: 0, end: 1, midi: 60 },
    ];
    const melody = extractMelody(notes);
    expect(melody).toHaveLength(1);
    expect(melody[0].midi).toBe(60);
  });
});

describe("estimateBpm", () => {
  it("estimates 120bpm from quarter notes at 0.5s", () => {
    const notes: NoteEvent[] = Array.from({ length: 8 }, (_, i) => ({
      start: i * 0.5,
      end: i * 0.5 + 0.4,
      midi: 60 + i,
    }));
    expect(estimateBpm(notes)).toBe(120);
  });

  it("estimates 90bpm from quarter notes at 2/3s", () => {
    const notes: NoteEvent[] = Array.from({ length: 8 }, (_, i) => ({
      start: i * (2 / 3),
      end: i * (2 / 3) + 0.5,
      midi: 60,
    }));
    expect(estimateBpm(notes)).toBe(90);
  });

  it("returns a sane default for tiny input", () => {
    expect(estimateBpm([{ start: 0, end: 1, midi: 60 }])).toBe(90);
  });
});

describe("quantizeNotes", () => {
  it("snaps starts and ends to the grid", () => {
    const notes: NoteEvent[] = [{ start: 0.13, end: 0.61, midi: 60 }];
    const q = quantizeNotes(notes, 0.25);
    expect(q[0].start).toBeCloseTo(0.25, 5);
    expect(q[0].end).toBeCloseTo(0.5, 5);
  });
});

describe("splitHands", () => {
  it("splits by pitch around middle C and tags hands", () => {
    const notes: NoteEvent[] = [
      { start: 0, end: 1, midi: 72 }, // right
      { start: 0, end: 1, midi: 60 }, // right (>= 60)
      { start: 0, end: 1, midi: 59 }, // left (< 60)
      { start: 0, end: 1, midi: 36 }, // left
    ];
    const { right, left } = splitHands(notes);
    expect(right.map((n) => n.midi).sort((a, b) => a - b)).toEqual([60, 72]);
    expect(left.map((n) => n.midi).sort((a, b) => a - b)).toEqual([36, 59]);
    expect(right.every((n) => n.hand === "right")).toBe(true);
    expect(left.every((n) => n.hand === "left")).toBe(true);
  });

  it("honors a custom split point", () => {
    const notes: NoteEvent[] = [
      { start: 0, end: 1, midi: 50 },
      { start: 0, end: 1, midi: 48 },
    ];
    const { right, left } = splitHands(notes, 49);
    expect(right.map((n) => n.midi)).toEqual([50]);
    expect(left.map((n) => n.midi)).toEqual([48]);
  });
});

describe("isTwoHanded", () => {
  it("is false for a single melodic line", () => {
    const notes: NoteEvent[] = Array.from({ length: 12 }, (_, i) => ({
      start: i * 0.5,
      end: i * 0.5 + 0.45,
      midi: 60 + (i % 5),
    }));
    expect(isTwoHanded(notes)).toBe(false);
  });

  it("is true when a bass sustains under a treble line", () => {
    const notes: NoteEvent[] = [];
    for (let bar = 0; bar < 4; bar++) {
      // sustained low chord
      notes.push({ start: bar, end: bar + 1, midi: 40 });
      notes.push({ start: bar, end: bar + 1, midi: 47 });
      // treble melody over it
      for (let b = 0; b < 4; b++) {
        notes.push({ start: bar + b * 0.25, end: bar + b * 0.25 + 0.2, midi: 72 + b });
      }
    }
    expect(isTwoHanded(notes)).toBe(true);
  });
});
