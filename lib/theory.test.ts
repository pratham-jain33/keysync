import { describe, expect, it } from "vitest";
import { assignChords, chordName, detectKey, midiToName } from "./theory";
import type { NoteEvent } from "./types";

function scaleNotes(tonicMidi: number, minor = false): NoteEvent[] {
  const steps = minor
    ? [0, 2, 3, 5, 7, 8, 10, 12]
    : [0, 2, 4, 5, 7, 9, 11, 12];
  return steps.map((s, i) => ({
    start: i * 0.5,
    end: i * 0.5 + 0.45,
    midi: tonicMidi + s,
  }));
}

describe("midiToName", () => {
  it("names middle C", () => {
    expect(midiToName(60)).toBe("C4");
    expect(midiToName(69)).toBe("A4");
    expect(midiToName(61)).toBe("C#4");
  });
});

describe("detectKey", () => {
  it("detects C major from a C major scale", () => {
    const key = detectKey(scaleNotes(60));
    expect(key.tonic).toBe(0);
    expect(key.mode).toBe("major");
    expect(key.name).toBe("C major");
  });

  it("detects A minor from an A minor scale", () => {
    const key = detectKey(scaleNotes(57, true));
    expect(key.tonic).toBe(9);
    expect(key.mode).toBe("minor");
  });

  it("detects G major from a G major melody with F#", () => {
    const notes: NoteEvent[] = [
      { start: 0, end: 0.5, midi: 67 }, // G
      { start: 0.5, end: 1.0, midi: 66 }, // F#
      { start: 1.0, end: 1.5, midi: 67 },
      { start: 1.5, end: 2.0, midi: 74 }, // D
      { start: 2.0, end: 3.0, midi: 67 },
    ];
    const key = detectKey(notes);
    expect(key.name).toBe("G major");
  });

  it("weights long notes more than passing notes", () => {
    const notes: NoteEvent[] = [
      { start: 0, end: 4, midi: 60 }, // long C
      { start: 0, end: 0.1, midi: 66 }, // passing F#
    ];
    expect(detectKey(notes).tonic).toBe(0);
  });
});

describe("assignChords", () => {
  it("assigns C major to a C-major bar", () => {
    const melody = scaleNotes(60).slice(0, 4); // C D E F over 2s
    const key = detectKey(scaleNotes(60));
    const chords = assignChords(melody, key, 120); // 0.5s beat, 2s bar
    expect(chords.length).toBeGreaterThan(0);
    // Bar contains C D E F: C major (C E G) fits best
    expect(chords[0].name).toBe("C");
  });

  it("assigns one chord per bar across the melody span", () => {
    const melody: NoteEvent[] = [];
    for (let i = 0; i < 8; i++) {
      melody.push({ start: i * 0.5, end: i * 0.5 + 0.4, midi: 60 + [0, 4, 7, 4][i % 4] });
    }
    const key = { tonic: 0, mode: "major" as const, name: "C major" };
    const chords = assignChords(melody, key, 120);
    expect(chords.length).toBe(2); // 4s of melody, 2s bars
    expect(chords[0].start).toBe(0);
    expect(chords[1].start).toBe(2);
  });

  it("names chords correctly", () => {
    expect(chordName(0, { suffix: "", intervals: [0, 4, 7] })).toBe("C");
    expect(chordName(9, { suffix: "m", intervals: [0, 3, 7] })).toBe("Am");
    expect(chordName(7, { suffix: "7", intervals: [0, 4, 7, 10] })).toBe("G7");
  });

  it("returns empty for empty melody", () => {
    const key = { tonic: 0, mode: "major" as const, name: "C major" };
    expect(assignChords([], key, 120)).toEqual([]);
  });
});
