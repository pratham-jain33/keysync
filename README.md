# KeySync

Learn piano from any song. Paste a YouTube link or upload an audio file and
KeySync isolates the piano, transcribes it to playable MIDI, detects the key and
chords, generates a left-hand part at three difficulties, and lets you practice
with Synthesia-style falling notes and wait-mode microphone listening on your
real piano.

Learn project for now, ship project later.

## How it works

1. Give KeySync a mixed song (YouTube link or audio upload), or a clean piano
   tutorial with marked sections.
2. Heavy compute runs off the web box. For a mixed song, a Daytona sandbox
   normalizes the audio, isolates the piano stem with `htdemucs_6s` (6-stem
   Demucs), and sends that stem to the Kong high-resolution piano transcription
   service. The MIDI is cleaned up (short notes dropped, duplicates and overlaps
   fixed, velocity normalized) and returned as notes.
3. The TypeScript music engine (`lib/`) extracts the melody with a highest-note
   heuristic, estimates BPM, detects the key (Krumhansl-Schmuckler), and assigns
   one chord per bar.
4. The left hand is generated client-side, instantly, at three difficulties:
   easy = block chords, medium = broken chords (oom-pah), hard = Alberti
   bass / arpeggios.
5. On the practice page a dynamic Synthesia-style keyboard (its range follows
   the song) shows falling notes. Your laptop mic listens through
   `getUserMedia`; wait mode stops until you play the right note. Correct keys
   glow green, wrong keys flash red. Melody notes are strict; left-hand chords
   pass on the bass/root note.

## Architecture

Browser (Next.js) -> Render API (512MB) -> Daytona sandbox (ephemeral) ->
results. The sandbox does the heavy compute only: download/normalize audio,
isolate the piano, transcribe via Kong, clean up MIDI, return results, destroy
itself. Everything after the notes exist runs in the browser.

Transcription is a separate service (`transcribe-service/`, Kong ONNX model) so
its ML stack gets dedicated RAM instead of competing with Next.js. The automatic
pipeline posts to the hosted Kong endpoint; set `KONG_TRANSCRIBE_URL` to point
elsewhere.

## Requirements

- Node.js 18+ (developed with Node 24)
- `ffmpeg` on your PATH
- `yt-dlp` on your PATH (for the YouTube paths)

No local Python transcription stack is needed: transcription is an HTTP service.

## Setup

```bash
npm install
```

Point the app at a transcription service:

```bash
export TRANSCRIBE_SERVICE_URL=https://your-kong-service   # section-marking paths
export KONG_TRANSCRIBE_URL=https://kongml-optimized.onrender.com/transcribe  # auto pipeline
```

Automatic (mixed-song) builds also need `DAYTONA_API_KEY` set so the API can
create sandboxes.

## Run

```bash
npm run dev      # http://localhost:3000
npm run build    # production build
npm test         # vitest unit tests (music engine + pitch detection)
```

Songs are stored as JSON in `data/songs/` (gitignored, local only).

## Deploy (free hosting)

The repo ships a `Dockerfile` and a `render.yaml` blueprint for Render's free
tier. The web app needs Node + yt-dlp + ffmpeg; transcription runs as its own
Render service (`transcribe-service/`), and mixed-song isolation runs in Daytona
sandboxes.

Notes:

- Free services sleep after 15 minutes of inactivity; the first visit after
  that takes about a minute to wake up. The app warms the transcription service
  via `/health` at build start to overlap the cold start.
- There is no persistent disk on the free plan: built songs survive restarts
  but are wiped on redeploy. Rebuild a song from its source if it disappears.

## Project layout

```
app/                  Next.js App Router pages and API routes
  page.tsx            Home: link/upload input, section marking, automatic mode
  practice/[songId]/  Practice page: canvas keyboard, wait mode, mic, demo synth
  api/build/          Section-marking pipeline: slice -> transcribe -> analyze
  api/auto-build/     Automatic pipeline via Daytona (isolate -> Kong -> analyze)
  api/song/[id]/      Serve a built song
lib/                  Pure TypeScript music engine (unit tested)
  theory.ts           Note names, Krumhansl-Schmuckler key detection, chords
  melody.ts           Highest-note melody extraction, BPM estimation, quantization
  accompaniment.ts    Easy/medium/hard left-hand generation
  practice.ts         Wait-mode step engine and grading
  pitch.ts            pitchy YIN frame detector wrapper (mic input)
  synth.ts            Web Audio demo synth (no samples needed)
daytona/              Sandbox pipeline: normalize -> htdemucs_6s -> Kong -> MIDI
transcribe-service/   Kong ONNX transcription microservice
data/songs/           Built songs (local, gitignored)
```

## Honest limitations

- Transcription quality depends on the source: speech, heavy noise, reverb, or
  very dense polyphony still degrade the result. A cleaner recording helps.
- The highest-note heuristic fails when the melody is not the top voice.
- Laptop-mic pitch detection is monophonic and room-dependent; full chord
  recognition is deliberately not attempted.
- Downloading YouTube audio with `yt-dlp` may conflict with YouTube's terms;
  reconsider before any public release.
- Songs are stored locally; there is no auth and no database. On a free tier
  there is no persistent disk, so built songs are wiped on redeploy.
