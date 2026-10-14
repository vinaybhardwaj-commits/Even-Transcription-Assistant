#!/usr/bin/env python3
"""No-training arm D: re-decode Nemotron with different post-processing thresholds (onset/offset, min_duration_on). Model loaded once.
usage: nemo_decode_sweep.py --dirs DIR [DIR...] --out out.json [--nemo-path X.nemo]. Output: {config: {window_id: {turns, n_speakers}}}. No audio/text printed."""
import argparse, glob, json, os, tempfile, time
import torch
from nemo.collections.asr.models import SortformerEncLabelModel
CONFIGS = {"on.50_md0": (0.5, 0.5, 0.0), "on.40_md0": (0.4, 0.4, 0.0), "on.30_md0": (0.3, 0.3, 0.0), "on.50_md.5": (0.5, 0.5, 0.5),
           "on.40_md.5": (0.4, 0.4, 0.5), "on.30_md.5": (0.3, 0.3, 0.5), "on.30_md1": (0.3, 0.3, 1.0), "on.20_md1": (0.2, 0.2, 1.0)}
ap = argparse.ArgumentParser(); ap.add_argument("--dirs", nargs="+", required=True); ap.add_argument("--out", required=True)
ap.add_argument("--model", default="nvidia/Nemotron-3-Diarization"); ap.add_argument("--nemo-path", default=None)
ap.add_argument("--configs", nargs="*", default=None, help="subset of config names")
a = ap.parse_args()
m = (SortformerEncLabelModel.restore_from(a.nemo_path, map_location="cuda") if a.nemo_path else SortformerEncLabelModel.from_pretrained(a.model, map_location="cuda")).eval()
sm = m.sortformer_modules
sm.spkcache_len, sm.fifo_len, sm.chunk_len, sm.chunk_right_context, sm.spkcache_update_period = 264, 40, 340, 40, 300
m._check_streaming_parameters()
wavs = sorted({os.path.basename(p): p for d in a.dirs for p in glob.glob(os.path.join(d, "*.wav"))}.items())
def parse(s):
    if isinstance(s, str): p = s.split(); return float(p[0]), float(p[1]), p[2]
    return float(s[0]), float(s[1]), str(s[2])
res = {}
for name, (on, off, md) in ((k, v) for k, v in CONFIGS.items() if not a.configs or k in a.configs):
    y = tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False)
    y.write(f"parameters:\n  onset: {on}\n  offset: {off}\n  pad_onset: 0.0\n  pad_offset: 0.0\n  min_duration_on: {md}\n  min_duration_off: 0.0\n"); y.close()
    t = time.time(); out = {}
    for wid, p in wavs:
        segs = m.diarize(audio=[p], batch_size=1, postprocessing_yaml=y.name, verbose=False)[0]
        turns = [{"start_ms": round(b * 1000), "end_ms": round(e * 1000), "speaker": s} for b, e, s in map(parse, segs)]
        out[wid[:-4]] = {"turns": turns, "n_speakers": len({x["speaker"] for x in turns})}
    res[name] = out; os.unlink(y.name)
    print(f"# {name} done {time.time()-t:.0f}s", flush=True)
    json.dump({"model": a.nemo_path or a.model, "configs": {k: list(v) for k, v in CONFIGS.items()}, "results": res}, open(a.out, "w"))
