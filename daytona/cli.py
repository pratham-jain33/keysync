"""KeySync Daytona pipeline CLI: run from the toolbox process API.

Usage:
    python3 cli.py youtube <url> <jobdir>
    python3 cli.py file <path> <jobdir>

Writes progress lines (JSON) to stdout and <jobdir>/progress.log,
writes notes to <jobdir>/notes.json on success.
Exits 0 on success, 2 on expected PipelineError, 1 on unexpected error.
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pipeline import PipelineError, run


def main() -> int:
    if len(sys.argv) != 4 or sys.argv[1] not in ("youtube", "file"):
        print("usage: cli.py youtube|file <url|path> <jobdir>", file=sys.stderr)
        return 1
    mode, src, jobdir = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(jobdir, exist_ok=True)
    log_path = os.path.join(jobdir, "progress.log")

    def progress(pct: int, msg: str) -> None:
        line = json.dumps({"t": time.time(), "pct": pct, "msg": msg})
        print(line, flush=True)
        with open(log_path, "a") as f:
            f.write(line + "\n")

    try:
        notes = run((mode, src), jobdir, progress)
    except PipelineError as e:
        progress(-1, f"ERROR {e.code}: {e}")
        return 2
    except Exception as e:  # noqa: BLE001 - surfaced as typed failure
        progress(-1, f"ERROR UNEXPECTED: {type(e).__name__}: {str(e)[:300]}")
        return 1

    with open(os.path.join(jobdir, "notes.json"), "w") as f:
        json.dump(notes, f)
    progress(100, f"Done: {len(notes)} notes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
