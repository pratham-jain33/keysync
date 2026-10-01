"""End-to-end test of the keysync-pipeline snapshot."""
import sys, time, json, urllib.request
sys.path.insert(0, '.')
import build_snapshot as b

TOKEN_TRANSPORT = None

def preview_req(base, token, path, method="GET", data=None, headers=None):
    """Try Bearer header first, then ?token= fallback."""
    global TOKEN_TRANSPORT
    url = base + path
    candidates = []
    if TOKEN_TRANSPORT != "query":
        h = dict(headers or {}); h["Authorization"] = f"Bearer {token}"
        candidates.append((url, h, "bearer"))
    if TOKEN_TRANSPORT != "bearer":
        sep = "&" if "?" in url else "?"
        candidates.append((f"{url}{sep}token={token}", headers or {}, "query"))
    last = None
    for u, h, kind in candidates:
        req = urllib.request.Request(u, data=data, headers=h, method=method)
        try:
            r = urllib.request.urlopen(req, timeout=60)
            body = r.read().decode()
            TOKEN_TRANSPORT = kind
            return r.status, body
        except urllib.error.HTTPError as e:
            last = e.code
            if e.code in (401, 403):
                continue
            raise
    raise RuntimeError(f"preview auth failed, last status {last}")

# 1. Create sandbox
s, sb = b.api("POST", "/api/sandbox", {
    "snapshot": "keysync-pipeline",
    "name": "keysync-e2e-test",
    "autoStopInterval": 15,
})
sid = sb["id"]
print("sandbox:", sid, flush=True)

# 2. Wait for start
for i in range(40):
    s, cur = b.api("GET", f"/api/sandbox/{sid}")
    if cur["state"] == "started":
        break
    if cur["state"] == "error":
        raise SystemExit(f"sandbox error: {cur.get('errorReason')}")
    time.sleep(10)
print("state: started", flush=True)

# 3. Preview URL
s, pv = b.api("GET", f"/api/sandbox/{sid}/ports/8000/preview-url")
base, token = pv["url"], pv["token"]
print("preview url ok", flush=True)

# 4. Health check (also discovers token transport)
t0 = time.time()
st, body = preview_req(base, token, "/health")
print(f"health ({TOKEN_TRANSPORT}): {body.strip()}", flush=True)

# 5. Submit a YouTube job: short piano piece
yt = "https://www.youtube.com/watch?v=4Tr0otuiQuU"  # Beethoven Moonlight Sonata 1st mvt (~6 min)
form_boundary = "----e2eboundary"
yt_body = (
    f"--{form_boundary}\r\n"
    f'Content-Disposition: form-data; name="youtube_url"\r\n\r\n'
    f"{yt}\r\n"
    f"--{form_boundary}--\r\n"
).encode()
st, body = preview_req(base, token, "/job", method="POST", data=yt_body,
                       headers={"Content-Type": f"multipart/form-data; boundary={form_boundary}"})
job = json.loads(body)
job_id = job["job_id"]
print(f"job accepted: {job_id}", flush=True)

# 6. Poll
t_start = time.time()
while True:
    time.sleep(20)
    st, body = preview_req(base, token, f"/job/{job_id}")
    j = json.loads(body)
    el = int(time.time() - t_start)
    print(f"[{el}s] status={j['status']} progress={j['progress']}", flush=True)
    for line in j["log"][-3:]:
        print(f"  log: {line}", flush=True)
    if j["status"] in ("done", "error"):
        if j["status"] == "error":
            print(f"JOB ERROR [{j.get('error_code')}]: {j.get('error')}", flush=True)
        else:
            notes = j["notes"]
            print(f"DONE: {len(notes)} notes in {el}s", flush=True)
            print(f"first 5: {notes[:5]}", flush=True)
            pitches = [n["pitch"] for n in notes]
            print(f"pitch range: {min(pitches)}-{max(pitches)}", flush=True)
        break
    if time.time() - t_start > 1800:
        print("TIMEOUT", flush=True)
        break

# 7. Cleanup
s, o = b.api("DELETE", f"/api/sandbox/{sid}")
print(f"cleanup: {s}", flush=True)
