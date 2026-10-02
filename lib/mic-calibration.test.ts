import { describe, expect, it } from "vitest";
import {
  applyCalibration,
  computeGate,
  computeOffset,
  describeOffset,
  noiseFloorToThreshold,
  type MicCalibration,
} from "./mic-calibration";

describe("computeOffset", () => {
  it("averages per-sample offsets in cents", () => {
    // detected 10 cents sharp on C4, 20 cents sharp on D4
    const r = computeOffset([
      { expected: 60, detected: 60.1 },
      { expected: 62, detected: 62.2 },
    ]);
    expect(r.kept).toBe(2);
    expect(r.rejected).toBe(0);
    expect(r.centsOffset).toBeCloseTo(15, 6);
  });

  it("rejects samples more than 100 cents off", () => {
    const r = computeOffset([
      { expected: 60, detected: 60.05 },
      { expected: 62, detected: 64.5 }, // wrong note played
    ]);
    expect(r.kept).toBe(1);
    expect(r.rejected).toBe(1);
    expect(r.centsOffset).toBeCloseTo(5, 6);
  });

  it("rejects beyond the boundary and keeps just inside", () => {
    const r = computeOffset([
      { expected: 60, detected: 61.01 }, // 101 cents -> rejected
      { expected: 62, detected: 62.999 }, // 99.9 cents -> kept
    ]);
    expect(r.kept).toBe(1);
    expect(r.rejected).toBe(1);
  });

  it("returns zero offset when every sample is rejected", () => {
    const r = computeOffset([{ expected: 60, detected: 70 }]);
    expect(r.kept).toBe(0);
    expect(r.centsOffset).toBe(0);
  });

  it("handles negative (flat) offsets", () => {
    const r = computeOffset([{ expected: 60, detected: 59.92 }]);
    expect(r.centsOffset).toBeCloseTo(-8, 6);
  });
});

describe("noiseFloorToThreshold", () => {
  it("uses 2x the noise floor", () => {
    expect(noiseFloorToThreshold(0.004)).toBeCloseTo(0.008, 6);
  });

  it("clamps to the minimum", () => {
    expect(noiseFloorToThreshold(0.0001)).toBe(0.004);
  });

  it("clamps to the maximum instead of deafening the mic", () => {
    // The old 4x/0.03 formula saturated on phone mics and gated out real notes.
    expect(noiseFloorToThreshold(0.02)).toBe(0.016);
  });
});

describe("computeGate", () => {
  it("falls back to the noise-based threshold without note data", () => {
    expect(computeGate(0.004, null)).toBeCloseTo(0.008, 6);
  });

  it("never exceeds 30% of the player's actual note level", () => {
    // Noisy room (floor 0.008 -> 0.016) but quiet playing (avg 0.02 RMS):
    // gate must stay under the notes.
    expect(computeGate(0.008, 0.02)).toBeCloseTo(0.006, 6);
  });

  it("ignores note data that would raise the gate", () => {
    expect(computeGate(0.002, 0.5)).toBeCloseTo(0.004, 6);
  });

  it("clamps the final gate to the sane band", () => {
    expect(computeGate(0.00001, 0.00001)).toBe(0.004);
  });
});

describe("applyCalibration", () => {
  const cal: MicCalibration = {
    centsOffset: 8,
    silenceThreshold: 0.01,
    sampledAt: 0,
    notesSampled: 8,
  };

  it("subtracts the offset before rounding", () => {
    // 8 cents sharp piano reads 60.08; corrected -> 60.0 -> rounds to 60
    expect(applyCalibration(60.08, cal)).toBeCloseTo(60.0, 6);
  });

  it("returns the raw value when no calibration exists", () => {
    expect(applyCalibration(60.08, null)).toBe(60.08);
  });
});

describe("describeOffset", () => {
  it("says in tune near zero", () => {
    expect(describeOffset(2)).toBe("in tune");
    expect(describeOffset(-2.4)).toBe("in tune");
  });

  it("signs sharp and flat offsets", () => {
    expect(describeOffset(8.4)).toBe("+8 cents");
    expect(describeOffset(-12.6)).toBe("-13 cents");
  });
});
