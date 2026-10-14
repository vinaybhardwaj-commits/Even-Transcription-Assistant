#!/usr/bin/env python3
"""IndicConformer-600M (pinned e9b71b3, RNNT) on eta-lab-l4, one 16 kHz mono WAV per call, language REQUIRED.
  ~/eta-lab-night/indic-mt/venv/bin/python ic_file.py FILE.wav kn [rnnt|ctc]   -> the LAST stdout line is JSON {"text","language","decoding","sec"} (the model prints warnings above it: use tail -1)
Same windowing as the Mini's indic_server.py (whole file <= 35 s, else 30 s windows + 0.5 s overlap). Convert other formats on the box first:
  ffmpeg -i in.webm -ac 1 -ar 16000 out.wav   (l4 has no ffmpeg). Output is patient text: keep it out of git, logs and chat."""
import json, os, sys, time
os.environ.setdefault("HF_HOME", os.path.expanduser("~/models/indicconformer-e9b71b3")); os.environ["HF_HUB_OFFLINE"] = "1"
import torch, soundfile as sf
from transformers import AutoModel
f, lang = sys.argv[1], sys.argv[2]; dec = sys.argv[3] if len(sys.argv) > 3 else "rnnt"
M = AutoModel.from_pretrained("ai4bharat/indic-conformer-600m-multilingual", trust_remote_code=True); M.eval()
d, sr = sf.read(f, dtype="float32")
if d.ndim > 1: d = d.mean(axis=1)
assert sr == 16000, "need 16 kHz mono wav"
t0 = time.time(); texts = []
def run(x):
    with torch.no_grad(): o = M(torch.from_numpy(x).unsqueeze(0), lang, dec)
    return o if isinstance(o, str) else (o[0] if o else "")
if len(d) / sr <= 35: texts = [run(d)]
else:
    s = 0.0
    while s < len(d) / sr:
        texts.append(run(d[int(s * sr): int((s + 30.5) * sr)])); s += 30.0
print(json.dumps({"text": " ".join(t.strip() for t in texts if t.strip()), "language": lang, "decoding": dec, "sec": round(time.time() - t0, 2)}, ensure_ascii=False))
