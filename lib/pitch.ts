// Monophonic pitch detection wrapper around the `pitchy` package (YIN).
// Runs on float time-domain data from an AnalyserNode.

import { PitchDetector } from "pitchy";

export interface PitchResult {
  hz: number;
  midi: number;
  clarity: number;
  /** RMS level of the analyzed frame (0..1). Useful for onset detection. */
  rms: number;
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export interface PitchDetectorOptions {
  /** minimum clarity (0..1) to accept a pitch */
  clarityThreshold?: number;
  /** minimum RMS level to accept a pitch (silence gate) */
  minRms?: number;
}

export interface FramePitchDetector {
  /** Feed one frame; returns a pitch or null when unsure/silent. */
  detect(frame: Float32Array<ArrayBufferLike>): PitchResult | null;
}

/**
 * Create a frame pitch detector. `sampleRate` is the audio sample rate,
 * `frameSize` should be a power of two (2048 works well for piano).
 */
export function createPitchDetector(
  sampleRate: number,
  frameSize = 2048,
  opts: PitchDetectorOptions = {}
): FramePitchDetector {
  // Gates are deliberately lenient: phone mics and distant pianos (with the
  // browser's auto-gain disabled for pitch stability) can be quiet, and a
  // strict gate reads as "mic hears nothing" to the user. The UI shows a
  // live level meter so a genuinely dead input is diagnosable.
  const clarityThreshold = opts.clarityThreshold ?? 0.8;
  const minRms = opts.minRms ?? 0.008;
  const detector = PitchDetector.forFloat32Array(frameSize);

  return {
    detect(frame: Float32Array<ArrayBufferLike>): PitchResult | null {
      if (frame.length !== frameSize) return null;
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      if (rms < minRms) return null;
      const [hz, clarity] = detector.findPitch(frame, sampleRate);
      if (!isFinite(hz) || hz <= 0) return null;
      if (clarity < clarityThreshold) return null;
      return { hz, midi: hzToMidi(hz), clarity, rms };
    },
  };
}
