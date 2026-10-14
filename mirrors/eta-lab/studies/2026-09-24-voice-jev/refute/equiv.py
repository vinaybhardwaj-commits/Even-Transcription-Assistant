"""vj-refuter: box GPU (prod install) per-turn ECAPA vs my CPU ECAPA on 20 random turns (seed 24092026). Same crop rule: turn >= 0.8 s, first 20 s."""
import os, json, random
os.environ["HF_HUB_CACHE"] = os.path.expanduser("~/vj/refute/hf")
import numpy as np, soundfile as sf, torch
from speechbrain.inference.speaker import EncoderClassifier
H = os.path.expanduser("~/vj"); SR = 16000
m = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", savedir=f"{H}/refute/ecapa", run_opts={"device": "cpu"})
box = json.load(open(f"{H}/refute/turn_vecs_rooms_box.json")); turns = json.load(open(f"{H}/data/turns_notext.json"))
where = {r["source_ref"]: (w, r["s"], r["e"]) for w, rows in turns.items() for r in rows}
keys = random.Random(24092026).sample(sorted(k for k in box if k in where), 20); cs = []
for k in keys:
    w, s, e = where[k]; x, _ = sf.read(f"{H}/data/audio/{w}.wav", dtype="float32")
    with torch.no_grad(): v = m.encode_batch(torch.from_numpy(x[int(s * SR):int(min(e, s + 20) * SR)])[None]).reshape(-1).numpy()
    b = np.array(box[k]); cs.append(float(v @ b / np.linalg.norm(v) / np.linalg.norm(b)))
print("n", len(cs), "min", round(min(cs), 4), "median", round(float(np.median(cs)), 4), "all>=0.99", all(c >= 0.99 for c in cs))
