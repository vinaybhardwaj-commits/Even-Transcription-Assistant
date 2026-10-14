"""vj-refuter L4b: per-TURN ECAPA (turns >= 3 s, crop 20 s) vs the room's stored centroid, on the 15 OPD 3/5/7 test windows.
If the doctor speaks in the window, some turns should score high even if production clusters are impure. Reports max, p90, n>=0.5 per window, and per room-day."""
import os, json, base64, datetime
os.environ["HF_HUB_CACHE"] = os.path.expanduser("~/vj/refute/hf")
import numpy as np, soundfile as sf, torch
from speechbrain.inference.speaker import EncoderClassifier
H = os.path.expanduser("~/vj"); SR = 16000
m = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", savedir=f"{H}/refute/ecapa", run_opts={"device": "cpu"})
def cen(f, k): v = np.frombuffer(base64.b64decode(json.load(open(f"{H}/centroids/{f}"))[k]), dtype=np.float32); return v / np.linalg.norm(v)
C = {"room_87frpus9": ("Banerjee", cen("animesh-banerjee-opd3.json", "centroid_base64")), "room_4ggnkg5x": ("Salanki", cen("salanki-opd5-c270.json", "embedding_base64")),
     "room_qyzghzaf": ("Ankit", cen("ankit-opd7-tonor.json", "embedding_base64"))}
ALL = {v[0]: v[1] for v in C.values()}
sets = json.load(open(f"{H}/data/sets.json")); turns = json.load(open(f"{H}/data/turns_notext.json")); out = []
for w, meta in sorted(sets["window_meta"].items()):
    room = meta["room_id"]
    if room not in C or not os.path.exists(f"{H}/data/audio/{w}.wav") or w not in turns: continue
    doc, c = C[room]; x, _ = sf.read(f"{H}/data/audio/{w}.wav", dtype="float32")
    sc, best_other, clin = [], [], []
    for r in turns[w]:
        if r["e"] - r["s"] < 3: continue
        with torch.no_grad(): v = m.encode_batch(torch.from_numpy(x[int(r["s"] * SR):int(min(r["e"], r["s"] + 20) * SR)])[None]).reshape(-1).numpy()
        v /= np.linalg.norm(v); s = float(v @ c); sc.append(s); best_other.append(max(float(v @ u) for d, u in ALL.items() if d != doc))
        if r["role"] == "clinician": clin.append((s, r.get("clinician_id")))
    if not sc: continue
    day = (datetime.datetime.utcfromtimestamp(int(w.split("_")[2]) / 1000) + datetime.timedelta(hours=5, minutes=30)).strftime("%Y-%m-%d")
    o = {"window": w, "day": day, "room_doctor_centroid": doc, "n_turns_3s": len(sc), "max": round(max(sc), 3), "p90": round(float(np.percentile(sc, 90)), 3),
         "n_ge_0.5": sum(s >= 0.5 for s in sc), "max_other_doctor_centroid": round(max(best_other), 3),
         "prod_clinician_turns": len(clin), "prod_clinician_ids": sorted({i for _, i in clin if i}), "prod_clinician_mean_cos": round(float(np.mean([s for s, _ in clin])), 3) if clin else None}
    out.append(o); print(json.dumps(o), flush=True)
json.dump(out, open(f"{H}/refute/l4b_turns.json", "w"), indent=1)
