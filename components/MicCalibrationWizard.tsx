"use client";

import { useEffect, useRef, useState } from "react";
import { createPitchDetector } from "@/lib/pitch";
import type { FramePitchDetector } from "@/lib/pitch";
import { midiToName } from "@/lib/theory";
import {
  CALIBRATION_SCALE,
  DEFAULT_SILENCE_THRESHOLD,
  REJECT_CENTS,
  computeGate,
  computeOffset,
  describeOffset,
  saveCalibration,
  type CalibrationSample,
  type MicCalibration,
} from "@/lib/mic-calibration";

interface Props {
  onClose: () => void;
  onSaved: (c: MicCalibration) => void;
}

type Step = 1 | 2 | 3;

/** Stability frames: 3 consecutive frames on the same rounded MIDI note. */
const STABILITY_FRAMES = 3;

export default function MicCalibrationWizard({ onClose, onSaved }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [micError, setMicError] = useState(false);
  // Step 1
  const [noiseFloor, setNoiseFloor] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(2);
  // Step 2
  const [noteIndex, setNoteIndex] = useState(0);
  const [samples, setSamples] = useState<CalibrationSample[]>([]);
  const [rejectedMsg, setRejectedMsg] = useState("");

  const levelBarRef = useRef<HTMLDivElement | null>(null);
  const heardRef = useRef<HTMLSpanElement | null>(null);
  const resumeAttemptRef = useRef(0);
  const noteIndexRef = useRef(0);
  const samplesRef = useRef<CalibrationSample[]>([]);
  const detectorRef = useRef<FramePitchDetector | null>(null);
  const rigRef = useRef<{
    ctx: AudioContext;
    analyser: AnalyserNode;
    stream: MediaStream;
    buf: Float32Array<ArrayBuffer>;
  } | null>(null);
  const stateRef = useRef({
    step: 1 as Step,
    noiseSum: 0,
    noiseCount: 0,
    noiseDeadline: 0,
    hist: [] as number[],
    fracHist: [] as number[],
    expected: CALIBRATION_SCALE[0],
    noteRmsSum: 0,
    noteRmsCount: 0,
  });
  const noiseFloorRef = useRef<number | null>(null);

  // Final gate shown on the results step: noise-based, but never above 30%
  // of the player's actual played-note level (refs are final by step 3).
  const avgNoteRms = (() => {
    const s = stateRef.current;
    return s.noteRmsCount > 0 ? s.noteRmsSum / s.noteRmsCount : null;
  })();
  const gate = noiseFloor != null ? computeGate(noiseFloor, avgNoteRms) : null;

  const advanceNote = () => {
    const s = stateRef.current;
    s.hist = [];
    s.fracHist = [];
    setRejectedMsg("");
    if (noteIndexRef.current < CALIBRATION_SCALE.length - 1) {
      noteIndexRef.current++;
      s.expected = CALIBRATION_SCALE[noteIndexRef.current];
      setNoteIndex(noteIndexRef.current);
    } else {
      s.step = 3 as Step; // stop the scale tick; results render from state
      setStep(3);
    }
  };

  // Own mic rig, independent of the practice-page mic (which the parent
  // stops before opening the wizard).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const ctx = new AudioContext();
        await ctx.resume();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        src.connect(analyser);
        rigRef.current = {
          ctx,
          analyser,
          stream,
          buf: new Float32Array(analyser.fftSize),
        };
        const s = stateRef.current;
        s.noiseSum = 0;
        s.noiseCount = 0;
        s.noiseDeadline = performance.now() + 2000;
        setSecondsLeft(2);
      } catch {
        if (!cancelled) setMicError(true);
      }
    })();
    return () => {
      cancelled = true;
      const rig = rigRef.current;
      rigRef.current = null;
      detectorRef.current = null;
      rig?.stream.getTracks().forEach((t) => t.stop());
      rig?.ctx.close().catch(() => undefined);
    };
  }, []);

  // Shared 50ms tick drives whichever step is active.
  useEffect(() => {
    if (micError) return;
    const id = setInterval(() => {
      const rig = rigRef.current;
      if (!rig) return;
      // Insurance: if the AudioContext never resumed (mobile can leave it
      // suspended when created outside a direct gesture handler), retry
      // resume at most once per second until it runs.
      if (rig.ctx.state === "suspended") {
        const now = performance.now();
        if (now - resumeAttemptRef.current > 1000) {
          resumeAttemptRef.current = now;
          rig.ctx.resume().catch(() => undefined);
        }
      }
      rig.analyser.getFloatTimeDomainData(rig.buf);
      let sum = 0;
      for (let i = 0; i < rig.buf.length; i++) sum += rig.buf[i] * rig.buf[i];
      const rms = Math.sqrt(sum / rig.buf.length);

      const s = stateRef.current;
      if (levelBarRef.current) {
        levelBarRef.current.style.width = `${Math.round(
          Math.min(1, rms / 0.25) * 100
        )}%`;
      }

      if (s.step === 1) {
        s.noiseSum += rms;
        s.noiseCount++;
        const left = Math.max(0, s.noiseDeadline - performance.now());
        setSecondsLeft(Math.ceil(left / 1000));
        if (left <= 0 && s.noiseCount > 0) {
          const floor = s.noiseSum / s.noiseCount;
          noiseFloorRef.current = floor;
          setNoiseFloor(floor);
          s.hist = [];
          s.fracHist = [];
          s.noteRmsSum = 0;
          s.noteRmsCount = 0;
          s.step = 2;
          // Fixed lenient gate, identical to the practice page default.
          // The measured noise floor only informs the SAVED calibration
          // (via computeGate), never this detector: deriving the live gate
          // from floor*4 deafened phone mics and no note ever registered.
          detectorRef.current = createPitchDetector(rig.ctx.sampleRate, 2048, {
            minRms: DEFAULT_SILENCE_THRESHOLD,
          });
          setStep(2);
        }
        return;
      }

      if (s.step === 2) {
        const detector = detectorRef.current;
        if (!detector) return;
        const res = detector.detect(rig.buf);
        if (heardRef.current) {
          heardRef.current.textContent =
            res != null ? midiToName(Math.round(res.midi)) : "—";
        }
        if (!res) {
          s.hist = [];
          s.fracHist = [];
          return;
        }
        // Stability is checked on rounded MIDI (same as the practice page):
        // fractional pitch from a phone mic wobbles too much frame to frame
        // for a tight cents window. Fractional values are kept separately
        // for the accurate offset measurement.
        const rounded = Math.round(res.midi);
        s.hist.push(rounded);
        s.fracHist.push(res.midi);
        if (s.hist.length > STABILITY_FRAMES) s.hist.shift();
        if (s.fracHist.length > STABILITY_FRAMES) s.fracHist.shift();
        if (s.hist.length < STABILITY_FRAMES) return;
        const stable =
          s.hist[0] >= 0 &&
          s.hist[0] === s.hist[1] &&
          s.hist[1] === s.hist[2];
        if (!stable) return;
        const mean =
          s.fracHist.reduce((a, b) => a + b, 0) / s.fracHist.length;
        // Track played-note levels so the saved gate can be validated
        // against them (never gate above the player's actual notes).
        s.noteRmsSum += res.rms;
        s.noteRmsCount++;

        const expected = s.expected;
        const centsOff = (mean - expected) * 100;
        if (Math.abs(centsOff) > REJECT_CENTS) {
          s.hist = [];
          s.fracHist = [];
          setRejectedMsg(
            `That didn't sound like ${midiToName(expected)} — try again.`
          );
          return;
        }
        samplesRef.current = [
          ...samplesRef.current,
          { expected, detected: mean },
        ];
        setSamples(samplesRef.current);
        advanceNote();
      }
    }, 50);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micError]);

  const skipNote = () => advanceNote();

  const restartScale = () => {
    const s = stateRef.current;
    s.hist = [];
    s.fracHist = [];
    s.noteRmsSum = 0;
    s.noteRmsCount = 0;
    noteIndexRef.current = 0;
    s.expected = CALIBRATION_SCALE[0];
    samplesRef.current = [];
    setSamples([]);
    setNoteIndex(0);
    setRejectedMsg("");
  };

  const result = step === 3 ? computeOffset(samples) : null;

  const save = () => {
    if (gate == null || !result) return;
    const c: MicCalibration = {
      centsOffset: result.centsOffset,
      silenceThreshold: gate,
      sampledAt: Date.now(),
      notesSampled: result.kept,
    };
    saveCalibration(c);
    onSaved(c);
  };

  const expected = CALIBRATION_SCALE[noteIndex];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Calibrate microphone"
    >
      <div
        className="card w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="label-eyebrow">Step {step} of 3</p>
            <h3 className="mt-1 font-display text-xl font-semibold text-ink">
              {step === 1 && "Measure room noise"}
              {step === 2 && "Play the C major scale"}
              {step === 3 && "Calibration results"}
            </h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close calibration"
            className="rounded-lg p-2 text-ink-faint transition hover:bg-surface-2 hover:text-ink"
          >
            ✕
          </button>
        </div>

        {/* progress dots */}
        <div className="mt-3 flex gap-2" aria-hidden="true">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className={`h-1.5 flex-1 rounded-full ${
                n <= step ? "bg-accent" : "bg-surface-2"
              }`}
            />
          ))}
        </div>

        {micError ? (
          <p className="mt-6 text-sm text-danger">
            Couldn&apos;t access the microphone. Allow access in the browser
            bar and reopen calibration.
          </p>
        ) : (
          <>
            {step === 1 && (
              <div className="mt-6">
                <p className="text-sm text-ink-dim">
                  Stay quiet for {secondsLeft} second
                  {secondsLeft === 1 ? "" : "s"} … we&apos;re measuring your
                  room&apos;s noise floor.
                </p>
                <div
                  className="mt-4 h-2 overflow-hidden rounded-full bg-surface-2"
                  aria-hidden="true"
                >
                  <div
                    ref={levelBarRef}
                    className="h-full rounded-full bg-accent"
                    style={{ width: "0%" }}
                  />
                </div>
                <p className="mt-2 text-xs text-ink-faint">
                  The bar shows live mic level. Silence gives the cleanest
                  reading.
                </p>
              </div>
            )}

            {step === 2 && (
              <div className="mt-6">
                <p className="text-sm text-ink-dim">
                  Play each note once, holding it briefly. Now playing:
                </p>
                <p className="mt-3 text-center font-display text-4xl font-bold text-accent">
                  {midiToName(expected).replace(/-?\d+$/, "")}
                  <span className="text-xl text-ink-faint">
                    {midiToName(expected).match(/-?\d+$/)?.[0] ?? ""}
                  </span>
                </p>
                <p className="mt-2 text-center text-xs text-ink-faint">
                  Hearing: <span ref={heardRef} className="font-mono text-ink">—</span>
                  <span className="ml-2">(if this stays blank while you play, the mic isn&apos;t reaching the browser)</span>
                </p>
                {/* scale progress */}
                <div className="mt-4 flex justify-center gap-2">
                  {CALIBRATION_SCALE.map((m, i) => {
                    const done = samples.some((smp) => smp.expected === m);
                    return (
                      <div
                        key={m}
                        title={midiToName(m)}
                        className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold ${
                          done
                            ? "bg-accent text-accent-ink"
                            : i === noteIndex
                              ? "bg-accent/20 text-accent ring-1 ring-accent"
                              : "bg-surface-2 text-ink-faint"
                        }`}
                      >
                        {done ? "✓" : midiToName(m).replace(/-?\d+$/, "")}
                      </div>
                    );
                  })}
                </div>
                {rejectedMsg && (
                  <p className="mt-3 text-center text-sm text-danger">
                    {rejectedMsg}
                  </p>
                )}
                <div className="mt-6 flex gap-3">
                  <button onClick={skipNote} className="btn-outline h-11 flex-1">
                    Skip note
                  </button>
                  <button
                    onClick={restartScale}
                    className="btn-outline h-11 flex-1"
                  >
                    Restart
                  </button>
                </div>
              </div>
            )}

            {step === 3 && result && (
              <div className="mt-6">
                <dl className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-ink-dim">Pitch offset</dt>
                    <dd className="font-semibold text-ink">
                      {describeOffset(result.centsOffset)}
                      {Math.abs(Math.round(result.centsOffset)) >= 3 &&
                        ` — your piano reads ${
                          result.centsOffset > 0 ? "sharp" : "flat"
                        }, corrected`}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-dim">Notes sampled</dt>
                    <dd className="font-semibold text-ink">
                      {result.kept} of {CALIBRATION_SCALE.length}
                      {result.rejected > 0 &&
                        ` (${result.rejected} rejected)`}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-dim">Noise floor</dt>
                    <dd className="font-mono text-ink">
                      {(noiseFloor ?? 0).toFixed(4)} → gate{" "}
                      {(gate ?? 0).toFixed(4)}
                    </dd>
                  </div>
                </dl>
                {result.kept === 0 && (
                  <p className="mt-3 text-sm text-danger">
                    No usable samples — every note was rejected. Try again in
                    a quieter room.
                  </p>
                )}
                <div className="mt-6 flex gap-3">
                  <button onClick={onClose} className="btn-outline h-11 flex-1">
                    Discard
                  </button>
                  <button
                    onClick={save}
                    disabled={result.kept === 0}
                    className="btn-primary h-11 flex-1 disabled:opacity-60"
                  >
                    Save calibration
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
