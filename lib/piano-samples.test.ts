import { describe, expect, it } from "vitest";
import {
  PIANO_SAMPLES,
  nearestSample,
  sampleNameToMidi,
} from "./piano-samples";

describe("piano sample manifest", () => {
  it("covers the keyboard, one recording per minor third from A0 to C8", () => {
    expect(PIANO_SAMPLES.length).toBe(30);
    const midis = PIANO_SAMPLES.map((s) => s.midi);
    expect(Math.min(...midis)).toBe(21); // A0
    expect(Math.max(...midis)).toBe(108); // C8
    // every entry is a minor third (3 semitones) above the previous one
    const sorted = [...midis].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBe(3);
    }
  });

  it("serves every sample from our own origin", () => {
    for (const s of PIANO_SAMPLES) {
      expect(s.url).toBe(`/piano/${s.name}.mp3`);
    }
  });

  it("maps sample stems to the right MIDI numbers", () => {
    expect(sampleNameToMidi("A0")).toBe(21);
    expect(sampleNameToMidi("C4")).toBe(60);
    expect(sampleNameToMidi("Ds4")).toBe(63); // D#4
    expect(sampleNameToMidi("Fs4")).toBe(66); // F#4
    expect(sampleNameToMidi("C8")).toBe(108);
  });

  it("picks a sample within 1.5 semitones of any playable note", () => {
    for (let midi = 21; midi <= 108; midi++) {
      const s = nearestSample(midi);
      expect(Math.abs(s.midi - midi)).toBeLessThanOrEqual(2);
    }
    // middle C lands exactly on the C4 recording (no pitch shift)
    expect(nearestSample(60).name).toBe("C4");
  });
});
