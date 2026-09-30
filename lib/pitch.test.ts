import { describe, expect, it } from "vitest";
import { createPitchDetector, hzToMidi, midiToHz } from "./pitch";

function sineBuffer(freq: number, sampleRate: number, size: number): Float32Array {
  const buf = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    buf[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return buf;
}

describe("hzToMidi / midiToHz", () => {
  it("converts A440 to MIDI 69 and back", () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 5);
    expect(midiToHz(69)).toBeCloseTo(440, 5);
    expect(hzToMidi(261.63)).toBeCloseTo(60, 2); // middle C
  });
});

describe("createPitchDetector", () => {
  const SR = 48000;
  const SIZE = 2048;

  it("detects A440 within a semitone", () => {
    const det = createPitchDetector(SR, SIZE);
    const r = det.detect(sineBuffer(440, SR, SIZE));
    expect(r).not.toBeNull();
    expect(Math.abs(r!.midi - 69)).toBeLessThan(0.5);
  });

  it("detects middle C (261.63 Hz)", () => {
    const det = createPitchDetector(SR, SIZE);
    const r = det.detect(sineBuffer(261.63, SR, SIZE));
    expect(r).not.toBeNull();
    expect(Math.abs(r!.midi - 60)).toBeLessThan(0.5);
  });

  it("detects a low piano note (C2, 65.41 Hz)", () => {
    const det = createPitchDetector(SR, SIZE);
    const r = det.detect(sineBuffer(65.41, SR, SIZE));
    expect(r).not.toBeNull();
    expect(Math.abs(r!.midi - 36)).toBeLessThan(1);
  });

  it("returns null for silence", () => {
    const det = createPitchDetector(SR, SIZE);
    expect(det.detect(new Float32Array(SIZE))).toBeNull();
  });

  it("returns null for near-silence", () => {
    const det = createPitchDetector(SR, SIZE);
    const buf = sineBuffer(440, SR, SIZE).map((v) => v * 0.001);
    expect(det.detect(buf)).toBeNull();
  });
});
