"""vj-refuter L4: do the stored ECAPA room-mic centroids pick out their doctor on 18-24 Sep test audio?
For each 15-min test window in OPD 3 / 5 / 7 with audio: embed each production speaker cluster (turns >= 0.8 s, longest first, <= 60 s),
cosine to the room's centroid; report the top cluster, whether it is the production-clinician cluster, and the top-second gap. Reads vj-data files read-only."""
import os, json, base64
os.environ["HF_HUB_CACHE"] = os.path.expanduser("~/vj/refute/hf")
import numpy as np, soundfile as sf, torch
from collections import defaultdict
from speechbrain.inference.speaker import EncoderClassifier
H = os.path.expanduser("~/vj"); SR = 16000
m = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", savedir=f"{H}/refute/ecapa", run_opts={"device": "cpu"})
def cen(f, key):
    v = np.frombuffer(base64.b64decode(json.load(open(f"{H}/centroids/{f}"))[key]), dtype=np.float32); return v / np.linalg.norm(v)
C = {"room_87frpus9": ("Banerjee", cen("animesh-banerjee-opd3.json", "centroid_base64")),
     "room_4ggnkg5x": ("Salanki", cen("salanki-opd5-c270.json", "embedding_base64")),
     "room_qyzghzaf": ("Ankit", cen("ankit-opd7-tonor.json", "embedding_base64"))}
sets = json.load(open(f"{H}/data/sets.json")); turns = json.load(open(f"{H}/data/turns_notext.json"))
out = []
for w, meta in sets["window_meta"].items():
    room = meta["room_id"]
    if room not in C or not os.path.exists(f"{H}/data/audio/{w}.wav") or w not in turns: continue
    doc, c = C[room]; x, sr = sf.read(f"{H}/data/audio/{w}.wav", dtype="float32"); assert sr == SR
    g = defaultdict(list); clin = defaultdict(int); n = defaultdict(int)
    for r in turns[w]:
        if r["speaker_idx"] is None: continue
        n[r["speaker_idx"]] += 1; clin[r["speaker_idx"]] += r["role"] == "clinician"
        if r["e"] - r["s"] >= 0.8: g[r["speaker_idx"]].append((r["s"], r["e"]))
    cos = {}
    for k, lst in g.items():
        pcs, tot = [], 0.0
        for s, e in sorted(lst, key=lambda t: t[0] - t[1]):
            if tot >= 60: break
            pcs.append(x[int(s * SR):int(e * SR)]); tot += e - s
        if tot < 0.8: continue
        with torch.no_grad(): v = m.encode_batch(torch.from_numpy(np.concatenate(pcs))[None]).reshape(-1).numpy()
        cos[k] = float(v @ c / np.linalg.norm(v))
    if not cos: continue
    rk = sorted(cos.items(), key=lambda kv: -kv[1]); prod = max(n, key=lambda k: clin[k] / n[k]) if any(clin.values()) else None
    out.append({"window": w, "room": room, "doctor": doc, "top": rk[0][0], "top_cos": round(rk[0][1], 3), "gap": round(rk[0][1] - rk[1][1], 3) if len(rk) > 1 else None,
                "prod_clinician_cluster": prod, "top_is_prod_clinician": prod == rk[0][0] if prod is not None else None, "n_clusters": len(cos)})
    print(json.dumps(out[-1]), flush=True)
json.dump(out, open(f"{H}/refute/l4_centroid_check.json", "w"), indent=1)
