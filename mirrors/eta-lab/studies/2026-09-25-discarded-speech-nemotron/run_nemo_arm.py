#!/usr/bin/env python3
"""Cross-check arm N (diar-lab, ruling 347): Nemotron-3-Diarization (offline 30.4 s config, in-process, base weights) on the SAME chunks as split-speaker's frozen 337d diarizer arm D (pyannote 3.1 twin :8001).
Numbers only (no transcript text exists in this arm). It is NOT part of split-speaker's frozen decision rule; it is reported next to arm D and the controls.
Per chunk: union of Nemotron speech seconds and speaker count. Per window: speech fraction of the measured seconds; per group: how many windows reach REAL_FRAC of measured seconds as Nemotron-speech.
usage (NeMo venv, GPU): run_nemo_arm.py <chunk_dir> <out.json> [--delete-audio]"""
import json, os, sys, time, glob
import torch
from nemo.collections.asr.models import SortformerEncLabelModel
REAL_FRAC = 0.20     # the same 20 % of measured seconds split-speaker's frozen rule uses for 'real' (discarded_logic.py); here on Nemotron speech seconds alone
d, out = sys.argv[1], sys.argv[2]; delete = "--delete-audio" in sys.argv
index = json.load(open(os.path.join(d, "index.json")))
m = SortformerEncLabelModel.from_pretrained("nvidia/Nemotron-3-Diarization", map_location="cuda").eval()
sm = m.sortformer_modules; sm.spkcache_len, sm.fifo_len, sm.chunk_len, sm.chunk_right_context, sm.spkcache_update_period = 264, 40, 340, 40, 300; m._check_streaming_parameters()
def union(iv):
    iv = sorted((a, b) for a, b in iv if b > a); tot, cur_a, cur_b = 0.0, None, None
    for a, b in iv:
        if cur_b is None or a > cur_b:
            if cur_b is not None: tot += cur_b - cur_a
            cur_a, cur_b = a, b
        else: cur_b = max(cur_b, b)
    return tot + (cur_b - cur_a if cur_b is not None else 0.0)
parse = lambda s: (float(s.split()[0]), float(s.split()[1]), s.split()[2]) if isinstance(s, str) else (float(s[0]), float(s[1]), str(s[2]))
wins, t0 = {}, time.time()
for i, e in enumerate(index, 1):
    segs = [parse(s) for s in m.diarize(audio=[os.path.join(d, e["file"])], batch_size=1, verbose=False)[0]]
    w = wins.setdefault(e["window_id"], dict(window_id=e["window_id"], group=e["group"], room_id=e["room_id"], measured_s=0.0, nemo_s=0.0, speakers=0, chunks=0))
    w["measured_s"] += e["len_s"]; w["nemo_s"] += union([(a, b) for a, b, _ in segs]); w["speakers"] = max(w["speakers"], len({s for _, _, s in segs})); w["chunks"] += 1
    if i % 50 == 0: print(f"{i}/{len(index)} chunks {time.time() - t0:.0f}s", flush=True)
res = []
for w in wins.values():
    w["nemo_frac"] = round(w["nemo_s"] / w["measured_s"], 3) if w["measured_s"] else 0.0; w["real_nemo_only"] = w["nemo_frac"] >= REAL_FRAC; w["measured_s"] = round(w["measured_s"], 1); w["nemo_s"] = round(w["nemo_s"], 1); res.append(w)
groups = {}
for w in res: g = groups.setdefault(w["group"], dict(windows=0, real=0)); g["windows"] += 1; g["real"] += w["real_nemo_only"]
json.dump(dict(model="nvidia/Nemotron-3-Diarization", config="offline 30.4s", real_frac=REAL_FRAC, chunks=len(index), audio_s=round(sum(e["len_s"] for e in index), 1), groups=groups, windows=res), open(out, "w"), indent=1)
print(json.dumps(groups)); print("wrote", out)
if delete:
    for e in index: os.unlink(os.path.join(d, e["file"]))
    print("chunk audio deleted")
