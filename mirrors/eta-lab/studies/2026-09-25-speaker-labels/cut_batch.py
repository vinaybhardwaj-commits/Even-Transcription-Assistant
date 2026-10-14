#!/usr/bin/env python3
"""337e full run, stage 1 (box): cut the FULL wall-clock audio of vault windows of ANY length exactly as the transcript saw it (split-speaker's measure.decode + refused_logic.chunk_plan; gaps stay silent),
then encode each to FLAC (LOSSLESS, ~50 % of wav; an Opus re-encode was tried first and changed labels on a few windows: wav-vs-opus segment agreement mean 0.919, so it is NOT used). Patient audio: 0700 dir, 0600 files; the caller deletes it after the batch.
usage (their venv): cut_batch.py <windows.json> <out_dir> [--workers 4]   windows.json: {"windows":[{"window_id","path"}...]} ; writes <window_id>.flac"""
import datetime as dt, json, os, subprocess, sys
from multiprocessing import Pool
HERE = os.environ.get("STUDIES_DIR", "/tmp/wt-diarlab/studies")
for d in ("2026-09-25-refused-speech", "2026-09-25-readability", "2026-09-25-discarded-speech"): sys.path.insert(0, os.path.join(HERE, d))
import numpy as np
import refused_logic as R
import measure as M
SR = 16000; KEYMAP = None
def init():
    global KEYMAP; os.nice(10); KEYMAP = M.chunk_time_map()
def window_audio_full(rec):
    """Like measure.window_audio but for the window's REAL length (end - start), not a fixed 900 s."""
    win_s = (dt.datetime.fromisoformat(rec["end"]) - dt.datetime.fromisoformat(rec["start"])).total_seconds()
    buf = np.zeros(int(round(win_s * SR)), dtype=np.int16)
    for name, cs, cl in R.chunk_plan(rec):
        a, b = max(cs, 0.0), min(cs + cl, win_s)
        if b <= a: continue
        x = np.frombuffer(M.decode(os.path.join(R.AUDIO_DIR, name), a - cs, b - a), dtype=np.int16)
        i0 = int(round(a * SR)); n = min(len(x), len(buf) - i0); buf[i0:i0 + n] = x[:n]
    return buf
def job(args):
    w, out_dir = args; dst = os.path.join(out_dir, w["window_id"] + ".flac")
    if os.path.exists(dst): return w["window_id"], "exists"
    try:
        rec = M.ensure_timing(R.read_json(os.path.join(R.HOME, w["path"])), KEYMAP); buf = window_audio_full(rec)
        p = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "-", "-c:a", "flac", "-compression_level", "5", "-f", "flac", dst + ".part"],
                           input=buf.astype("<i2").tobytes(), capture_output=True)
        if p.returncode: return w["window_id"], "FAIL ffmpeg"
        os.chmod(dst + ".part", 0o600); os.rename(dst + ".part", dst); return w["window_id"], "ok"
    except Exception as e:
        return w["window_id"], f"FAIL {type(e).__name__}"
if __name__ == "__main__":
    lst, out_dir = sys.argv[1], sys.argv[2]; workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 4
    wins = json.load(open(lst))["windows"]; os.makedirs(out_dir, mode=0o700, exist_ok=True); os.chmod(out_dir, 0o700); ok = fail = 0
    with Pool(workers, initializer=init) as p:
        for wid, st in p.imap_unordered(job, [(w, out_dir) for w in wins]):
            ok += st in ("ok", "exists"); fail += st.startswith("FAIL")
            if st.startswith("FAIL"): print(wid, st, flush=True)
    print(f"done ok {ok} fail {fail}")
