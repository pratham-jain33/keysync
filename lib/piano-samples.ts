// Shared manifest for the Salamander Grand Piano multisample set.
//
// These are public-domain recordings from Alexander Holm's Salamander Grand
// Piano (the standard free sampled grand), one recording every minor third
// from A0 to C8. We serve them from our own origin (`public/piano/`) rather
// than a third-party CDN so playback is reliable in production with no CORS
// or availability surprises. `scripts/check-samples.mjs` verifies every URL
// in this manifest resolves at build time.

export interface SampleRef {
  /** file stem, e.g. "Ds4" (D#4) — black keys use the sharp-with-"s" form */
  name: string;
  /** MIDI note number of the recorded pitch */
  midi: number;
  /** app-origin URL the sampler fetches */
  url: string;
}

/** Where the self-hosted samples live (served from `public/piano/`). */
export const PIANO_SAMPLE_BASE = "/piano/";

// One recording per minor third across the keyboard. Full coverage keeps every
// played note within ~1.5 semitones of a real recording, so pitch-shifting
// never stretches a sample far enough to sound synthetic.
const SAMPLE_NAMES = [
  "A0",
  "C1", "Ds1", "Fs1", "A1",
  "C2", "Ds2", "Fs2", "A2",
  "C3", "Ds3", "Fs3", "A3",
  "C4", "Ds4", "Fs4", "A4",
  "C5", "Ds5", "Fs5", "A5",
  "C6", "Ds6", "Fs6", "A6",
  "C7", "Ds7", "Fs7", "A7",
  "C8",
] as const;

const PC_TO_SEMITONE: Record<string, number> = { C: 0, Ds: 3, Fs: 6, A: 9 };

/** MIDI number for a sample stem like "Ds4" or "A0". */
export function sampleNameToMidi(name: string): number {
  const m = /^([A-Za-z]+)(-?\d+)$/.exec(name);
  if (!m) return 60;
  const pc = PC_TO_SEMITONE[m[1]] ?? 0;
  return (parseInt(m[2], 10) + 1) * 12 + pc;
}

export const PIANO_SAMPLES: SampleRef[] = SAMPLE_NAMES.map((name) => ({
  name,
  midi: sampleNameToMidi(name),
  url: `${PIANO_SAMPLE_BASE}${name}.mp3`,
}));

/** The sample whose recorded pitch is closest to `midi` (least pitch shift). */
export function nearestSample(midi: number): SampleRef {
  let best = PIANO_SAMPLES[0];
  let bestDist = Infinity;
  for (const s of PIANO_SAMPLES) {
    const d = Math.abs(s.midi - midi);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}
