import { describe, expect, it } from "vitest";
import { starsForAccuracy, headlineFor, coachLine } from "./stars";

describe("starsForAccuracy", () => {
  it("awards 3 stars at 95+", () => {
    expect(starsForAccuracy(100)).toBe(3);
    expect(starsForAccuracy(95)).toBe(3);
  });
  it("awards 2 stars at 80–94", () => {
    expect(starsForAccuracy(94)).toBe(2);
    expect(starsForAccuracy(80)).toBe(2);
  });
  it("awards 1 star at 60–79", () => {
    expect(starsForAccuracy(79)).toBe(1);
    expect(starsForAccuracy(60)).toBe(1);
  });
  it("awards 0 stars below 60", () => {
    expect(starsForAccuracy(59)).toBe(0);
    expect(starsForAccuracy(0)).toBe(0);
  });
});

describe("headlineFor", () => {
  it("celebrates without ever scolding", () => {
    expect(headlineFor(3)).toMatch(/flawless/i);
    expect(headlineFor(0)).not.toMatch(/fail|bad|wrong/i);
  });
});

describe("coachLine", () => {
  it("gives a concrete next step for every outcome", () => {
    for (const s of [0, 1, 2, 3] as const) {
      const line = coachLine(s);
      expect(line.length).toBeGreaterThan(10);
    }
  });
  it("tells strugglers to slow down, not speed up", () => {
    expect(coachLine(0)).toMatch(/0\.25×/);
    expect(coachLine(1)).toMatch(/0\.5×/);
  });
});
