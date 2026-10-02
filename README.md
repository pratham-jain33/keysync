# KeySync

Learn piano from any song. Paste a YouTube tutorial link or upload an audio
file, and KeySync transcribes every note into Synthesia-style falling notes.
Practice on your real piano in wait mode: the built-in mic listens and the song
only moves on when you play the right note.

Learn project for now, ship project later.

## How it works

1. Give KeySync a piano tutorial (YouTube link) or an audio file. Optionally
   mark the sections where the playing happens so intros and talking are
   skipped.
2. Heavy compute runs off the web box. A Daytona sandbox normalizes the audio,
   isolates the piano stem with `htdemucs_6s` (6-stem Demucs), and sends that
   stem to the Kong high-resolution piano transcription service. The MIDI is
   cleaned up (short notes dropped, duplicates and overlaps fixed, velocity
   normalized) and returned as notes.
3. The TypeScript music engine (`lib/`) keeps every transcribed note,
   estimates BPM, and detects the key (Krumhansl-Schmuckler). There is no
   melody extraction and no hand splitting: what you hear is what you practice.
4. On the practice page a dynamic Synthesia-style keyboard (its range follows
   the song) shows the falling notes in one amber voice. Your laptop mic
   listens through `getUserMedia`; wait mode stops until you play the right
   note. Correct keys glow and burst; wrong keys flash red. Chords pass on the
   bass (lowest) note.
5. Songs save to your browser automatically, or to the cloud with a free
   account (Supabase), so they survive redeploys.

## Practice features

- **Falling notes** with note-name labels (C, D, E…) — toggleable for
  beginners.
- **Hit effects** — a burst of particles when a mic note lands correctly
  (disable it in Display, respects reduced-motion).
- **Tempo slider** — slow the demo down to 0.25x while learning a hard passage.
- **A/B loop** — mark a section and loop it in wait mode or during the demo
  until it is clean.
- **Count-in metronome** — 0, 1 or 2 bars before the demo starts.
- **Post-run report** — note accuracy %, mistake count, notes played and time
  after every completed run.
- **Per-song mastery bars** on the home library, plus a daily practice streak.
- **Keyboard shortcuts** — Space plays/pauses the demo.
- **High-contrast note mode** and ≥44px touch targets throughout.

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

Cloud saves need a Supabase project: create the `songs` table with RLS on
`auth.uid() = user_id`, then set `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY`.

## Run

```bash
npm run dev      # http://localhost:3000
npm run build    # production build
npm test         # vitest unit tests (music engine + pitch detection)
npx tsc --noEmit # typecheck
```

Local songs are stored in the browser (IndexedDB); cloud songs in Supabase when
signed in.

## Deploy (free hosting)

The repo ships a `Dockerfile` and a `render.yaml` blueprint for Render's free
tier. The web app needs Node + yt-dlp + ffmpeg; transcription runs as its own
Render service (`transcribe-service/`), and mixed-song isolation runs in Daytona
sandboxes.

Notes:

- Free services sleep after 15 minutes of inactivity; the first visit after
  that takes about a minute to wake up. The app warms the transcription service
  via `/health` at build start to overlap the cold start.
- There is no persistent disk on the free plan: the build registry is
  in-memory and per-process, so unsigned-in songs live in the browser. Cloud
  songs (signed in) survive redeploys.

## Project layout

```
app/                  Next.js App Router pages and API routes
  page.tsx            Home: link/upload input, section marking, library
  practice/[songId]/  Practice page: canvas keyboard, wait mode, mic, demo synth
  api/build/          Section-marking pipeline: slice -> transcribe -> analyze
  api/auto-build/     Automatic pipeline via Daytona (isolate -> Kong -> analyze)
  api/song/[id]/      Serve a built song
components/           Brand, Auth, Onboarding (first-visit flow)
lib/                  Pure TypeScript music engine (unit tested)
  theory.ts           Note names, Krumhansl-Schmuckler key detection, chords
  melody.ts           BPM estimation and quantization
  practice.ts         Wait-mode step engine and grading
  pitch.ts            pitchy YIN frame detector wrapper (mic input)
  synth.ts            Web Audio demo synth (self-hosted Salamander samples)
daytona/              Sandbox pipeline: normalize -> htdemucs_6s -> Kong -> MIDI
transcribe-service/   Kong ONNX transcription microservice
```

## Design

Dark ebony surfaces, brass (`#e6b45c`) accents, steel (`#79a9d6`) secondary —
no neon. Design tokens live in `tailwind.config.ts` and reusable classes in
`app/globals.css`. The practice canvas is drawn with `requestAnimationFrame`
on the audio clock; CSS never animates it.

## Honest limitations

- Transcription quality depends on the source: speech, heavy noise, reverb, or
  very dense polyphony still degrade the result. A cleaner recording helps.
- Laptop-mic pitch detection is monophonic and room-dependent; full chord
  recognition is deliberately not attempted.
- Downloading YouTube audio with `yt-dlp` may conflict with YouTube's terms;
  reconsider before any public release.
- Audio uploads are sent to the transcription pipeline; mic audio during
  practice never leaves your machine.
