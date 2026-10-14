#!/usr/bin/env python3
"""Compare /diarize on the pyannote twin (:8001) and the Nemotron endpoint (:8002): same keys/types, speaker count vs V, latency."""
import json, os, subprocess, sys, tempfile
import httpx
V = {"bw_yce79u6r_1789999200000_primary": 4, "bw_d4t5tvg9_1789986600000_primary": 7, "bw_maaacrdh_1790058600000_primary": 5,
     "bw_zyjykmwa_1790057700000_primary": 3, "bw_m6nq7upz_1790057700000_primary": 4}
def shape(o):
    if isinstance(o, dict): return {k: shape(v) for k, v in sorted(o.items())}
    if isinstance(o, list): return [shape(o[0])] if o else []
    return type(o).__name__
def keys_diff(a, b, path=""):
    out = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a: out.append(f"{path}/{k}: only in nemotron")
            elif k not in b: out.append(f"{path}/{k}: only in pyannote-twin")
            else: out += keys_diff(a[k], b[k], f"{path}/{k}")
    elif isinstance(a, list) and isinstance(b, list) and a and b: out += keys_diff(a[0], b[0], path + "[]")
    return out
for wid, v in V.items():
    wav = os.path.expanduser(f"~/eta-data/nemotron/v5/{wid}.wav")
    with tempfile.NamedTemporaryFile(suffix=".webm") as t:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", "-b:a", "24k", "-f", "webm", t.name], check=True)
        raw = open(t.name, "rb").read()
    res = {}
    for name, port in (("pyannote-twin", 8001), ("nemotron", 8002)):
        r = httpx.post(f"http://127.0.0.1:{port}/diarize", files={"audio": ("a.webm", raw, "audio/webm")}, data={"encounter_id": wid}, timeout=900)
        res[name] = r.json(); res[name]["_status"] = r.status_code
    sh = {k: shape({kk: vv for kk, vv in d.items() if kk != "_status"}) for k, d in res.items()}
    diffs = [d for d in keys_diff(sh["nemotron"], sh["pyannote-twin"]) if "model_versions" not in d]
    print(json.dumps({"window": wid[3:11], "V_count": v, "status": [res[k]["_status"] for k in res],
                      "n_speakers": {k: len(d["speakers"]) for k, d in res.items()}, "latency_ms": {k: d["latency_ms"] for k, d in res.items()},
                      "types": {k: sorted(s["type"] for s in d["speakers"]) for k, d in res.items()}, "shape_diffs": diffs}))
