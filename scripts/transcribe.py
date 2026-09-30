#!/usr/bin/env python3
"""Transcribe a wav file to piano notes using Spotify's basic-pitch.

Usage: transcribe.py <audio.wav>

Prints a JSON array to stdout:
  [{"start": 0.12, "end": 0.45, "midi": 60, "velocity": 0.8}, ...]

Exit codes: 0 ok, 2 bad usage, 3 basic-pitch missing, 4 transcription failed.
"""

import contextlib
import io
import json
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: transcribe.py <audio.wav>"}))
        return 2
    path = sys.argv[1]

    try:
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import predict
    except ImportError as e:
        print(
            json.dumps({"error": f"basic-pitch is not installed: {e}"}),
            file=sys.stderr,
        )
        return 3

    try:
        # basic-pitch prints "Predicting MIDI for ..." to stdout; swallow it so
        # our stdout stays pure JSON for the API route to parse.
        with contextlib.redirect_stdout(io.StringIO()):
            _model_output, _midi_data, note_events = predict(
                path, ICASSP_2022_MODEL_PATH
            )
    except Exception as e:  # noqa: BLE001 - surface any model failure
        print(json.dumps({"error": f"transcription failed: {e}"}), file=sys.stderr)
        return 4

    notes = []
    for ev in note_events:
        # note_events rows: (start_s, end_s, pitch_midi, amplitude 0-1, ...)
        start, end = float(ev[0]), float(ev[1])
        pitch = int(round(float(ev[2])))
        velocity = float(ev[3]) if len(ev) > 3 else 0.8
        if end > start and 0 <= pitch <= 127:
            notes.append(
                {
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "midi": pitch,
                    "velocity": round(max(0.0, min(1.0, velocity)), 3),
                }
            )
    notes.sort(key=lambda n: n["start"])
    print(json.dumps(notes))
    return 0


if __name__ == "__main__":
    sys.exit(main())
