// Parse Standard MIDI files into KeySync note events.
// Used by the sheet-music path: MuseScore downloads and direct MIDI uploads.
import { Midi } from "@tonejs/midi";
import type { NoteEvent } from "@/lib/types";

// General MIDI reserves channel 10 (zero-based index 9) for percussion: its
// "note numbers" select drum sounds (36 = kick, 38 = snare, 42 = hi-hat, ...),
// not pitches. Those numbers fall inside the piano range, so merging them in
// turns a drum kit into garbage piano notes — and because cymbals (49/51/57)
// sit above a low melody, they even hijack the highest-note melody extraction.
// A piano practice track has no use for the drum part, so drop that channel.
const GM_DRUM_CHANNEL = 9;

/**
 * Convert a MIDI file buffer into note events with absolute second
 * timestamps. Pitched tracks are merged (hand splitting / melody extraction
 * happens later); the General MIDI drum channel is excluded. Tempo changes
 * inside the file are honored by @tonejs/midi.
 */
export function parseMidiToNotes(buf: Buffer): NoteEvent[] {
  // Copy into a fresh ArrayBuffer so @tonejs/midi gets a clean slice
  // (Buffer#buffer may be a pooled SharedArrayBuffer).
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const midi = new Midi(copy);
  const notes: NoteEvent[] = [];
  for (const track of midi.tracks) {
    if (track.channel === GM_DRUM_CHANNEL) continue; // skip percussion
    for (const n of track.notes) {
      if (n.midi < 21 || n.midi > 108) continue; // outside piano range
      const start = Math.max(0, n.time);
      const end = Math.max(start + 0.05, n.time + n.duration);
      notes.push({
        start,
        end,
        midi: n.midi,
        velocity: Math.min(1, Math.max(0.05, n.velocity)),
      });
    }
  }
  notes.sort((a, b) => a.start - b.start);
  return notes;
}

/** Quick sanity check that a buffer looks like a MIDI file. */
export function looksLikeMidi(buf: Buffer): boolean {
  return buf.length > 14 && buf.toString("ascii", 0, 4) === "MThd";
}
