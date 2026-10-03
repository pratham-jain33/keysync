# KeySync
Learn piano from any song with automatic transcription and interactive practice.

## Motivation
Many piano learners want to practice real songs but lack sheet music or a way to play along at their own pace. KeySync lets users provide a YouTube tutorial or an audio file, automatically transcribes it to MIDI, and offers a Synthesia‑style falling‑note interface with a wait‑mode that pauses until the correct note is played via the laptop microphone.

## Tech stack
- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- Supabase (optional cloud storage)
- ffmpeg‑static and yt‑dlp for audio extraction
- @tonejs/midi for MIDI handling
- pitchy for real‑time pitch detection
- @supabase/supabase-js for authentication and storage

## Features
- Automatic transcription of YouTube or uploaded audio to MIDI
- Synthesia‑style falling notes with optional note‑name labels
- Wait mode that pauses playback until the correct note is played via the laptop microphone
- Tempo slider, A/B looping, metronome count‑in, and post‑run accuracy report
- Cloud sync with Supabase and local IndexedDB fallback
- Keyboard shortcuts and high‑contrast UI for accessibility

## Installation
```bash
# Prerequisites
# - Node.js 18+ (the repo was developed with Node 24)
# - ffmpeg on your PATH
# - yt-dlp on your PATH

npm install
```

## Usage
```bash
# Development server
npm run dev   # http://localhost:3000

# Production build
npm run build

# Start the built app
npm start

# Run unit tests
npm test

# Type‑check only
npx tsc --noEmit
```

## Tests
The repository includes Vitest unit tests for the music engine and pitch detection. Run them with `npm test`.

---
*Created with [repo-doctor](https://prathamjain.com/projects/repo-doctor)*
