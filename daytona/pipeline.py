"""KeySync Daytona pipeline: YouTube/file -> Demucs piano isolation -> Basic Pitch -> notes JSON.

Runs inside the keysync-pipeline Daytona snapshot. Raises PipelineError with a
stable code on every expected failure so the caller can show a useful message.
"""

import glob
import os
import subprocess


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


def _prepare_file(src_path: str, work: str, progress) -> str:
    progress(3, "Preparing audio")
    wav = os.path.join(work, "src.wav")
    r = _sh(["ffmpeg", "-y", "-i", src_path, "-ac", "1", "-ar", "44100", wav])
    if r.returncode != 0 or not os.path.exists(wav):
        raise PipelineError("AUDIO_DECODE_FAILED", "Could not decode the uploaded audio file.")
    progress(10, "Audio ready")
    return wav


def _isolate_piano(wav: str, work: str, progress) -> str:
    progress(15, "Isolating piano with Demucs")
    stems = os.path.join(work, "stems")
    r = _sh(
        ["python", "-m", "demucs", "-n", "htdemucs_6s", "-o", stems, "--mp3", wav],
        timeout=1800,
    )
    pianos = glob.glob(os.path.join(stems, "**", "piano.mp3"), recursive=True)
    if not pianos:
        # Fallback: 4-stem model puts piano inside "other".
        progress(35, "Trying fallback stem model")
        _sh(
            ["python", "-m", "demucs", "-n", "htdemucs", "-o", stems, "--mp3", wav],
            timeout=1800,
        )
        pianos = glob.glob(os.path.join(stems, "**", "other.mp3"), recursive=True)
    if not pianos:
        raise PipelineError("ISOLATION_FAILED", "Piano isolation produced no usable stem.")
    progress(55, "Piano isolated")
    return pianos[0]


def _transcribe(piano_path: str, progress):
    progress(60, "Transcribing with Basic Pitch")
    try:
        from basic_pitch.inference import predict

        _model_output, _midi_data, note_events = predict(piano_path)
    except Exception as e:  # noqa: BLE001 - surfaced as a typed error below
        raise PipelineError("TRANSCRIBE_FAILED", f"Transcription failed: {str(e)[:300]}")
    progress(90, "Transcription complete")
    notes = []
    for ev in note_events:
        try:
            start, end, pitch = float(ev[0]), float(ev[1]), int(ev[2])
        except (IndexError, ValueError, TypeError):
            continue
        if end > start:
            notes.append(
                {"pitch": pitch, "start": round(start, 3), "end": round(end, 3)}
            )
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    if not notes:
        raise PipelineError(
            "NO_NOTES", "No piano notes were detected. Is there piano in this audio?"
        )
    progress(98, f"Extracted {len(notes)} notes")
    return notes


def run(src, jobdir: str, progress) -> list:
    """src is ("youtube", url) or ("file", path). Returns a list of note dicts."""
    work = os.path.join(jobdir, "work")
    os.makedirs(work, exist_ok=True)
    if src[0] == "youtube":
        wav = _download_youtube(src[1], work, progress)
    else:
        wav = _prepare_file(src[1], work, progress)
    piano = _isolate_piano(wav, work, progress)
    return _transcribe(piano, progress)
