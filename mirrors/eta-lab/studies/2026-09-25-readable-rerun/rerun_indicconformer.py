#!/usr/bin/env python3
"""337c arm B (eta-lab-l4): IndicConformer-600M, the production model files (pinned e9b71b3, copied from the Mini per ruling
349, no HF token moved), RNNT decoding as production runs it (INDIC_DECODING=rnnt), language = manifest force_lang.
Mirrors the Mini's indic_server.py: whole file if <= 35 s, else 30 s windows + 0.5 s overlap; a failing window is skipped.
Output results_indicconformer.jsonl beside the wavs (patient text: 0600, never in git/logs/chat).
runtime note: onnxruntime 1.23.2 here (the Mini has 1.26.0, not published for Linux py3.10); same ONNX files."""
import argparse, json, os, sys, time
os.environ.setdefault("HF_HOME", os.path.expanduser("~/models/indicconformer-e9b71b3"))
os.environ["HF_HUB_OFFLINE"] = "1"
import torch, soundfile as sf
from transformers import AutoModel

ap = argparse.ArgumentParser()
ap.add_argument("dir")
ap.add_argument("--decoding", default="rnnt")
a = ap.parse_args()
SR, WIN, OVL, MAXWIN = 16000, 30.0, 0.5, 35.0
IN22 = {"as","bn","brx","doi","gu","hi","kn","kok","ks","mai","ml","mni","mr","ne","or","pa","sa","sat","sd","ta","te","ur","en"}
M = AutoModel.from_pretrained("ai4bharat/indic-conformer-600m-multilingual", trust_remote_code=True); M.eval()

def run(data, lang):
    wav = torch.from_numpy(data).unsqueeze(0)
    with torch.no_grad():
        out = M(wav, lang, a.decoding)
    return out if isinstance(out, str) else (out[0] if out else "")

out = os.path.join(a.dir, "results_indicconformer.jsonl")
done = {json.loads(l)["id"] for l in open(out)} if os.path.exists(out) else set()
n = 0
with open(out, "a") as fo:
    os.chmod(out, 0o600)
    for line in open(os.path.join(a.dir, "manifest.jsonl")):
        mf = json.loads(line)
        if mf["id"] in done:
            continue
        lang = mf.get("force_lang")
        if lang not in IN22:
            fo.write(json.dumps({"id": mf["id"], "engine": "indicconformer-600m-e9b71b3/" + a.decoding, "forced": lang, "text": "", "skipped": "no_supported_language"}) + "\n")
            continue
        t0 = time.time()
        data, sr = sf.read(os.path.join(a.dir, mf["id"] + ".wav"), dtype="float32")
        if data.ndim > 1:
            data = data.mean(axis=1)
        dur = len(data) / SR
        texts, err = [], None
        if dur <= MAXWIN:
            try: texts = [run(data, lang)]
            except Exception as e: err = repr(e)[:200]
        else:
            s = 0.0
            while s < dur:
                chunk = data[int(s * SR): int((s + WIN + OVL) * SR)]
                try: texts.append(run(chunk, lang))
                except Exception as e: err = repr(e)[:200]
                s += WIN
        fo.write(json.dumps({"id": mf["id"], "engine": "indicconformer-600m-e9b71b3/" + a.decoding, "forced": lang,
                             "text": " ".join(t.strip() for t in texts if t.strip()), "error": err,
                             "elapsed_s": round(time.time() - t0, 2)}, ensure_ascii=False) + "\n")
        fo.flush(); n += 1
print(json.dumps({"segments": n, "out": out}))
