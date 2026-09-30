# KeySync

Learn piano from YouTube tutorials. Paste a tutorial link, mark the clean
sections, and KeySync transcribes the right-hand melody, detects the key and
chords, generates a left-hand part at three difficulties, and lets you practice
with falling notes and wait-mode microphone listening on your real piano.

Learn project for now, ship project later.

## How it works

1. Paste a YouTube piano tutorial URL. The video embeds so you can mark one or
   more clean sections (no sections = the whole video).
2. `POST /api/build` downloads the audio with `yt-dlp`, slices sections with
   `ffmpeg`, and transcribes with Spotify's
   [Basic Pitch](https://github.com/spotify/basic-pitch) via
   `scripts/transcribe.py`.
3. The TypeScript music engine (`lib/`) extracts the melody with a
   highest-note heuristic, estimates BPM, detects the key (Krumhansl-Schmuckler),
   and assigns one chord per bar.
4. The left hand is generated client-side, instantly, at three difficulties:
   easy = block chords, medium = broken chords (oom-pah), hard = Alberti
   bass / arpeggios.
5. On the practice page a dynamic Synthesia-style keyboard (its range follows
   the song) shows falling notes. Your laptop mic listens through
   `getUserMedia`; wait mode stops until you play the right note. Correct keys
   glow green, wrong keys flash red. Melody notes are strict; left-hand chords
   pass on the bass/root note.

## Requirements

- Node.js 18+ (developed with Node 24)
- Python 3.10 or 3.11 recommended for Basic Pitch (3.12 works with the
  `--no-deps` + `onnxruntime` install described below; the default TensorFlow
  backend is pinned to older numpy)
- `ffmpeg` on your PATH
- `yt-dlp` on your PATH

## Setup

```bash
# 1. Node dependencies
npm install

# 2. Python environment for transcription
python3 -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# 3. Basic Pitch. The default install pulls TensorFlow (~600 MB). If that
#    fails on your Python version, use the light ONNX backend instead:
pip install basic-pitch --no-deps
pip install onnxruntime librosa mir_eval pretty_midi resampy scipy soundfile sox typeguard

# 4. yt-dlp (also needed on PATH for the API route)
pip install yt-dlp   # or: brew install yt-dlp / winget install yt-dlp
```

If your venv Python is not `python3` (e.g. on Windows it is `python`, or you
want the API to use the venv explicitly), set:

```bash
export PYTHON_BIN=/path/to/.venv/bin/python   # Windows: set PYTHON_BIN=C:\path\to\.venv\Scripts\python.exe
```

## Run

```bash
npm run dev      # http://localhost:3000
npm run build    # production build
npm test         # vitest unit tests (36 tests, music engine + pitch detection)
```

Songs are stored as JSON in `data/songs/` (gitignored, local only).

## Project layout

```
app/                  Next.js 14 App Router pages and API routes
  page.tsx            Home: YouTube URL input, embedded player, section marking
  practice/[songId]/  Practice page: canvas keyboard, wait mode, mic, demo synth
  api/build/          Full pipeline: download -> slice -> transcribe -> analyze
  api/song/[id]/      Serve a built song
lib/                  Pure TypeScript music engine (unit tested)
  theory.ts           Note names, Krumhansl-Schmuckler key detection, chords
  melody.ts           Highest-note melody extraction, BPM estimation, quantization
  accompaniment.ts    Easy/medium/hard left-hand generation
  practice.ts         Wait-mode step engine and grading
  pitch.ts            pitchy YIN frame detector wrapper (mic input)
  synth.ts            Web Audio demo synth (no samples needed)
scripts/
  transcribe.py       basic-pitch wrapper: wav in, JSON notes out
data/songs/           Built songs (local, gitignored)
```

## Honest limitations

- Basic Pitch degrades with speech, noise, reverb, or dense polyphony. Mark
  sections where the piano plays cleanly.
- The highest-note heuristic fails when the melody is not the top voice.
- Laptop-mic pitch detection is monophonic and room-dependent; full chord
  recognition is deliberately not attempted.
- Downloading YouTube audio with `yt-dlp` may conflict with YouTube's terms;
  reconsider before any public release.
- Songs are stored locally; there is no auth, no database, no deployment
  story yet. The backend needs local Python + Basic Pitch + yt-dlp + ffmpeg,
  so it is not ready for serverless hosting.
