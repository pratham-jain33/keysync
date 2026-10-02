"""Build the keysync-pipeline Daytona snapshot (one-time setup, run manually).

Assembles a Dockerfile with htdemucs_6s (6-stem Demucs) + the job server baked
in, then creates the snapshot via the Daytona API. Transcription itself runs on
the external Kong service, so no ML transcription stack is installed here. Uses
the stored custom.daytona credential via surrogates - the key is never printed.
"""

import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response  # noqa: E402

API = "https://app.daytona.io"
SNAPSHOT_NAME = os.environ.get("SNAPSHOT_NAME", "keysync-pipeline")


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    add_surrogate_to_request(
        req, "custom.daytona", entry_name="access_token",
        allowed_hosts=["app.daytona.io"],
    )
    try:
        resp = urllib.request.urlopen(req, timeout=120)
        return resp.status, read_json_response(resp)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:800]


def build_dockerfile(base_dir):
    pipeline_py = open(f"{base_dir}/pipeline.py").read()
    server_py = open(f"{base_dir}/server.py").read()
    cli_py = open(f"{base_dir}/cli.py").read()
    assert "PYEOF" not in pipeline_py and "PYEOF" not in server_py and "PYEOF" not in cli_py
    return f"""FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \\
    ffmpeg curl \\
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir demucs yt-dlp fastapi uvicorn python-multipart requests mido

RUN python -c "from demucs.pretrained import get_model; get_model('htdemucs_6s')"

WORKDIR /app

RUN cat > /app/pipeline.py << 'PYEOF'
{pipeline_py}PYEOF

RUN cat > /app/server.py << 'PYEOF'
{server_py}PYEOF

RUN cat > /app/cli.py << 'PYEOF'
{cli_py}PYEOF

RUN python -c "import ast; ast.parse(open('/app/pipeline.py').read()); ast.parse(open('/app/server.py').read()); ast.parse(open('/app/cli.py').read()); print('syntax OK')"

EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
"""


def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    dockerfile = build_dockerfile(base_dir)
    print(f"Dockerfile assembled ({len(dockerfile)} bytes)")

    body = {
        "name": SNAPSHOT_NAME,
        "buildInfo": {"dockerfileContent": dockerfile},
        "cpu": 2,
        "memory": 8,
        "disk": 10,
    }
    status, out = api("POST", "/api/snapshots", body)
    print("create status:", status)
    if status not in (200, 201, 409):
        print("create response:", out)
        sys.exit(1)
    if status == 409:
        print("snapshot already exists, watching its state instead")

    for i in range(120):  # up to ~60 min for the heavy build
        time.sleep(30)
        status, out = api("GET", f"/api/snapshots/{SNAPSHOT_NAME}")
        if status != 200:
            print("poll error:", status, out)
            continue
        state = out.get("state")
        err = out.get("errorReason")
        print(f"[{i}] state={state}" + (f" error={err}" if err else ""))
        if state == "active":
            print("SNAPSHOT READY")
            return
        if state == "error":
            print("SNAPSHOT BUILD FAILED:", err or out)
            sys.exit(1)
    print("timed out waiting for snapshot build")
    sys.exit(1)


if __name__ == "__main__":
    main()
