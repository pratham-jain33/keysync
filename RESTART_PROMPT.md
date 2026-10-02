Full restart of KeySync on the current branch (main). Read CLAUDE.md in the repo
root first for architecture, pipeline, and constraints.

GOAL: Rebuild the app from scratch with the new ML pipeline. The old pipeline
(Demucs 4-stem + Basic Pitch) is dead. New pipeline: htdemucs_6s piano stem →
Kong transcription service → MIDI cleanup.

DO THIS:

1. Scaffold a fresh Next.js (App Router, TypeScript) app in this repo, replacing
   the old code. Keep public/piano/ samples and lib/piano-samples.ts as-is
   (they work, don't rebuild).

2. Port from branch master (use `git show master:<path>` to read, don't checkout):
   - The practice engine: falling notes canvas, rAF + audio clock timing
   - Mic wait-mode: getUserMedia + pitch detection, wrong-note-stop behavior
   - The ebony/brass design system (tailwind.config.ts tokens, globals.css)
   - Brand.tsx, logo.svg, icon.svg

3. Build the new pipeline:
   - daytona/pipeline.py: FFmpeg normalize → htdemucs_6s → piano stem →
     POST to https://kongml-optimized.onrender.com/transcribe → MIDI cleanup
     (drop <30ms notes, dedupe, fix overlaps, normalize velocity) →
     notes.json + piano.mid
   - app/api/auto-build/route.ts: upload → create Daytona sandbox → run pipeline
     → stream progress via SSE → return notes
   - Keep the Running processes panel + Stop all kill switch pattern from master
     (app/api/auto-build/all/route.ts, registry in lib/)

4. NO Basic Pitch anywhere. Not in requirements, not in code, not in comments.

5. Verify: `npx tsc --noEmit` passes, `npm run build` succeeds.

6. Commit to branch main with message "Full restart: htdemucs_6s + Kong pipeline".

LOG PROGRESS: append one line to /home/hatch/workspace/piano-app/RESTART_LOG.md
every time you finish a numbered step above. Format: `- [HH:MM] Step N done: <one-line summary>`.

Work autonomously. Don't ask questions. If something is blocked, log it and move on.
