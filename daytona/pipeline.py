"""KeySync Daytona pipeline: YouTube/file -> htdemucs_6s piano stem -> Kong -> MIDI.

Runs inside the keysync-pipeline Daytona snapshot. Heavy compute only: normalize
the upload, isolate the piano stem with the 6-stem Demucs model, send that stem
to the Kong high-resolution piano transcription service, clean the note list, and
write both notes.json (via the caller) and piano.mid. Raises PipelineError with a
stable code on every expected failure so the caller can show a useful message.
"""

import glob
import os
import subprocess
from collections import defaultdict

import requests

# Hosted Kong transcription service (POST audio, get piano notes back).
KONG_URL = os.environ.get(
    "KONG_TRANSCRIBE_URL", "https://kongml-optimized.onrender.com/transcribe"
)
MIN_NOTE_SEC = 0.03  # drop anything shorter than 30ms


class PipelineError(Exception):
    def __init__(self, code: str, msg: str):
        super().__init__(msg)
        self.code = code


def _sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def _download_youtube(url: str, work: str, progress) -> str:
    progress(3, "Downloading from YouTube")
    if not url.startswith(("http://", "https://")):
        raise PipelineError("BAD_URL", "That does not look like a valid URL.")
    tpl = os.path.join(work, "src.%(ext)s")
    r = _sh(
        ["yt-dlp", "-x", "--audio-format", "wav",
         "--match-filter", "duration < 600",
         "-o", tpl, url],
        timeout=600,
    )
    wavs = glob.glob(os.path.join(work, "src.wav"))
    if r.returncode != 0 or not wavs:
        err = ((r.stderr or "") + (r.stdout or ""))[-600:]
        if "match filter" in err.lower():
            raise PipelineError(
                "TOO_LONG",
                "Videos over 10 minutes are not supported yet. Try a shorter one.",
            )
        raise PipelineError(
            "YOUTUBE_BLOCKED",
            "YouTube refused the download from our processing server. "
            "Upload the audio file directly instead.",
        )
    progress(10, "Download complete")
    return wavs[0]


def _normalize(src_path: str, work: str, progress) -> str:
    """FFmpeg normalize any input to a 44.1kHz stereo WAV for Demucs."""
    progress(12, "Normalizing audio")
    wav = os.path.join(work, "norm.wav")
    r = _sh(["ffmpeg", "-y", "-i", src_path, "-ac", "2", "-ar", "44100", wav])
    if r.returncode != 0 or not os.path.exists(wav):
        raise PipelineError("AUDIO_DECODE_FAILED", "Could not decode the audio.")
    progress(15, "Audio ready")
    return wav


def _isolate_piano(wav: str, work: str, progress) -> str:
    progress(18, "Isolating piano with htdemucs_6s")
    stems = os.path.join(work, "stems")
    _sh(
        ["python", "-m", "demucs", "-n", "htdemucs_6s", "-o", stems, "--mp3", wav],
        timeout=1800,
    )
    pianos = glob.glob(os.path.join(stems, "**", "piano.mp3"), recursive=True)
    if not pianos:
        raise PipelineError("ISOLATION_FAILED", "Piano isolation produced no usable stem.")
    progress(55, "Piano isolated")
    return pianos[0]


def _transcribe(piano_path: str, progress) -> list:
    progress(60, "Transcribing with Kong piano model")
    try:
        with open(piano_path, "rb") as fh:
            resp = requests.post(
                KONG_URL,
                files={"audio": ("piano.mp3", fh, "audio/mpeg")},
                timeout=1200,
            )
    except requests.RequestException as e:
        raise PipelineError("TRANSCRIBE_FAILED", f"Transcription request failed: {str(e)[:300]}")

    if resp.status_code == 422:
        raise PipelineError(
            "NO_NOTES", "No piano notes were detected. Is there piano in this audio?"
        )
    if resp.status_code != 200:
        detail = resp.text[:300]
        raise PipelineError("TRANSCRIBE_FAILED", f"Transcription service HTTP {resp.status_code}: {detail}")

    try:
        payload = resp.json()
        raw = payload["notes"] if isinstance(payload, dict) else payload
    except (ValueError, KeyError, TypeError):
        raise PipelineError("TRANSCRIBE_FAILED", "Transcription service returned unexpected output.")

    notes = []
    for ev in raw or []:
        try:
            start, end = float(ev["start"]), float(ev["end"])
            midi = int(ev["midi"])
            vel = float(ev.get("velocity", 0.8))
        except (KeyError, ValueError, TypeError):
            continue
        if end > start and 0 <= midi <= 127:
            notes.append({"midi": midi, "start": start, "end": end, "velocity": vel})
    progress(88, f"Transcription complete: {len(notes)} raw notes")
    return notes


def _cleanup(notes: list, progress) -> list:
    """Drop <30ms notes, dedupe, trim same-pitch overlaps, normalize velocity."""
    progress(92, "Cleaning up MIDI")
    notes = [n for n in notes if n["end"] - n["start"] >= MIN_NOTE_SEC]

    by_pitch = defaultdict(list)
    for n in notes:
        by_pitch[n["midi"]].append(n)

    out: list = []
    for midi, group in by_pitch.items():
        group.sort(key=lambda n: n["start"])
        kept: list = []
        for n in group:
            if kept:
                prev = kept[-1]
                # Duplicate: a near-simultaneous re-trigger of the same pitch.
                if n["start"] - prev["start"] < MIN_NOTE_SEC:
                    prev["end"] = max(prev["end"], n["end"])
                    prev["velocity"] = max(prev["velocity"], n["velocity"])
                    continue
                # Overlap: a held note cannot run past the next strike.
                if prev["end"] > n["start"]:
                    prev["end"] = n["start"]
            kept.append(dict(n))
        out.extend(kept)

    out = [n for n in out if n["end"] - n["start"] >= MIN_NOTE_SEC]
    if not out:
        raise PipelineError("NO_NOTES", "No usable piano notes after cleanup.")

    # Normalize velocity: scale the loudest note toward the top of the range so
    # dynamics read clearly, with a floor so the quietest notes stay audible.
    peak = max(n["velocity"] for n in out)
    if peak > 0:
        for n in out:
            n["velocity"] = round(min(1.0, max(0.05, n["velocity"] / peak * 0.9)), 3)

    for n in out:
        n["start"] = round(n["start"], 3)
        n["end"] = round(n["end"], 3)
    out.sort(key=lambda n: (n["start"], n["midi"]))
    progress(96, f"Cleaned to {len(out)} notes")
    return out


def _write_midi(notes: list, path: str) -> None:
    import mido

    ticks_per_beat = 480
    tempo = mido.bpm2tempo(120)  # fixed grid; practice timing is driven by seconds
    mid = mido.MidiFile(ticks_per_beat=ticks_per_beat)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=tempo, time=0))

    def to_ticks(seconds: float) -> int:
        return int(round(mido.second2tick(seconds, ticks_per_beat, tempo)))

    events = []
    for n in notes:
        vel = max(1, min(127, int(round(n["velocity"] * 127))))
        events.append((to_ticks(n["start"]), 1, n["midi"], vel))   # note_on
        events.append((to_ticks(n["end"]), 0, n["midi"], 0))       # note_off
    # At a shared tick, note_off (0) must precede note_on (1).
    events.sort(key=lambda e: (e[0], e[1]))

    last = 0
    for tick, kind, midi, vel in events:
        delta = max(0, tick - last)
        msg = "note_on" if kind == 1 else "note_off"
        track.append(mido.Message(msg, note=midi, velocity=vel, time=delta))
        last = tick
    mid.save(path)


def run(src, jobdir: str, progress) -> list:
    """src is ("youtube", url) or ("file", path). Returns a list of note dicts
    ({midi,start,end,velocity}) and writes piano.mid into jobdir."""
    work = os.path.join(jobdir, "work")
    os.makedirs(work, exist_ok=True)
    if src[0] == "youtube":
        raw = _download_youtube(src[1], work, progress)
    else:
        raw = src[1]
    wav = _normalize(raw, work, progress)
    piano = _isolate_piano(wav, work, progress)
    notes = _transcribe(piano, progress)
    notes = _cleanup(notes, progress)
    _write_midi(notes, os.path.join(jobdir, "piano.mid"))
    progress(98, f"Wrote piano.mid ({len(notes)} notes)")
    return notes
