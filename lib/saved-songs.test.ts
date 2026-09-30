import { describe, expect, it } from "vitest";
import {
  buildMeta,
  isLocalId,
  makeLocalId,
  stripLocalId,
} from "./saved-songs";
import type { SongData } from "./types";

const SONG: SongData = {
  songId: "abc123def4567890",
  title: "Test Song",
  melody: [
    { start: 0, end: 0.5, midi: 60 },
    { start: 0.5, end: 1, midi: 62 },
  ],
  chords: [],
  key: { tonic: 0, mode: "major", name: "C major" },
  bpm: 90,
  duration: 60,
};

describe("local id helpers", () => {
  it("round-trips through the local prefix", () => {
    const local = makeLocalId(SONG.songId);
    expect(isLocalId(local)).toBe(true);
    expect(isLocalId(SONG.songId)).toBe(false);
    expect(stripLocalId(local)).toBe(SONG.songId);
  });

  it("leaves non-local ids alone", () => {
    expect(stripLocalId("abc")).toBe("abc");
  });
});

describe("buildMeta", () => {
  it("derives listing metadata from the song", () => {
    const meta = buildMeta(SONG, "https://www.youtube.com/watch?v=x", 1234);
    expect(meta.id).toBe(makeLocalId(SONG.songId));
    expect(meta.title).toBe("Test Song");
    expect(meta.noteCount).toBe(2);
    expect(meta.duration).toBe(60);
    expect(meta.createdAt).toBe(1234);
  });
});
