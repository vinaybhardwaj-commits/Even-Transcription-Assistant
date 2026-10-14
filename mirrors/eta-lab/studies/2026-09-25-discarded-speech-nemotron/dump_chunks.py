#!/usr/bin/env python3
"""Cross-check arm N for ruling 337d/347 (diar-lab): dump the EXACT chunk audio of split-speaker's frozen plan (studies/2026-09-25-discarded-speech, plan.json) as 16 kHz mono wavs so a
DIFFERENT diarizer (Nemotron-3) can be run on the same spans. Read-only use of their modules and files; the frozen plan is not touched. Patient audio: written to a 0700 dir under eta-data, 0600 files,
deleted by run_nemo_arm.py after use. usage (their venv): /home/eta/vad/venv/bin/python dump_chunks.py <plan.json> <out_dir>"""
import json, os, sys, wave
HERE = os.environ.get("STUDIES_DIR", "/tmp/wt-diarlab/studies")   # a checkout at or after the frozen 337d commit (the shared box checkout is stale)
for d in ("2026-09-25-refused-speech", "2026-09-25-readability", "2026-09-25-discarded-speech"): sys.path.insert(0, os.path.join(HERE, d))
import numpy as np
import refused_logic as R
import measure as M
plan_path, out_dir = sys.argv[1], sys.argv[2]
os.makedirs(out_dir, mode=0o700, exist_ok=True); os.chmod(out_dir, 0o700)
plan = R.read_json(plan_path); keymap = M.chunk_time_map(); index = []
for w in plan["windows"]:
    rec = M.ensure_timing(R.read_json(os.path.join(R.HOME, w["path"])), keymap)
    buf, _cov = M.window_audio(rec, np)
    for (a, b) in w["chunks"]:
        pcm = buf[int(a * 16000):int(b * 16000)]
        name = f"{w['window_id']}__{a:.1f}_{b:.1f}.wav"
        fd = os.open(os.path.join(out_dir, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f, wave.open(f, "wb") as wf:
            wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000)
            wf.writeframes((np.clip(pcm, -1, 1) * 32767).astype("<i2").tobytes() if pcm.dtype.kind == "f" else pcm.astype("<i2").tobytes())
        index.append(dict(window_id=w["window_id"], group=w["group"], room_id=w["room_id"], span=[a, b], file=name, len_s=b - a))
    print(w["window_id"], len(w["chunks"]), flush=True)
fd = os.open(os.path.join(out_dir, "index.json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f: json.dump(index, f)
print("chunks:", len(index), "audio_s:", round(sum(x["len_s"] for x in index), 1))
