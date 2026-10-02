# KeySync — full restart (branch: main)

Piano practice web app. Upload any song, get playable piano MIDI, practice with
Synthesia-style falling notes and mic wait-mode.

## Architecture

Browser (Next.js) → Render API (512MB) → Daytona sandbox (ephemeral) → results.
Daytona does heavy compute only: download song, isolate piano, transcribe, cleanup
MIDI, upload results, destroy sandbox. Everything after MIDI exists runs in browser.

## Pipeline (Daytona)

1. FFmpeg: normalize upload to 44.1kHz stereo WAV
2. Piano isolation: `htdemucs_6s` (6-stem Demucs, dedicated piano stem)
3. Transcription: Kong high-resolution piano model via
   https://kongml-optimized.onrender.com/transcribe (POST audio, get notes)
4. MIDI cleanup: drop notes <30ms, dedupe, fix overlaps, velocity normalize
5. Output: notes.json + piano.mid → Render

NEVER use Basic Pitch. Owner removed it: misses too many notes on real songs.

## Frontend

- Next.js App Router, TypeScript
- Design tokens: ebony bg, ivory text, brass (#e6b45c) accent, steel (#79a9d6) cool.
  Semantic Tailwind colors in tailwind.config.ts. Never raw hex, never neon.
- Piano sound: self-hosted Salamander Grand samples in public/piano/ (30 mp3s,
  manifest in lib/piano-samples.ts). No external CDN.
- Practice engine: falling notes on canvas (rAF + audio clock, never CSS-animated),
  mic wait-mode via getUserMedia + YIN pitch detection. Wrong note stops, correct
  key glows, wrong key red.
- UI copy: plain direct language. No emojis unless required. No em dashes.

## Constraints

- Zero money. No paid services, GPUs, subscriptions.
- Daytona sandbox: 2 CPU, 8GB RAM, 10GB disk. Keep per-chunk work serial.
- Render free tier sleeps after 15min idle; keep API stateless.
- Never commit secrets. Never expose DAYTONA_API_KEY or any token.

## Reference

Branch master has the previous working version. Port don't reinvent: the practice
engine, piano samples manifest, and mic wait-mode logic are proven. The pipeline
(Demucs 4-stem + Basic Pitch) is what we're replacing.
