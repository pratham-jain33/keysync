import { describe, it, expect, afterAll } from "vitest";
import { Midi } from "@tonejs/midi";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { parseMidiToNotes } from "@/lib/midi";
import { buildSongFromMidi } from "@/lib/build-song";

const written: string[] = [];
afterAll(async () => {
  for (const id of written)
    await fs.rm(join(resolve(process.cwd(), "data", "songs", `${id}.json`)), { force: true });
});

function twoHandMidi(): Buffer {
  const midi = new Midi();
  const rh = midi.addTrack(); rh.channel = 0;
  const lh = midi.addTrack(); lh.channel = 1;
  const dr = midi.addTrack(); dr.channel = 9;
  for (let bar = 0; bar < 8; bar++) {
    // RH melody (treble)
    [72, 74, 76, 77].forEach((m, b) =>
      rh.addNote({ midi: m, time: bar + b * 0.25, duration: 0.22, velocity: 0.8 }));
    // LH bass + chord (sustained)
    lh.addNote({ midi: 40, time: bar, duration: 0.95, velocity: 0.7 });
    lh.addNote({ midi: 47, time: bar, duration: 0.95, velocity: 0.6 });
    // drums - should be filtered
    for (let i = 0; i < 4; i++) dr.addNote({ midi: 42, time: bar + i * 0.25, duration: 0.1, velocity: 0.9 });
    dr.addNote({ midi: 49, time: bar, duration: 0.3, velocity: 1 });
  }
  const arr = midi.toArray();
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

describe("MIDI integration", () => {
  it("builds a song with all notes, no hand distinction", async () => {
    const notes = parseMidiToNotes(twoHandMidi());
    expect(notes.some((n) => [42, 49].includes(n.midi))).toBe(false); // drums gone
    const song = await buildSongFromMidi(notes, "Test");
    written.push(song.songId);
    expect(song.melody.length).toBeGreaterThan(0);
    // All notes kept, no hand split
    expect(song.left).toBeUndefined();
    expect(song.melody.length).toBe(notes.length);
  });

  it("single-line MIDI keeps all notes (no song.left)", async () => {
    const midi = new Midi();
    const t = midi.addTrack(); t.channel = 0;
    [60,62,64,65,67,69,71,72,71,69,67,65].forEach((m,i)=>t.addNote({midi:m,time:i*0.5,duration:0.45,velocity:0.8}));
    const arr = midi.toArray();
    const notes = parseMidiToNotes(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    const song = await buildSongFromMidi(notes, "Mono");
    written.push(song.songId);
    expect(song.left).toBeUndefined();
    expect(song.melody.length).toBeGreaterThan(0);
  });
});
