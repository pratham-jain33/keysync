"""Tiny job server that runs inside the keysync-pipeline Daytona sandbox.

KeySync (Render) creates a sandbox from the snapshot, POSTs an audio file or a
YouTube URL to /job, polls /job/{id}, then deletes the sandbox. No Daytona
toolbox access needed from the outside: everything goes over the sandbox's
own preview URL.
"""

import os
import shutil
import threading
import traceback
import uuid

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

import pipeline

app = FastAPI()
jobs: dict = {}
MAX_CONCURRENT = 2
ALLOWED_EXTS = (".mp3", ".wav", ".m4a", ".ogg", ".flac", ".webm", ".mp4")


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/job")
async def create_job(
    youtube_url: str = Form(default=None),
    audio: UploadFile = File(default=None),
):
    busy = sum(1 for j in jobs.values() if j["status"] in ("queued", "running"))
    if busy >= MAX_CONCURRENT:
        return JSONResponse({"error": "server busy, try again in a minute"}, status_code=429)
    if not audio and not youtube_url:
        return JSONResponse(
            {"error": "Provide an audio file or a youtube_url."}, status_code=400
        )
    job_id = uuid.uuid4().hex[:12]
    jobdir = f"/tmp/keysync/{job_id}"
    os.makedirs(jobdir, exist_ok=True)
    if audio is not None:
        ext = os.path.splitext(audio.filename or "")[1].lower() or ".mp3"
        if ext not in ALLOWED_EXTS:
            shutil.rmtree(jobdir, ignore_errors=True)
            return JSONResponse(
                {"error": f"Unsupported audio type: {ext}"}, status_code=400
            )
        src_path = os.path.join(jobdir, "input" + ext)
        with open(src_path, "wb") as f:
            shutil.copyfileobj(audio.file, f)
        src = ("file", src_path)
    else:
        src = ("youtube", youtube_url)
    jobs[job_id] = {
        "status": "queued",
        "progress": 0,
        "log": [],
        "notes": None,
        "error": None,
        "error_code": None,
    }
    threading.Thread(target=_run, args=(job_id, src, jobdir), daemon=True).start()
    return {"job_id": job_id}


def _update(job_id: str, progress: int, msg: str):
    j = jobs[job_id]
    j["progress"] = progress
    if msg:
        j["log"].append(msg)


def _run(job_id: str, src, jobdir: str):
    j = jobs[job_id]
    try:
        j["status"] = "running"
        notes = pipeline.run(src, jobdir, lambda p, m: _update(job_id, p, m))
        j["status"] = "done"
        j["progress"] = 100
        j["notes"] = notes
        j["log"].append(f"Done: {len(notes)} notes")
    except pipeline.PipelineError as e:
        j["status"] = "error"
        j["error"] = str(e)
        j["error_code"] = e.code
        j["log"].append(f"Error [{e.code}]: {e}")
    except Exception as e:  # noqa: BLE001 - last-resort guard, error is typed above
        j["status"] = "error"
        j["error"] = str(e)[:500]
        j["error_code"] = "INTERNAL"
        j["log"].append(f"Error [INTERNAL]: {traceback.format_exc(limit=3)}")
    finally:
        shutil.rmtree(jobdir, ignore_errors=True)


@app.get("/job/{job_id}")
def get_job(job_id: str):
    j = jobs.get(job_id)
    if j is None:
        return JSONResponse({"error": "Unknown job."}, status_code=404)
    return j
