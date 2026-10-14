#!/usr/bin/env python3
"""tone_backfill.py — W43.3 (Fable, 27 Sep): queue diarize + emotion on the box GPU for every transcribed
window that has no tone result, newest first, WITHOUT starving STT (STT first).

Read-only inputs: Neon snapshots (bench_window / bench_chunk via kit/neon-select.mjs, staged by the operator),
cut_window.py imported unedited from the pinned harness (PARITY-389). Services: box diarize twin :8001 (/diarize)
and box emotion twin :8086 (/inference/wavlm), both local-only, cuda.

Everything written is NEW and write-once, under hist-bulk's own namespace: claims (O_EXCL) at
~/eta-data/hist/tone/claims/<window_id>.json and tone records at ~/eta-data/hist/tone/runs/<run_id>/<window_id>.json (0600).
No existing record, table or harness file is touched. Patient audio exists only as 0600 temp files, deleted per window.

STT first: before each window the worker waits while any box STT job (`node_route.py --router http://127.0.0.1:8083`)
is alive; the box STT runner's own startup guard is unaffected (tone jobs are not node_route).

Usage: tone_backfill.py --run-id hist-bulk-tone-<ts> [--shard N/K] [--limit N] [--dry-run]
"""
import argparse, glob, json, os, subprocess, sys, tempfile, time, urllib.request, urllib.error, uuid
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-hist-mining/harness"))
import cut_window  # pinned harness piece (imported, never edited)

HD = os.path.expanduser("~/eta-data/hist/tone")
# R3/W51 blind predicate (shared heldout helper; Fable 8315 ruling 19 makes this filter mandatory)
sys.path.insert(0, os.path.expanduser("~/eta-data/drtpqma"))
import heldout as _heldout
_UNION, _ = _heldout.load_union()
def _true_ist_date(w):
    """The worklist's ist_date is the room-day key written as IST midnight in UTC (one day early);
    derive the record's IST day from the window's own start instead."""
    return datetime.fromtimestamp(int(w["start_ms"]) / 1000, timezone.utc).astimezone(IST).date().isoformat()
def _true_ist_date(w):
    """The worklist ist_date is the room-day key written as IST midnight in UTC (one day early);
    derive the record's IST day from the window's own start instead (r3 8569)."""
    return datetime.fromtimestamp(int(w["start_ms"]) / 1000, timezone.utc).astimezone(IST).date().isoformat()
def _atomic_write(path, rec):
    """r3 8569: non-atomic open('x').write leaves a truncated file that counts as done if killed
    mid-write. Write to .tmp then os.replace."""
    tmp = path + ".tmp"
    with open(tmp, "x") as h: json.dump(rec, h, ensure_ascii=False)
    os.replace(tmp, path); os.chmod(path, 0o600)
def _blind(w):
    """True if the window's true IST start OR end-1s day is a held-out room-day (R3/W51, Fable 8315/19)."""
    try:
        start = datetime.fromtimestamp(int(w["start_ms"]) / 1000, timezone.utc).astimezone(IST)
        end = datetime.fromtimestamp(int(w["end_ms"]) / 1000, timezone.utc).astimezone(IST)
        eni = end - timedelta(seconds=1)
        days = {start.date().isoformat(), eni.date().isoformat()}
        return any(_heldout.is_held_out(_UNION, d, w.get("room_id", "")) for d in days)
    except Exception as ex:
        print(f"blind filter error on {w.get('id','?')}: {ex}", flush=True)
        return True   # fail-closed
AUDIO_FLAT = os.path.expanduser("~/eta-data/hist-mining/audio")
DIARIZE_URL = os.environ.get("TONE_DIARIZE_URL", "http://127.0.0.1:8001/diarize")
EMOTION_URL = os.environ.get("TONE_EMOTION_URL", "http://127.0.0.1:8086/inference/wavlm")
# TONE-C3 lane (Fable 8315 ruling 19): the c3 twins are reached through an ssh tunnel; the env vars
# point the worker at the tunnel ports. The provenance block records which URLs actually served.
IST = timezone(timedelta(hours=5, minutes=30))
MAX_SPAN_S = 60.0      # emotion twin's EMOTION_MAX_DURATION_S
MERGE_GAP_S = 0.5

def utc(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if isinstance(s, str) else s

def log(msg):
    print(f"{datetime.now(IST).isoformat(timespec='seconds')} {msg}", flush=True)

CURRENT_CLAIM = {"path": None}
def _on_sigterm(signum, frame):
    # r3 8569: a SIGTERM'd worker never reaches the except that unlinks its claim - the claim file
    # would strand the window forever. Unlink the current claim on the way out.
    pth = CURRENT_CLAIM.get("path")
    if pth:
        try: os.unlink(pth)
        except OSError: pass
    raise SystemExit(1)
import signal
signal.signal(signal.SIGTERM, _on_sigterm)

def sha256_file(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()

def gpu_busy():
    """GPU actually busy (STT's whisper bursts are the GPU part of a route job; IndicConformer/SraVaani phases are CPU)."""
    r = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"], capture_output=True, text=True)
    try:
        return int(r.stdout.strip().splitlines()[0]) > 15
    except (ValueError, IndexError):
        return False

def stt_busy():
    """STT-first gate: a box STT route job is alive AND the GPU is actually working (waiting on mere CPU phases would starve tone without helping STT)."""
    r = subprocess.run(["bash", "-c", "ps -eo args | grep -c '^python3 histwork/node_route.py --router http://127.0.0.1:8083 '"],
                       capture_output=True, text=True)
    try:
        n = int(r.stdout.strip() or "0")
    except ValueError:
        n = 0
    return n > 0 and gpu_busy()

def wait_for_stt_idle():
    while stt_busy():
        log("STT first: box STT job alive, tone worker waits 60 s")
        time.sleep(60)

TAPE_GLOB = os.path.expanduser("~/eta-data/tapes/room_*/*/*.webm")

def build_file_index(chunk_rows):
    """chunk id -> local audio path: the flat hist-mining store first, then the tapes/ store (<ts>_i<idx>_bc_<id>.webm)."""
    files = {}
    for c in chunk_rows:
        name = "bench__" + c["r2_key"][len("bench/"):].replace("/", "__")
        p = os.path.join(AUDIO_FLAT, name)
        if os.path.exists(p): files[c["id"]] = p
    for p in glob.glob(TAPE_GLOB):
        base = os.path.basename(p)
        if "_bc_" in base:
            cid = base.split("_bc_")[-1][: -len(".webm")]
            if cid not in files: files[cid] = p
    return files

def http_multipart(url, file_field, file_path, fields):
    boundary = uuid.uuid4().hex
    with open(file_path, "rb") as f:
        data = f.read()
    body = b""
    for k, v in fields.items():
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"a.webm\"\r\n"
             f"Content-Type: audio/webm\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.loads(r.read())

def http_json(url, obj, timeout=300):
    req = urllib.request.Request(url, data=json.dumps(obj).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def cut_segment_wav(window_webm, start_ms, end_ms, out_wav):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", window_webm,
                        "-ss", f"{start_ms/1000:.3f}", "-to", f"{end_ms/1000:.3f}",
                        "-ac", "1", "-ar", "16000", "-f", "wav", out_wav], capture_output=True)
    return r.returncode == 0 and os.path.getsize(out_wav) > 44

def merge_spans(segments):
    """diarize transcript_segments [{start_ms,end_ms,speaker_idx},...] -> per-speaker spans capped at MAX_SPAN_S."""
    by = {}
    for s in segments:
        by.setdefault(s.get("speaker_idx"), []).append((int(s["start_ms"]), int(s["end_ms"])))
    spans = []
    for spk, turns in by.items():
        turns.sort()
        cur = None
        for a, b in turns:
            if cur and a - cur[1] <= MERGE_GAP_S * 1000 and (b - cur[0]) / 1000 < MAX_SPAN_S:
                cur[1] = max(cur[1], b)
            else:
                if cur: spans.append((spk, cur[0], cur[1]))
                cur = [a, b]
        if cur: spans.append((spk, cur[0], cur[1]))
    out = []
    for spk, a, b in spans:
        while (b - a) / 1000 > MAX_SPAN_S:          # split long spans at the model's cap
            out.append((spk, a, a + int(MAX_SPAN_S * 1000))); a += int(MAX_SPAN_S * 1000)
        out.append((spk, a, b))
    return sorted(out, key=lambda x: (x[1], x[2]))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--shard", default="0/1", help="N/K: process worklist positions where i %% K == N")
    ap.add_argument("--day", default=None, help="restrict to one IST day as stored in the worklist (ist_date prefix, e.g. 2026-09-24)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    n, k = (int(x) for x in a.shard.split("/"))
    run_dir = f"{HD}/runs/{a.run_id}"
    os.makedirs(run_dir, exist_ok=True)

    wl = json.load(open(f"{HD}/tone_worklist.json"))
    chunks_by_session = {}
    for c in json.load(open(f"{HD}/bench_chunks.json")):
        chunks_by_session.setdefault(c["session_id"], []).append(c)

    prov = {
        "run_id": a.run_id, "producer": "hist-bulk", "order": "W43.3 (27 Sep)",
        "created_at": datetime.now(IST).isoformat(timespec="seconds"),
        "not_run": ["stt (windows already transcribed; bench_window)", "voiceprint role attribution (SPLIT/VOICEPRINT not run: tone is per anonymous diarize speaker index)"],
        "services": ({
            "diarize": {"url": DIARIZE_URL},
            "emotion": {"url": EMOTION_URL},
        } if os.environ.get("TONE_C3_SERVER_SHAS") else {
            "diarize": {"url": DIARIZE_URL, "server_file": "/home/eta/services/eta-diarize/server.py", "server_sha256": sha256_file("/home/eta/services/eta-diarize/server.py")},
            "emotion": {"url": EMOTION_URL, "app_file": os.path.expanduser("~/eta-emotion/app.py"), "app_sha256": sha256_file(os.path.expanduser("~/eta-emotion/app.py"))},
        }) | ({"c3_server_shas": os.environ["TONE_C3_SERVER_SHAS"]} if os.environ.get("TONE_C3_SERVER_SHAS") else {}),
        "inputs": {"worklist": "Neon snapshot bench_window(state=closed) LEFT JOIN room_emotion_window NULL, newest first", "chunks": "Neon snapshot bench_chunk(upload_state=verified)"},
        "notes": ["lab-side records only: no Neon/production write (needs an explicit Fable order naming it)",
                  "STT first: worker yields while any box node_route job on :8083 is alive"],
    }
    prov_path = f"{run_dir}/provenance.json"
    try:
        (open(prov_path, "x")).write(json.dumps(prov, indent=1)); os.chmod(prov_path, 0o600)
    except FileExistsError:
        pass  # sibling shard wrote it first: same content, fine

    file_index = build_file_index(json.load(open(f"{HD}/bench_chunks.json")))
    try: chunks_mtime = os.path.getmtime(f"{HD}/bench_chunks.json")
    except OSError: chunks_mtime = 0

    def load_worklist():
        try:
            wl = json.load(open(f"{HD}/tone_worklist.json"))
            if a.day:
                wl = [w for w in wl if _true_ist_date(w) == a.day]   # r3 8569: worklist ist_date is one day early
            # R3/W51 blind guard (Fable 8315 ruling 19: heldout.py filter MANDATORY): refuse windows
            # whose true IST start OR end-1s day is one of the 14 held-out room-days.
            wl = [w for w in wl if not _blind(w)]
            return [w for i, w in enumerate(wl) if i % k == n]
        except Exception as ex:
            print(f"load_worklist FAILED: {ex}", flush=True)
            raise SystemExit(1)

    if a.limit: pass  # --limit applies per fresh snapshot
    log(f"shard {a.shard}: dynamic worklist (re-read each window) of initial {len(wl)} (run {a.run_id})")

    n_done = n_skip = n_fail = 0
    t0 = time.time()
    idle_rounds = 0
    retry_at = {}
    while True:
        todo = load_worklist()
        if a.limit and n_done >= a.limit: break
        now = time.time()
        done_anywhere = {os.path.basename(f)[:-5] for f in glob.glob(f"{HD}/runs/*/bw_*.json")}
        w = next((x for x in todo if x["id"] not in retry_at or retry_at[x["id"]] <= now
                  if x["id"] not in done_anywhere
                  and not os.path.exists(f"{HD}/claims/{x['id']}.json")), None)
        if w is None:
            pending = [x for x in todo if x["id"] not in done_anywhere and not os.path.exists(f"{run_dir}/{x['id']}.json")]
            if not pending or all(retry_at.get(x["id"], 0) > now for x in pending if not os.path.exists(f"{HD}/claims/{x['id']}.json")):
                idle_rounds += 1
                if idle_rounds >= 3: break    # nothing claimable now: the loop refreshes + relaunches
                time.sleep(60); continue
            time.sleep(5); continue
        idle_rounds = 0
        wid = w["id"]
        out_path = f"{run_dir}/{wid}.json"
        if os.path.exists(out_path) or glob.glob(f"{HD}/runs/*/{wid}.json"): n_skip += 1; continue
        claim_path = f"{HD}/claims/{wid}.json"
        try:
            fd = os.open(claim_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "w") as h: json.dump({"run": a.run_id, "ts": datetime.now(IST).isoformat(), "shard": a.shard}, h)
            CURRENT_CLAIM["path"] = claim_path   # r3 8569: the SIGTERM handler unlinks this on kill
        except FileExistsError:
            n_skip += 1; continue
        try:
            wait_for_stt_idle()
            if a.dry_run: n_skip += 1; os.unlink(claim_path); continue
            sess = chunks_by_session.get(w["session_id"], [])
            try: cur_chunks_mtime = os.path.getmtime(f"{HD}/bench_chunks.json")
            except OSError: cur_chunks_mtime = chunks_mtime
            if cur_chunks_mtime != chunks_mtime:   # loop refreshed the chunk snapshot: pick up new local audio
                chunks_by_session = {}
                for c in json.load(open(f"{HD}/bench_chunks.json")):
                    chunks_by_session.setdefault(c["session_id"], []).append(c)
                file_index = build_file_index(json.load(open(f"{HD}/bench_chunks.json")))
                chunks_mtime = cur_chunks_mtime
            files = {c["id"]: file_index[c["id"]] for c in sess if c["id"] in file_index}
            start = datetime.fromtimestamp(int(w["start_ms"]) / 1000, timezone.utc)
            end = datetime.fromtimestamp(int(w["end_ms"]) / 1000, timezone.utc)
            have = [c for c in sess if c["id"] in files]
            recent = end > datetime.now(timezone.utc) - timedelta(hours=3)   # tape pull lags: recent windows may not be local YET
            if not have:
                if recent:
                    retry_at[wid] = time.time() + 900   # backoff: audio may still be landing
                    os.unlink(claim_path); n_skip += 1; log(f"audio not local yet, retry at +15 min {wid}"); time.sleep(3); continue
                rec = {"window_id": wid, "state": "no_audio_local", "room": w["room"], "ist_date": _true_ist_date(w)}
                _atomic_write(out_path, rec)
                n_done += 1; log(f"no-audio {wid}"); continue
            with tempfile.TemporaryDirectory(dir=HD) as td:
                win_wav = f"{td}/{wid}.webm"
                cutrep = cut_window.cut(have, start, end, win_wav, files)
                if not cutrep.get("duration_s"):
                    if recent:
                        retry_at[wid] = time.time() + 900
                        os.unlink(claim_path); n_skip += 1; log(f"cut empty (chunks not in snapshot yet?), retry at +15 min {wid}"); time.sleep(3); continue
                    rec = {"window_id": wid, "state": "no_audio_after_cut", "cut": cutrep, "room": w["room"], "ist_date": _true_ist_date(w)}
                    _atomic_write(out_path, rec)
                    n_done += 1; log(f"empty {wid}"); continue
                d = http_multipart(DIARIZE_URL, "audio", win_wav, {"encounter_id": wid, "clinician_centroids": "[]", "manual_relabels": "[]", "batch_threshold": "0.70"})
                spans = merge_spans(d.get("transcript_segments", []))
                scored, fails = [], 0
                for spk, a_ms, b_ms in spans:
                    seg = f"{td}/seg.wav"
                    if not cut_segment_wav(win_wav, a_ms, b_ms, seg):
                        fails += 1; continue
                    try:
                        e = http_multipart(EMOTION_URL, "file", seg, {})
                    except Exception as ex:
                        e = {"ok": False, "error": str(ex)[:200]}; fails += 1
                    scored.append({"speaker_idx": spk, "start_ms": a_ms, "end_ms": b_ms,
                                   "emotion": {kk: e.get(kk) for kk in ("ok", "unscorable", "model", "labels", "top", "skip_reason", "speech_s_est", "error") if kk in e}})
            rec = {"window_id": wid, "state": "scored", "schema": "eta-lab-tone/1", "room": w["room"],
                   "ist_date": _true_ist_date(w), "start_ms": w["start_ms"], "end_ms": w["end_ms"],
                   "cut": cutrep, "diarize": {"speakers": d.get("speakers"), "n_segments": len(d.get("transcript_segments", [])),
                                               "n_overlap_windows": len(d.get("overlap_windows", [])), "model_versions": d.get("model_versions")},
                   "spans": scored, "span_fails": fails, "provenance": prov}
            _atomic_write(out_path, rec)
            n_done += 1
            CURRENT_CLAIM["path"] = None
            rate = n_done / max(time.time() - t0, 1) * 60
            log(f"done {wid} spans={len(scored)} fails={fails} ({rate:.1f}/min)")
        except Exception as ex:
            n_fail += 1
            log(f"FAIL {wid}: {str(ex)[:300]}")
            try: os.unlink(f"{HD}/claims/{wid}.json")
            except OSError: pass
            time.sleep(5)
    log(f"shard {a.shard} finished: done={n_done} skipped={n_skip} failed={n_fail}")

if __name__ == "__main__":
    main()
