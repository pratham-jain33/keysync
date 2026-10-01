import { describe, expect, it } from "vitest";
import { Midi } from "@tonejs/midi";
import { parseMidiToNotes, looksLikeMidi } from "./midi";

function makeScaleMidi(): Buffer {
  const midi = new Midi();
  const track = midi.addTrack();
  const scale = [60, 62, 64, 65, 67, 69, 71, 72];
  scale.forEach((m, i) =>
    track.addNote({ midi: m, time: i * 0.5, duration: 0.45, velocity: 0.8 })
  );
  const arr = midi.toArray();
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

describe("midi", () => {
  it("detects a MIDI header", () => {
    expect(looksLikeMidi(makeScaleMidi())).toBe(true);
    expect(looksLikeMidi(Buffer.from("not a midi file"))).toBe(false);
  });

  it("parses notes with absolute second timestamps", () => {
    const notes = parseMidiToNotes(makeScaleMidi());
    expect(notes).toHaveLength(8);
    expect(notes[0]).toMatchObject({ midi: 60, start: 0 });
    expect(notes[7].midi).toBe(72);
    expect(notes[7].start).toBeCloseTo(3.5, 2);
    for (const n of notes) {
      expect(n.end).toBeGreaterThan(n.start);
      expect(n.velocity).toBeGreaterThan(0);
      expect(n.velocity).toBeLessThanOrEqual(1);
    }
    // sorted by start
    for (let i = 1; i < notes.length; i++) {
      expect(notes[i].start).toBeGreaterThanOrEqual(notes[i - 1].start);
    }
  });

  it("drops notes outside piano range", () => {
    const midi = new Midi();
    const track = midi.addTrack();
    track.addNote({ midi: 10, time: 0, duration: 0.5, velocity: 0.8 });
    track.addNote({ midi: 60, time: 1, duration: 0.5, velocity: 0.8 });
    const arr = midi.toArray();
    const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    const notes = parseMidiToNotes(buf);
    expect(notes).toHaveLength(1);
    expect(notes[0].midi).toBe(60);
  });

  it("excludes the General MIDI drum channel (10 / index 9)", () => {
    const midi = new Midi();
    const piano = midi.addTrack();
    piano.channel = 0;
    [60, 64, 67].forEach((m, i) =>
      piano.addNote({ midi: m, time: i * 0.5, duration: 0.4, velocity: 0.8 })
    );
    const drums = midi.addTrack();
    drums.channel = 9; // GM percussion
    // kick/snare/hi-hat/crash — all inside piano range, must not leak through
    [36, 38, 42, 49].forEach((m, i) =>
      drums.addNote({ midi: m, time: i * 0.25, duration: 0.2, velocity: 1 })
    );
    const arr = midi.toArray();
    const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    const notes = parseMidiToNotes(buf);
    expect(notes.map((n) => n.midi).sort((a, b) => a - b)).toEqual([60, 64, 67]);
  });
});
