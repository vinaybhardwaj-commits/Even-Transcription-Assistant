# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "torch",
#   "transformers==4.46.3",
#   "accelerate",
#   "huggingface_hub",
#   "soundfile",
#   "av",
#   "numpy<2.3",
# ]
# ///
"""[HF-LANE1 whisper3] REB stt-layer compute: openai/whisper-large-v3-turbo (pinned revision), THREE configs per window with ONE model load:
stt.whisper-forced-en a2131b2d, stt.whisper-cap2 c7bd317b, stt.whisper-auto 4b67551a (config dicts + hashes identical to the box tracks, asserted below).
COMPUTE ONLY: writes <OUT_ROOT>/<win_id>.json = {manifest_stub, tracks:{engine: reb.track.v1}} (atomic, write-once); the box-side collect_lane.py calls reb.writer.write_track.
Fail closed, exit non-zero BEFORE any audio is read or model loaded, on: own sha16 != EXPECT_SCRIPT_SHA16, heldout sha16 != the pinned one, embedded blind list sha16 != EXPECT_BLIND_SHA16,
model id not allow-listed, revision != MODEL_REVISION. A blind or unparseable window is refused BEFORE its audio file is opened. Prints counts only, never transcript text.
Runtime differs from the box (whisper.cpp ggml-large-v3-turbo): transformers generate() with the same temperature ladder; recorded in track['provenance']['runtime']."""
import hashlib, json, os, re, sys, time
from datetime import datetime, timedelta, timezone

HELDOUT_SHA16 = "f672c1ef046089dd"             # heldout.py, pinned by the launcher too
BLIND_UNION_SHA8 = "f07171dc"                  # heldout.load_union() id
BLIND = {("2026-08-23", "room_qyzghzaf"), ("2026-09-13", "room_ux92qpws"), ("2026-09-14", "room_ux92qpws"),
         ("2026-09-15", "room_qyzghzaf"), ("2026-09-16", "room_ux92qpws"), ("2026-09-18", "room_qyzghzaf"),
         ("2026-09-19", "room_ux92qpws"), ("2026-09-20", "room_ux92qpws"), ("2026-09-20", "room_qyzghzaf"),
         ("2026-09-23", "room_4ggnkg5x"), ("2026-09-23", "room_qyzghzaf"), ("2026-09-26", "room_ux92qpws"),
         ("2026-09-28", "room_ux92qpws"), ("2026-09-28", "room_qyzghzaf")}
ALLOWED_MODELS = {"openai/whisper-large-v3-turbo"}
SMOKE_MODELS = {"openai/whisper-tiny"}         # only with SMOKE=1 and NOT on an HF job
IST = timezone(timedelta(hours=5, minutes=30))
VERSION = "v1"; MODEL_NAME = "whisper-large-v3-turbo"
CAP2_PROMPT = "Clinical terms: hypertension, diabetes mellitus, tablet, capsule, mg, milligram, BP, blood pressure, ECG, echocardiogram, metformin, amlodipine, atorvastatin, telmisartan, HbA1c, creatinine, thyroid, TSH, prescription, follow-up, dosage, twice daily, once daily, before food, after food, OPD, consultation, symptoms, fever, cough, cold, chest pain, shortness of breath, angiography, stent, bypass."
_BASE = {"response_format": "verbose_json", "temperature": 0.0, "temperature_inc": 0.2}
BOX_HASHES = {"whisper-forced-en": "a2131b2d", "whisper-cap2": "c7bd317b", "whisper-auto": "4b67551a"}   # the BOX tracks' ids: HF output must NEVER carry these (HF-1b F1)
BOX_CONFIGS = {   # the box (whisper.cpp) config dicts, byte-for-byte as in the existing REB tracks; hashes asserted
    "whisper-forced-en": {"language": "en", **_BASE},
    "whisper-cap2": {"language": "en", "prompt": CAP2_PROMPT, "prompt_source": "placeholder", **_BASE},
    "whisper-auto": {"language": "auto", **_BASE},
}
PINNED_REVISION = "41f01f3fe87f28c78e2fbf8b568835947dd65ed9"   # openai/whisper-large-v3-turbo; part of the config identity
PRODUCER = {"producer": "transformers-fp16-hf", "chunk_s": 30, "condition_on_prev": False, "lid": "first-30s-logits",
            "model_id": "openai/whisper-large-v3-turbo", "model_revision": PINNED_REVISION}
def lane_configs(): return {e: {**c, **PRODUCER} for e, c in BOX_CONFIGS.items()}   # HF-1b F1: box dict + producer fields => its OWN hashes
LANE_HASHES = {"whisper-forced-en": "e0d31902", "whisper-cap2": "5a550766", "whisper-auto": "2e3b6c81"}
CONFIGS = {e: (c, LANE_HASHES[e]) for e, c in lane_configs().items()}   # engine -> (config, hash); hashes asserted in startup_checks
TEMPS = (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)

def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()

def config_hash(c): return hashlib.sha256(json.dumps(c or {}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:8]

def blind_list_sha16(blind): return hashlib.sha256(json.dumps(sorted([d, r] for d, r in blind)).encode()).hexdigest()[:16]

def is_blind(w):
    """Same predicate as runner.py _blind: IST day of start and of end-1s, plus ist_date, plus the day in the window id; any failure = blind (fail closed)."""
    try:
        st = datetime.fromisoformat(w["start"].replace("Z", "+00:00")).astimezone(IST)
        en = datetime.fromisoformat(w["end"].replace("Z", "+00:00")).astimezone(IST) - timedelta(seconds=1)
        m = re.search(r"(\d{4}-\d{2}-\d{2})_room_[a-z0-9]+_\d{4}", w["win_id"])
        if not m: return True
        days = {st.date().isoformat(), en.date().isoformat(), w["ist_date"], m.group(1)}
        return any((d, w["room"]) in BLIND for d in days)
    except Exception:
        return True

def startup_checks(env=os.environ, blind=BLIND, script_path=None):
    """Raises SystemExit(non-zero message) on any mismatch; nothing is read or written before this passes."""
    own = sha256_file(script_path or __file__)[:16]
    if own != env.get("EXPECT_SCRIPT_SHA16"): raise SystemExit(f"REFUSED: script sha16 {own} != EXPECT_SCRIPT_SHA16")
    if env.get("HELDOUT_SHA16") != HELDOUT_SHA16: raise SystemExit("REFUSED: HELDOUT_SHA16 not the pinned f672c1ef046089dd")
    if len(blind) != 14 or blind_list_sha16(blind) != env.get("EXPECT_BLIND_SHA16"): raise SystemExit("REFUSED: embedded blind list sha16 != EXPECT_BLIND_SHA16 (or not 14 entries)")
    mid = env.get("MODEL_ID", "")
    smoke = env.get("SMOKE") == "1" and not env.get("HF_JOB_ID")
    if mid not in ALLOWED_MODELS and not (smoke and mid in SMOKE_MODELS): raise SystemExit(f"REFUSED: model {mid!r} not allow-listed")
    if not re.fullmatch(r"[0-9a-f]{40}", env.get("MODEL_REVISION", "")): raise SystemExit("REFUSED: MODEL_REVISION must be a 40-hex commit sha")
    if not smoke and env["MODEL_REVISION"] != PINNED_REVISION: raise SystemExit("REFUSED: MODEL_REVISION != the revision pinned in the job (part of the track identity)")
    for eng, c in BOX_CONFIGS.items():
        if config_hash(c) != BOX_HASHES[eng]: raise SystemExit(f"REFUSED: box config copy for {eng} hashes to {config_hash(c)} != {BOX_HASHES[eng]}")
    for eng, (cfg, h) in CONFIGS.items():
        if config_hash(cfg) != h: raise SystemExit(f"REFUSED: lane config hash for {eng} is {config_hash(cfg)} != {h}")
        if h == BOX_HASHES[eng]: raise SystemExit(f"REFUSED: lane hash for {eng} equals the box hash")
    return smoke

def decode_to_16k_mono(src):
    import av, numpy as np
    c = av.open(src); st = next(s for s in c.streams if s.type == "audio")
    rs = av.AudioResampler(format="fltp", layout="mono", rate=16000)
    ch = [r.to_ndarray().reshape(-1) for fr in c.decode(st) for r in rs.resample(fr)]; c.close()
    return np.concatenate(ch).astype("float32") if ch else np.zeros(0, dtype="float32")

def parse_iso_ms(s): return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)

class Engine:
    def __init__(self, model_id, revision, smoke):
        import torch
        from transformers import WhisperForConditionalGeneration, WhisperProcessor
        from huggingface_hub import snapshot_download
        self.torch = torch; self.dev = "cpu" if smoke else "cuda"; self.dtype = torch.float32 if smoke else torch.float16
        path = snapshot_download(model_id, revision=revision, local_files_only=smoke)
        if os.path.basename(path.rstrip("/")) != revision: raise SystemExit(f"REFUSED: resolved snapshot {os.path.basename(path)} != MODEL_REVISION")
        self.proc = WhisperProcessor.from_pretrained(path); self.model = WhisperForConditionalGeneration.from_pretrained(path, torch_dtype=self.dtype).to(self.dev).eval()
        self.lang_ids = {k[2:-2]: v for k, v in self.model.generation_config.lang_to_id.items()}
        self.prompt_ids = self.proc.get_prompt_ids(CAP2_PROMPT.strip(), return_tensors="pt").to(self.dev)
        self.batch = int(os.environ.get("BATCH", "8"))
    def detect(self, x):
        """whisper.cpp 'auto' detects once on the first 30 s; same here. Returns (code, p, top4 probs)."""
        torch = self.torch
        f = self.proc(x[:480000], sampling_rate=16000, return_tensors="pt").input_features.to(self.dev, self.dtype)
        sot = self.proc.tokenizer.convert_tokens_to_ids("<|startoftranscript|>")
        with torch.no_grad(): lg = self.model(input_features=f, decoder_input_ids=torch.tensor([[sot]], device=self.dev)).logits[0, -1].float()
        codes = list(self.lang_ids); pr = torch.softmax(lg[[self.lang_ids[c] for c in codes]], dim=0).cpu().tolist()
        top = sorted(zip(codes, pr), key=lambda t: -t[1])[:4]
        return top[0][0], top[0][1], {c: p for c, p in top}
    def run(self, chunks, language, prompt):
        """chunks: [(c0, c1, np.float32)] 30 s slices; returns segment list. temperature ladder + thresholds as the box server (no-speech 0.7)."""
        torch = self.torch; segs = []
        for i in range(0, len(chunks), self.batch):
            part = chunks[i:i + self.batch]
            f = self.proc([c[2] for c in part], sampling_rate=16000, return_tensors="pt", return_attention_mask=True)
            kw = dict(language=language, task="transcribe", temperature=TEMPS, compression_ratio_threshold=2.4, logprob_threshold=-1.0, no_speech_threshold=0.7,
                      condition_on_prev_tokens=False, return_timestamps=True)
            if prompt: kw["prompt_ids"] = self.prompt_ids
            with torch.no_grad():
                out = self.model.generate(input_features=f.input_features.to(self.dev, self.dtype), attention_mask=f.attention_mask.to(self.dev), **kw)
            dec = self.proc.batch_decode(out, skip_special_tokens=True, output_offsets=True)
            for (c0, c1, _), d in zip(part, dec):
                offs = [o for o in (d.get("offsets") or []) if (o.get("text") or "").strip()]
                if offs:
                    for o in offs:
                        a, b = o["timestamp"]; b = b if b is not None else (c1 - c0) / 16000.0
                        segs.append({"t0_ms": int(c0 / 16 + a * 1000), "t1_ms": int(c0 / 16 + max(a, b) * 1000), "text": o["text"].strip(), "extras": {}})
                elif (d.get("text") or "").strip():
                    segs.append({"t0_ms": int(c0 / 16), "t1_ms": int(c1 / 16), "text": d["text"].strip(), "extras": {"granularity": "chunk"}})
        return segs

def main():
    smoke = startup_checks()
    WINDOWS = json.loads(os.environ["WINDOWS"]); AUDIO_ROOT = os.environ.get("AUDIO_ROOT", "/mnt/audio"); OUT_ROOT = os.environ.get("OUT_ROOT", "/mnt/out")
    os.makedirs(OUT_ROOT, exist_ok=True)
    eng = Engine(os.environ["MODEL_ID"], os.environ["MODEL_REVISION"], smoke)
    machine = "hf-job:" + (os.environ.get("HF_JOB_ID") or os.environ.get("HOSTNAME") or "unknown")
    prov = {"runtime": {"impl": "transformers-generate", "model_id": os.environ["MODEL_ID"], "model_revision": os.environ["MODEL_REVISION"], "dtype": str(eng.dtype), "device": eng.dev,
                        "differs_from_box": "box tracks = whisper.cpp ggml-large-v3-turbo + --no-speech-thold 0.7 --suppress-nst"},
            "script_sha16": os.environ["EXPECT_SCRIPT_SHA16"], "heldout_sha16": HELDOUT_SHA16, "created_at": datetime.now(IST).isoformat(timespec="seconds")}
    n_done = n_blind = n_skip = 0
    for i, w in enumerate(WINDOWS):
        wid = w.get("win_id", "?")
        if is_blind(w): n_blind += 1; print(f"[{i+1}/{len(WINDOWS)}] {wid}: BLIND refused (audio not opened)", flush=True); continue
        ap = os.path.join(AUDIO_ROOT, os.path.basename(w["audio"])); outp = os.path.join(OUT_ROOT, f"{wid}.json")
        if os.path.exists(outp) or not os.path.exists(ap): n_skip += 1; print(f"[{i+1}/{len(WINDOWS)}] {wid}: skip (done or audio absent)", flush=True); continue
        need = [e for e in w.get("need", list(CONFIGS)) if e in CONFIGS]
        t1 = time.time(); x = decode_to_16k_mono(ap); dur = len(x) / 16000.0
        stub = {"window_id": wid, "room_id": w["room"], "room_slug": w["room"], "ist_date": w["ist_date"], "t0_ms": parse_iso_ms(w["start"]), "t1_ms": parse_iso_ms(w["end"]),
                "audio": {"r2_key": os.path.basename(w["audio"]), "sha256": sha256_file(ap), "sample_rate": 16000, "duration_ms": int(dur * 1000)}}
        chunks = [(c0, min(len(x), c0 + 480000), x[c0:c0 + 480000]) for c0 in range(0, len(x), 480000) if len(x[c0:c0 + 480000]) >= 4000]
        tracks = {}
        det = eng.detect(x) if (chunks and "whisper-auto" in need) else None
        for e in need:
            c, h = CONFIGS[e]
            lang = "en" if e != "whisper-auto" else (det[0] if det else None)
            segs, err = [], None
            try:
                segs = eng.run(chunks, lang, e == "whisper-cap2") if chunks else []
                if e == "whisper-auto" and segs and det: segs[0]["extras"]["lid"] = {"detected": det[0], "p": det[1], "probs": det[2], "scored_ms": [0, min(30000, int(dur * 1000))]}
            except Exception as ex: err = type(ex).__name__ + ": " + str(ex)[:150]
            tracks[e] = {"schema": "reb.track.v1", "window_id": wid, "layer": "stt", "engine": e, "model": MODEL_NAME, "version": VERSION, "config": c, "config_hash": h, "machine": machine,
                         "status": "failed" if err else ("ok" if segs else "empty"), "reason": err, "segments": segs, "provenance": prov}
        if any(t["status"] == "failed" for t in tracks.values()): print(f"[{i+1}/{len(WINDOWS)}] {wid}: ERROR track, not written", flush=True); continue
        tmp = os.path.join(OUT_ROOT, f".{wid}.json.tmp")
        with open(tmp, "w") as f: json.dump({"manifest_stub": stub, "tracks": tracks}, f, ensure_ascii=False); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, outp); n_done += 1
        print(f"[{i+1}/{len(WINDOWS)}] {wid}: dur={dur:.0f}s wall={time.time()-t1:.1f}s chars={ {e: sum(len(s['text']) for s in t['segments']) for e, t in tracks.items()} } "
              f"lid={det[0] if det else None}", flush=True)
    print(f"WHISPER3_SUMMARY done={n_done} blind_refused={n_blind} skipped={n_skip} script_sha16={os.environ['EXPECT_SCRIPT_SHA16']}", flush=True)
    print("WHISPER3_DONE", flush=True)

if __name__ == "__main__": main()
