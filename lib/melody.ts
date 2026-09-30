// Melody processing: highest-note extraction (right hand), BPM estimation.
// Pure functions, no I/O.

import type { NoteEvent } from "./types";

/**
 * Extract the melody (right hand) from a polyphonic note list using the
 * highest-note heuristic: any note that is overlapped in time by a higher
 * note is assumed to belong to the accompaniment and is dropped.
 */
export function extractMelody(notes: NoteEvent[]): NoteEvent[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start || b.midi - a.midi);
  return sorted
    .filter((n, i) => {
      for (let j = 0; j < sorted.length; j++) {
        if (i === j) continue;
        const o = sorted[j];
        const overlaps = o.start < n.end && o.end > n.start;
        if (overlaps && Math.round(o.midi) > Math.round(n.midi)) return false;
      }
      return true;
    })
    .map((n) => ({ ...n, hand: "right" as const }));
}

/**
 * Estimate BPM from melody inter-onset intervals. Builds a histogram of
 * IOIs and assumes the most common one in a musical range is a beat.
 */
export function estimateBpm(melody: NoteEvent[]): number {
  const onsets = [...new Set(melody.map((n) => n.start))].sort((a, b) => a - b);
  if (onsets.length < 4) return 90;
  const bins = new Map<number, number[]>();
  for (let i = 1; i < onsets.length; i++) {
    const ioi = onsets[i] - onsets[i - 1];
    if (ioi < 0.2 || ioi > 1.5) continue; // outside plausible beat range
    const bin = Math.round(ioi / 0.05);
    const list = bins.get(bin) ?? [];
    list.push(ioi);
    bins.set(bin, list);
  }
  let bestBin = -1;
  let bestCount = 0;
  for (const [bin, list] of bins) {
    if (list.length > bestCount) {
      bestCount = list.length;
      bestBin = bin;
    }
  }
  if (bestBin < 0) return 90;
  // Refine: average the raw IOIs in the winning bin (bin centers quantize).
  const iois = bins.get(bestBin)!;
  let beat = iois.reduce((s, v) => s + v, 0) / iois.length;
  // If the winning IOI looks like an eighth note (fast), double it.
  if (beat < 0.33 && bestCount >= 3) beat *= 2;
  return Math.round(60 / beat);
}

/**
 * Snap note starts/ends to a grid (seconds). Useful to clean up
 * transcription jitter before chord assignment.
 */
export function quantizeNotes(notes: NoteEvent[], gridSec: number): NoteEvent[] {
  if (gridSec <= 0) return notes;
  const snap = (t: number) => Math.round(t / gridSec) * gridSec;
  return notes.map((n) => ({
    ...n,
    start: snap(n.start),
    end: Math.max(snap(n.end), snap(n.start) + gridSec / 2),
  }));
}
