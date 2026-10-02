import { describe, expect, it } from "vitest";
import { buildSteps, createPracticeEngine, MicNoteTracker } from "./practice";
import type { NoteEvent } from "./types";

const melody: NoteEvent[] = [
  { start: 0, end: 0.5, midi: 60, hand: "right" },
  { start: 0.5, end: 1.0, midi: 62, hand: "right" },
  { start: 1.0, end: 1.5, midi: 64, hand: "right" },
];

describe("buildSteps", () => {
  it("creates one step per sequential note", () => {
    const steps = buildSteps(melody);
    expect(steps).toHaveLength(3);
    expect(steps[0].midis).toEqual([60]);
    expect(steps[0].isChord).toBe(false);
  });

  it("groups simultaneous notes into a chord step", () => {
    const notes: NoteEvent[] = [
      { start: 0, end: 1, midi: 48, hand: "left" },
      { start: 0.01, end: 1, midi: 52, hand: "left" },
      { start: 0.02, end: 1, midi: 55, hand: "left" },
      { start: 1, end: 1.5, midi: 60, hand: "right" },
    ];
    const steps = buildSteps(notes);
    expect(steps).toHaveLength(2);
    expect(steps[0].isChord).toBe(true);
    expect(steps[0].midis).toEqual([48, 52, 55]);
    expect(steps[0].bass).toBe(48);
  });
});

describe("createPracticeEngine", () => {
  it("advances on the correct note", () => {
    const engine = createPracticeEngine(buildSteps(melody));
    expect(engine.current()?.midis).toEqual([60]);
    const r = engine.play(60);
    expect(r.status).toBe("correct");
    expect(engine.index).toBe(1);
    expect(engine.current()?.midis).toEqual([62]);
  });

  it("blocks on a wrong note and reports it", () => {
    const engine = createPracticeEngine(buildSteps(melody));
    const r = engine.play(61);
    expect(r.status).toBe("wrong");
    if (r.status === "wrong") {
      expect(r.played).toBe(61);
      expect(r.expected).toEqual([60]);
    }
    expect(engine.index).toBe(0); // still waiting
  });

  it("passes chords when the bass note is played", () => {
    const notes: NoteEvent[] = [
      { start: 0, end: 1, midi: 48, hand: "left" },
      { start: 0.01, end: 1, midi: 52, hand: "left" },
      { start: 0.02, end: 1, midi: 55, hand: "left" },
    ];
    const engine = createPracticeEngine(buildSteps(notes));
    const r = engine.play(48); // just the root
    expect(r.status).toBe("correct");
  });

  it("rejects a non-bass chord tone as wrong", () => {
    const notes: NoteEvent[] = [
      { start: 0, end: 1, midi: 48, hand: "left" },
      { start: 0.01, end: 1, midi: 52, hand: "left" },
    ];
    const engine = createPracticeEngine(buildSteps(notes));
    const r = engine.play(52);
    expect(r.status).toBe("wrong");
  });

  it("reports done after the last note", () => {
    const engine = createPracticeEngine(buildSteps(melody));
    engine.play(60);
    engine.play(62);
    const r = engine.play(64);
    expect(r.status).toBe("correct");
    if (r.status === "correct") expect(r.done).toBe(true);
    expect(engine.done).toBe(true);
    expect(engine.play(60).status).toBe("complete");
  });

  it("resets back to the start", () => {
    const engine = createPracticeEngine(buildSteps(melody));
    engine.play(60);
    engine.reset();
    expect(engine.index).toBe(0);
    expect(engine.current()?.midis).toEqual([60]);
  });
});

describe("MicNoteTracker", () => {
  it("feeds the first stable note after enough identical frames", () => {
    const t = new MicNoteTracker();
    expect(t.feed(60, 0.1)).toBeNull();
    expect(t.feed(60, 0.1)).toBeNull();
    expect(t.feed(60, 0.1)).toBe(60);
  });

  it("suppresses a sustained note so it is fed exactly once", () => {
    const t = new MicNoteTracker();
    t.feed(60, 0.3);
    t.feed(60, 0.3);
    expect(t.feed(60, 0.3)).toBe(60);
    // sustain with decaying level: no re-feed
    expect(t.feed(60, 0.25)).toBeNull();
    expect(t.feed(60, 0.2)).toBeNull();
    expect(t.feed(60, 0.15)).toBeNull();
  });

  it("re-feeds a repeated pitch on a fresh attack (rms onset)", () => {
    const t = new MicNoteTracker();
    t.feed(60, 0.3);
    t.feed(60, 0.3);
    expect(t.feed(60, 0.3)).toBe(60);
    expect(t.feed(60, 0.2)).toBeNull(); // decaying sustain
    expect(t.feed(60, 0.15)).toBeNull();
    // re-articulation: 0.4 > 1.6 * 0.15 -> new onset, feeds again
    expect(t.feed(60, 0.4)).toBe(60);
  });

  it("re-arms after silence so a repeated note counts", () => {
    const t = new MicNoteTracker();
    t.feed(60, 0.3);
    t.feed(60, 0.3);
    t.feed(60, 0.3);
    expect(t.feed(null, 0)).toBeNull(); // silence re-arms
    t.feed(60, 0.2);
    t.feed(60, 0.2);
    expect(t.feed(60, 0.2)).toBe(60);
  });

  it("feeds a different pitch as soon as it is stable", () => {
    const t = new MicNoteTracker();
    t.feed(60, 0.3);
    t.feed(60, 0.3);
    t.feed(60, 0.3);
    expect(t.feed(62, 0.3)).toBeNull(); // transition frames
    expect(t.feed(62, 0.3)).toBeNull();
    expect(t.feed(62, 0.3)).toBe(62);
  });

  it("never feeds a wobbling (unstable) pitch", () => {
    const t = new MicNoteTracker();
    for (let i = 0; i < 12; i++) {
      expect(t.feed(i % 2 === 0 ? 60 : 61, 0.2)).toBeNull();
    }
  });

  it("reset() clears fed state", () => {
    const t = new MicNoteTracker();
    t.feed(60, 0.3);
    t.feed(60, 0.3);
    t.feed(60, 0.3);
    t.reset();
    t.feed(60, 0.2);
    t.feed(60, 0.2);
    expect(t.feed(60, 0.2)).toBe(60);
  });
});

describe("buildSteps both-hands grading (regression)", () => {
  it("keeps simultaneous left and right notes as separate steps", () => {
    const notes: NoteEvent[] = [
      { start: 0, end: 0.5, midi: 67, hand: "right" }, // melody G4
      { start: 0.01, end: 1, midi: 36, hand: "left" }, // bass C2
      { start: 0.02, end: 1, midi: 48, hand: "left" }, // chord tone
    ];
    const steps = buildSteps(notes);
    expect(steps).toHaveLength(2);
    const left = steps.find((s) => s.hand === "left")!;
    const right = steps.find((s) => s.hand === "right")!;
    expect(left.isChord).toBe(true);
    expect(right.isChord).toBe(false);
    expect(right.midis).toEqual([67]);
  });

  it("melody stays strict: bass alone does not pass a both-hands moment", () => {
    const notes: NoteEvent[] = [
      { start: 0, end: 0.5, midi: 67, hand: "right" },
      { start: 0.01, end: 1, midi: 36, hand: "left" },
      { start: 0.02, end: 1, midi: 48, hand: "left" },
    ];
    const engine = createPracticeEngine(buildSteps(notes));
    // right step comes first (time 0): playing the bass is wrong here,
    // the strict melody note is required
    expect(engine.play(36).status).toBe("wrong");
    expect(engine.play(67).status).toBe("correct");
    // left step: passes on the bass note (lenient, monophonic mic)
    expect(engine.play(36).status).toBe("correct");
    expect(engine.done).toBe(true);
  });
});
