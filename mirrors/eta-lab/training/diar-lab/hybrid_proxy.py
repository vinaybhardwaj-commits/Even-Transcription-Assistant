#!/usr/bin/env python3
"""Hybrid attribution proxy for the Nemotron bake-off. voice_centroid is EMPTY (no enrolled doctors), so real doctor attribution
cannot be tested. Proxy: treat the teacher's (pyannote.ai) speakers in a window as the enrolled identities; embed each speaker's
LONGEST span with the same ECAPA endpoint the hybrid uses (box twin /embed_speakers, localhost); attribute each arm speaker to a teacher
identity by greedy one-to-one cosine (longest talker first, like production); compare with the identity implied by time overlap.
usage: hybrid_proxy.py <out.json>   Audio never leaves this box (localhost twin)."""
import base64, glob, json, os, subprocess, sys, tempfile
from collections import defaultdict
import numpy as np

LAB = os.path.expanduser("~/eta-data/diar-lab"); NEM = os.path.expanduser("~/eta-data/nemotron"); FT = os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-diar-finetune")
BASE = os.environ.get("EMBED_BASE", "http://localhost:8001")
ARMS = {"nemotron3": f"{NEM}/out_bake20_L4.json", "local_stock_3.1": f"{LAB}/out/armA_bake20.json", "local_finetuned": f"{FT}/eval_bake20.json"}

def ref_turns(wid):
    return [{"start_ms": round(s["start"] * 1000), "end_ms": round(s["end"] * 1000), "speaker": s["speaker"]}
            for s in json.load(open(f"{LAB}/data/bake20-ref/{wid}_pyannote.json"))["output"]["diarization"]]

def longest_per_speaker(turns):
    tot, best = defaultdict(float), {}
    for t in turns:
        l = (t["end_ms"] - t["start_ms"]) / 1000; tot[t["speaker"]] += l
        if l > 0 and (t["speaker"] not in best or l > best[t["speaker"]][0]): best[t["speaker"]] = (l, t["start_ms"] / 1000, t["end_ms"] / 1000)
    names = sorted(best); return names, [{"idx": i, "start_s": best[n][1], "end_s": best[n][2], "total_speech_sec": round(tot[n], 1)} for i, n in enumerate(names)], tot

def embed(wav, spk):
    with tempfile.NamedTemporaryFile("w", suffix=".json") as f:
        json.dump(spk, f); f.flush()
        r = subprocess.run(["curl", "-s", "-m", "300", "-F", f"audio=@{wav};type=audio/wav", "-F", f"speakers=<{f.name}",
                            "-F", "clinician_centroids=[]", "-F", "batch_threshold=0.5", f"{BASE}/embed_speakers"], capture_output=True, text=True)
    j = json.loads(r.stdout); assert j.get("ok"), "embed failed"
    return {s["idx"]: np.frombuffer(base64.b64decode(s["embedding_base64"]), dtype=np.float32) for s in j["speakers"] if s.get("embedding_base64")}

def overlap_majority(arm_turns, ref_turns_):
    ov = defaultdict(lambda: defaultdict(float))
    for a in arm_turns:
        for r in ref_turns_:
            o = min(a["end_ms"], r["end_ms"]) - max(a["start_ms"], r["start_ms"])
            if o > 0: ov[a["speaker"]][r["speaker"]] += o / 1000
    return {a: max(d, key=d.get) for a, d in ov.items()}

def cos(a, b): return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))

hyps = {arm: json.load(open(p))["windows"] for arm, p in ARMS.items()}
wids = sorted(set.intersection(*[set(h) for h in hyps.values()]) & {os.path.basename(p)[:-14] for p in glob.glob(f"{LAB}/data/bake20-ref/*_pyannote.json")})
res = {arm: {"agree_time": 0.0, "total_time": 0.0, "agree_spk": 0, "n_spk": 0, "per_window": {}} for arm in ARMS}
MIN_SPEECH = 5.0
for wid in wids:
    wav = f"{LAB}/data/bake20/{wid}.wav"; rt = ref_turns(wid)
    rn, rs, _ = longest_per_speaker(rt); remb = embed(wav, rs)
    for arm, hyp in hyps.items():
        turns = hyp[wid]["turns"]; an, asp, tot = longest_per_speaker(turns); aemb = embed(wav, asp)
        maj = overlap_majority(turns, rt); used, assign = set(), {}
        for i in sorted(range(len(an)), key=lambda i: -tot[an[i]]):                     # longest talker picks first
            if i not in aemb: continue
            cand = [(cos(aemb[i], remb[j]), j) for j in remb if j not in used]
            if cand: c, j = max(cand); used.add(j); assign[an[i]] = rn[j]
        ag_t = tt = ag_s = ns = 0
        for i, n in enumerate(an):
            if tot[n] < MIN_SPEECH or n not in maj: continue
            ok = assign.get(n) == maj[n]; tt += tot[n]; ag_t += tot[n] * ok; ns += 1; ag_s += ok
        r = res[arm]; r["agree_time"] += ag_t; r["total_time"] += tt; r["agree_spk"] += ag_s; r["n_spk"] += ns
        r["per_window"][wid] = {"agree_spk": ag_s, "n_spk": ns}
    print(wid, "done", flush=True)
for arm, r in res.items():
    r["time_weighted_agreement"] = r["agree_time"] / r["total_time"] if r["total_time"] else None
    r["speaker_agreement"] = r["agree_spk"] / r["n_spk"] if r["n_spk"] else None
    print(arm, {k: (round(v, 3) if isinstance(v, float) else v) for k, v in r.items() if k != "per_window"})
json.dump({"note": "proxy: teacher speakers as identities; voice_centroid empty so no doctor attribution possible", "min_speech_sec": MIN_SPEECH, "arms": res}, open(sys.argv[1], "w"), indent=1)
