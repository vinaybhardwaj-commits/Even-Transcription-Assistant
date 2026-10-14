#!/usr/bin/env python3
"""Bake-off driver: upload each bench-window WAV to pyannote.ai and diarize.
Reads API key at runtime only. Never prints key. Serial, one job at a time.
"""
import os, sys, json, time, subprocess, urllib.request, urllib.error

KEY_PATH = os.path.expanduser("~/.claude/secrets/pyannote_api_key")
BASE = "https://api.pyannote.ai/v1"
AUDIO_DIR = os.path.expanduser("~/dev/_fable/scratch/pyabake/audio")
RESULTS_DIR = os.path.expanduser("~/dev/_fable/scratch/pyabake/results")
LOG = os.path.expanduser("~/dev/_fable/scratch/pyabake/pya_bake.log")
MODEL = "precision-3"
POLL_SEC = 6
JOB_TIMEOUT_SEC = 1800

def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    with open(LOG, "a") as f:
        f.write(line + "\n")
    print(line, flush=True)

def read_key():
    with open(KEY_PATH) as f:
        return f.read().strip()

def api_call(method, path, key, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        BASE + path, data=data,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:500]
        raise RuntimeError(f"HTTP {e.code} on {method} {path}: {body}")

def upload_and_diarize(wav_path, window_id, key):
    object_key = f"etabake/{window_id}.wav"
    media_url = f"media://{object_key}"
    presign = api_call("POST", "/media/input", key, {"url": media_url})
    put_url = presign["url"]
    r = subprocess.run(["curl", "-sS", "-X", "PUT", "-T", wav_path, put_url],
                        capture_output=True, timeout=600)
    if r.returncode != 0:
        raise RuntimeError(f"upload failed rc={r.returncode} stderr={r.stderr.decode()[:300]}")
    t0 = time.time()
    job = api_call("POST", "/diarize", key, {"url": media_url, "model": MODEL})
    job_id = job["jobId"]
    status = job.get("status")
    j = {}
    while status not in ("succeeded", "failed", "canceled"):
        if time.time() - t0 > JOB_TIMEOUT_SEC:
            raise RuntimeError(f"job {job_id} timed out after {JOB_TIMEOUT_SEC}s, last status={status}")
        time.sleep(POLL_SEC)
        j = api_call("GET", f"/jobs/{job_id}", key)
        status = j.get("status")
    latency = time.time() - t0
    if status != "succeeded":
        return {"window_id": window_id, "status": status, "error": j.get("error"),
                 "latency_sec": latency, "model": MODEL, "job_id": job_id}
    output = j.get("output", {})
    return {"window_id": window_id, "status": status, "output": output,
             "latency_sec": latency, "model": MODEL, "job_id": job_id}

def main():
    key = read_key()
    os.makedirs(RESULTS_DIR, exist_ok=True)
    wavs = sorted([f for f in os.listdir(AUDIO_DIR) if f.endswith(".wav")])
    log(f"Found {len(wavs)} wav files. Model={MODEL}")
    for w in wavs:
        window_id = w[:-4]
        out_path = os.path.join(RESULTS_DIR, f"{window_id}_pyannote.json")
        if os.path.exists(out_path):
            log(f"SKIP {window_id} (exists)")
            continue
        log(f"START {window_id}")
        try:
            result = upload_and_diarize(os.path.join(AUDIO_DIR, w), window_id, key)
            with open(out_path, "w") as f:
                json.dump(result, f)
            os.chmod(out_path, 0o600)
            lat = result.get("latency_sec") or 0
            log(f"DONE {window_id} status={result['status']} latency={lat:.1f}s")
        except Exception as e:
            log(f"FAIL {window_id}: {e}")
    log("ALL_DONE")

if __name__ == "__main__":
    main()
