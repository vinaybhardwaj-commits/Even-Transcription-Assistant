#!/usr/bin/env python3
"""retrans_l4.py — ruling 343 (hist-bulk): direct retranscription of the untested skipped windows ON eta-lab-l4, NO router.
Engines, both installed on l4 by indic-mt (ruling 349 / #1985): faster-whisper large-v3 (CUDA fp16, language AUTO per 30 s chunk, no VAD, condition_on_previous_text False, beam 5, no_speech_threshold 0.7)
and IndicConformer-600M (pinned e9b71b3, RNNT, CPU) for chunks whose detected language is an Indic one. NOT the production router: no SraVaani, no fuse, no shim guards; whisper is faster-whisper large-v3, not whisper.cpp turbo.
Each 900 s window wav (16 kHz mono) is cut into 30 s chunks; per chunk the record keeps BOTH engines' raw outputs. Output holds patient text: results_retrans.jsonl 0600, stays on l4 and the box, never in git/logs/chat.
Run under `flock ~/gpu.lock` (serialises with the other l4 jobs).  usage: retrans_l4.py <dir with manifest.jsonl + <id>.wav>"""
import json, os, sys, time
d = sys.argv[1]; SR = 16000; CH = 30.0
INDIC = {"as","bn","gu","hi","kn","ml","mr","ne","or","pa","sa","ta","te","ur","mai","kok","sd","ks","doi","brx","mni","sat"}
os.environ.setdefault("HF_HOME", os.path.expanduser("~/models/indicconformer-e9b71b3")); os.environ["HF_HUB_OFFLINE"] = "1"
import numpy as np, soundfile as sf
from faster_whisper import WhisperModel
wm = WhisperModel("large-v3", device="cuda", compute_type="float16", download_root=os.path.expanduser("~/.cache/huggingface/hub"), local_files_only=True)   # whisper from the default cache; HF_HOME above points at the IndicConformer dir
import torch
from transformers import AutoModel
ic = AutoModel.from_pretrained("ai4bharat/indic-conformer-600m-multilingual", trust_remote_code=True); ic.eval()
def indic(chunk, lang):
    with torch.no_grad(): out = ic(torch.from_numpy(chunk).unsqueeze(0), lang, "rnnt")
    return out if isinstance(out, str) else (out[0] if out else "")
out = os.path.join(d, "results_retrans.jsonl"); done = {json.loads(l)["id"] for l in open(out)} if os.path.exists(out) else set()
with open(out, "a") as fo:
    os.chmod(out, 0o600)
    for line in open(os.path.join(d, "manifest.jsonl")):
        mf = json.loads(line)
        if mf["id"] in done: continue
        t0 = time.time(); data, sr = sf.read(os.path.join(d, mf["id"] + ".wav"), dtype="float32")
        assert sr == SR
        if data.ndim > 1: data = data.mean(axis=1)
        chunks = []
        for s in np.arange(0, len(data) / SR, CH):
            c = data[int(s * SR): int((s + CH) * SR)]
            rms = float(np.sqrt(np.mean(c ** 2))) if len(c) else 0.0
            rec = {"start_s": float(s), "end_s": float(min(s + CH, len(data) / SR)), "rms": round(rms, 6)}
            if rms < 1e-6:   # digital zero: nothing to decode (recorded, not skipped silently)
                rec["whisper"] = {"skipped": "digital_zero_chunk"}; chunks.append(rec); continue
            segs, info = wm.transcribe(c, language=None, beam_size=5, condition_on_previous_text=False, vad_filter=False, no_speech_threshold=0.7)
            segs = list(segs)
            rec["whisper"] = {"lang": info.language, "lang_p": round(info.language_probability, 3), "text": " ".join(x.text.strip() for x in segs).strip(),
                              "no_speech_prob": round(max((x.no_speech_prob for x in segs), default=0.0), 3), "avg_logprob": round(sum(x.avg_logprob for x in segs) / len(segs), 3) if segs else None}
            if info.language in INDIC and len(c) >= SR // 2:
                try: rec["indicconformer"] = {"lang": info.language, "text": indic(c, info.language).strip()}
                except Exception as e: rec["indicconformer"] = {"lang": info.language, "error": repr(e)[:160]}
            chunks.append(rec)
        fo.write(json.dumps({"id": mf["id"], "engines": ["faster-whisper/large-v3 cuda fp16 auto-lang", "indicconformer-600m-e9b71b3 rnnt cpu (Indic chunks only)"], "chunk_s": CH,
                             "chunks": chunks, "elapsed_s": round(time.time() - t0, 1)}, ensure_ascii=False) + "\n"); fo.flush()
print(json.dumps({"windows": len(open(os.path.join(d, "manifest.jsonl")).readlines()), "out": out}))
