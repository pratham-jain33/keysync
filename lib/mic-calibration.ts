// Mic calibration: measure the room's noise floor and the pitch offset of
// the player's piano+mic chain, then correct live detections with it.
// Pure logic + localStorage; no DOM. Calibration is per-device on purpose:
// it captures mic, piano tuning, and room acoustics together.

export interface MicCalibration {
  /** average (detected - expected) in cents; subtracted from live readings */
  centsOffset: number;
  /** silence-gate RMS threshold derived from the measured noise floor */
  silenceThreshold: number;
  /** epoch ms when the calibration was saved */
  sampledAt: number;
  /** how many scale notes were sampled */
  notesSampled: number;
}

export const CALIBRATION_LS_KEY = "keysync-mic-calibration";

/** Default silence-gate RMS used when no calibration exists. */
export const DEFAULT_SILENCE_THRESHOLD = 0.008;

const MIN_SILENCE_THRESHOLD = 0.004;
const MAX_SILENCE_THRESHOLD = 0.03;
/** Samples further than this from the expected note are rejected. */
export const REJECT_CENTS = 100;

export interface CalibrationSample {
  /** expected pitch, MIDI (integer, e.g. 60 for C4) */
  expected: number;
  /** detected pitch, fractional MIDI (before rounding) */
  detected: number;
}

export function loadCalibration(): MicCalibration | null {
  try {
    const raw = localStorage.getItem(CALIBRATION_LS_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<MicCalibration>;
    if (
      typeof c.centsOffset !== "number" ||
      !isFinite(c.centsOffset) ||
      typeof c.silenceThreshold !== "number" ||
      !isFinite(c.silenceThreshold)
    ) {
      return null;
    }
    return {
      centsOffset: c.centsOffset,
      silenceThreshold: Math.min(
        MAX_SILENCE_THRESHOLD,
        Math.max(MIN_SILENCE_THRESHOLD, c.silenceThreshold)
      ),
      sampledAt: typeof c.sampledAt === "number" ? c.sampledAt : 0,
      notesSampled: typeof c.notesSampled === "number" ? c.notesSampled : 0,
    };
  } catch {
    return null;
  }
}

export function saveCalibration(c: MicCalibration): void {
  try {
    localStorage.setItem(CALIBRATION_LS_KEY, JSON.stringify(c));
  } catch {
    /* storage full/blocked: calibration just won't persist */
  }
}

export function clearCalibration(): void {
  try {
    localStorage.removeItem(CALIBRATION_LS_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Noise floor (mean ambient RMS) -> silence-gate threshold.
 * 4x the floor, clamped to a sane band so a silent room doesn't gate
 * legitimate quiet playing and a noisy room doesn't deafen the mic.
 */
export function noiseFloorToThreshold(noiseFloorRms: number): number {
  const t = noiseFloorRms * 4;
  return Math.min(MAX_SILENCE_THRESHOLD, Math.max(MIN_SILENCE_THRESHOLD, t));
}

export interface OffsetResult {
  /** mean (detected - expected) in cents over kept samples */
  centsOffset: number;
  kept: number;
  rejected: number;
}

/**
 * Average pitch offset from calibration samples. Any sample more than
 * REJECT_CENTS from its expected note is rejected (wrong note played),
 * so one bad take can't skew the correction.
 */
export function computeOffset(samples: CalibrationSample[]): OffsetResult {
  let sum = 0;
  let kept = 0;
  let rejected = 0;
  for (const s of samples) {
    const cents = (s.detected - s.expected) * 100;
    if (!isFinite(cents) || Math.abs(cents) > REJECT_CENTS) {
      rejected++;
      continue;
    }
    sum += cents;
    kept++;
  }
  return {
    centsOffset: kept > 0 ? sum / kept : 0,
    kept,
    rejected,
  };
}

/** Apply a calibration to a raw fractional MIDI reading. */
export function applyCalibration(
  rawMidi: number,
  calibration: MicCalibration | null
): number {
  if (!calibration) return rawMidi;
  return rawMidi - calibration.centsOffset / 100;
}

/** "+8 cents", "-3 cents", "in tune" — human-readable offset summary. */
export function describeOffset(cents: number): string {
  const r = Math.round(cents);
  if (Math.abs(r) < 3) return "in tune";
  return `${r > 0 ? "+" : ""}${r} cents`;
}

/** The C major scale used by the wizard: C4..C5 as MIDI note numbers. */
export const CALIBRATION_SCALE: number[] = [60, 62, 64, 65, 67, 69, 71, 72];
