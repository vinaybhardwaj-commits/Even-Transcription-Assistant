"""vj-refuter ruling 182 controls, my pipeline: each enrol WAV -> ECAPA (whole clip, and mean of 3 s chunks) vs every stored centroid."""
import os, json, base64
os.environ["HF_HUB_CACHE"] = os.path.expanduser("~/vj/refute/hf")
import numpy as np, soundfile as sf, torch, torchaudio
from speechbrain.inference.speaker import EncoderClassifier
H = os.path.expanduser("~/vj"); m = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", savedir=f"{H}/refute/ecapa", run_opts={"device": "cpu"})
def cen(f, k): v = np.frombuffer(base64.b64decode(json.load(open(f"{H}/centroids/{f}"))[k]), dtype=np.float32); return v / np.linalg.norm(v)
C = {"banerjee": cen("animesh-banerjee-opd3.json", "centroid_base64"), "salanki": cen("salanki-opd5-c270.json", "embedding_base64"),
     "ankit_tonor": cen("ankit-opd7-tonor.json", "embedding_base64"), "ankit_pwa": cen("ankit-pwa.json", "embedding_base64")}
W = {"banerjee": "animesh-opd3-enroll-clean-100s.wav", "salanki": "salanki-opd5-c270-enroll-clean.wav", "ankit_tonor": "ankit-opd7-tonor-enroll-clean.wav", "ankit_pwa": "ankit-pwa-enroll-clean.wav"}
def emb(x):
    with torch.no_grad(): v = m.encode_batch(torch.from_numpy(x)[None]).reshape(-1).numpy()
    return v / np.linalg.norm(v)
res = {}
for who, f in W.items():
    x, sr = sf.read(f"{H}/centroids/{f}", dtype="float32")
    if x.ndim > 1: x = x.mean(1)
    if sr != 16000: x = torchaudio.functional.resample(torch.from_numpy(x), sr, 16000).numpy()
    whole = emb(x); ch = [emb(x[i:i + 48000]) for i in range(0, len(x) - 48000 + 1, 48000)]
    mean = np.mean(ch, 0); mean /= np.linalg.norm(mean)
    res[who] = {"sr": sr, "dur": round(len(x) / 16000, 1), "whole": {c: round(float(whole @ v), 3) for c, v in C.items()}, "chunkmean3s": {c: round(float(mean @ v), 3) for c, v in C.items()}}
    print(who, json.dumps(res[who]), flush=True)
json.dump(res, open(f"{H}/refute/controls.json", "w"), indent=1)
