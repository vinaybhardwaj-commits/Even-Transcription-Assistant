#!/usr/bin/env python3
"""337e: cut the WALL-CLOCK audio of vault windows exactly as the transcript saw it (their measure.window_audio: chunk plan, decode, gaps as silence), 16 kHz mono int16 wav, 900 s windows.
Patient audio: 0700 dir, 0600 files, under eta-data; the caller deletes it after use. Read-only use of split-speaker's modules. usage (their venv):
  /home/eta/vad/venv/bin/python cut_audio.py <window_list.json> <out_dir> [--workers 4]     window_list: {"windows":[{"window_id","path"}...]} (reference_set.json works)"""
import json, os, sys, wave
from multiprocessing import Pool
HERE = os.environ.get("STUDIES_DIR", "/tmp/wt-diarlab/studies")
for d in ("2026-09-25-refused-speech", "2026-09-25-readability", "2026-09-25-discarded-speech"): sys.path.insert(0, os.path.join(HERE, d))
import numpy as np
import refused_logic as R
import measure as M
KEYMAP = None
def init():
    global KEYMAP; os.nice(10); KEYMAP = M.chunk_time_map()
def cut(job):
    w, out_dir = job; dst = os.path.join(out_dir, w["window_id"] + ".wav")
    if os.path.exists(dst): return w["window_id"], "exists"
    try:
        rec = M.ensure_timing(R.read_json(os.path.join(R.HOME, w["path"])), KEYMAP)
        buf, cov = M.window_audio(rec, np)
        fd = os.open(dst + ".part", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f, wave.open(f, "wb") as wf:
            wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000); wf.writeframes(buf.astype("<i2").tobytes())
        os.rename(dst + ".part", dst); return w["window_id"], "ok"
    except Exception as e:
        return w["window_id"], f"FAIL {type(e).__name__}"
if __name__ == "__main__":
    lst, out_dir = sys.argv[1], sys.argv[2]; workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 4
    wins = json.load(open(lst))["windows"]
    if "--limit" in sys.argv: wins = wins[:int(sys.argv[sys.argv.index("--limit") + 1])]
    os.makedirs(out_dir, mode=0o700, exist_ok=True); os.chmod(out_dir, 0o700)
    ok = fail = 0
    with Pool(workers, initializer=init) as p:
        for i, (wid, st) in enumerate(p.imap_unordered(cut, [(w, out_dir) for w in wins]), 1):
            ok += st in ("ok", "exists"); fail += st.startswith("FAIL")
            if st.startswith("FAIL"): print(wid, st, flush=True)
            if i % 20 == 0: print(f"{i}/{len(wins)} ok {ok} fail {fail}", flush=True)
    print(f"done ok {ok} fail {fail}")
