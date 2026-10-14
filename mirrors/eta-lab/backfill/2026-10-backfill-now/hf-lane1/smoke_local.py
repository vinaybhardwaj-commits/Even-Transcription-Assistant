#!/usr/bin/env python3
"""Local CPU smoke of whisper3_hf_job.py (no HF call: HF_HUB_OFFLINE, cached openai/whisper-tiny; SMOKE=1 is refused on an HF job). Scratch output only; prints char counts and language, never text.
usage: .venv/bin/python smoke_local.py <scratch_out_dir> [n_windows=2]"""
import glob, importlib.util, json, os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__)); out = sys.argv[1]; n = int(sys.argv[2]) if len(sys.argv) > 2 else 2
spec = importlib.util.spec_from_file_location("j", f"{here}/whisper3_hf_job.py"); j = importlib.util.module_from_spec(spec); spec.loader.exec_module(j)
snap = glob.glob(os.path.expanduser("~/.cache/huggingface/hub/models--openai--whisper-tiny/snapshots/*"))[0]; rev = os.path.basename(snap)
H = os.path.expanduser("~/eta-data/hist/windows-reb"); man = [json.loads(l) for l in open(f"{H}/manifest-2026-09-29.jsonl")]
import numpy as np
cand = sorted([w for w in man if os.path.exists(w["audio"]) and not j.is_blind(w) and w["cut"].get("covered_fraction", 0) > 0.7], key=lambda w: -w["cut"]["covered_fraction"])[:12]
def rms(w): x = j.decode_to_16k_mono(w["audio"]); return float(np.sqrt((x ** 2).mean())) if len(x) else 0.0   # choose windows that actually hold speech energy (silent windows prove nothing)
good = sorted(cand, key=lambda w: -rms(w))[:n]
m28 = [json.loads(l) for l in open(f"{H}/manifest-2026-09-28.jsonl")]; bl = next(w for w in m28 if j.is_blind(w))
wins = [{k: w[k] for k in ("win_id", "room", "ist_date", "start", "end", "audio")} for w in good] + [{k: bl[k] for k in ("win_id", "room", "ist_date", "start", "end", "audio")}]
env = dict(os.environ, SMOKE="1", HF_HUB_OFFLINE="1", MODEL_ID="openai/whisper-tiny", MODEL_REVISION=rev, WINDOWS=json.dumps(wins), AUDIO_ROOT="/", OUT_ROOT=out, BATCH="4",
           EXPECT_SCRIPT_SHA16=j.sha256_file(f"{here}/whisper3_hf_job.py")[:16], HELDOUT_SHA16=j.HELDOUT_SHA16, EXPECT_BLIND_SHA16=j.blind_list_sha16(j.BLIND))
aud = out.rstrip("/") + "-audio"; os.makedirs(aud, exist_ok=True)   # flat dir keyed by basename, like the bucket mount
for w in wins:
    L = f"{aud}/{os.path.basename(w['audio'])}"
    if not os.path.lexists(L): subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", w["audio"], "-t", os.environ.get("SMOKE_CROP_S", "180"), "-c", "copy", L], check=True)   # first 180 s only (CPU time); job code unchanged
env["WINDOWS"] = json.dumps(wins); env["AUDIO_ROOT"] = aud
os.makedirs(out, exist_ok=True)
r = subprocess.run([sys.executable, f"{here}/whisper3_hf_job.py"], env=env, capture_output=True, text=True)
print(r.stdout[-1800:]); print("rc", r.returncode, (r.stderr[-400:] if r.returncode else ""))
for f in sorted(glob.glob(f"{out}/*.json")):
    d = json.load(open(f)); print(os.path.basename(f))
    for e, t in d["tracks"].items():
        print("  ", e, t["config_hash"], t["status"], "segs", len(t["segments"]), "chars", sum(len(s["text"]) for s in t["segments"]), "lid", next((s["extras"]["lid"]["detected"] for s in t["segments"] if "lid" in s["extras"]), None))
