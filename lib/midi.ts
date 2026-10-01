// Parse Standard MIDI files into KeySync note events.
// Used by the sheet-music path: MuseScore downloads and direct MIDI uploads.
import { Midi } from "@tonejs/midi";
import type { NoteEvent } from "@/lib/types";

/**
 * Convert a MIDI file buffer into note events with absolute second
 * timestamps. All tracks are merged (melody extraction later picks the
 * top voice). Tempo changes inside the file are honored by @tonejs/midi.
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
