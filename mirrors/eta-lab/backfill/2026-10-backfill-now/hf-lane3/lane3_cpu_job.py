#!/usr/bin/env python3
"""[HF-3 lane 3] REB stt-layer compute on HF-1 (CPU Space): SraVaani-1.0 + IndicConformer-600M CTC x5 heads (kn/hi/ta/te/ml) on pre-cut room windows.
Runs ON HF-1 from /data/lane3 (venv-indic / venv-sra, see install_hf1.sh); COMPUTE ONLY: per window one JSON {manifest_stub, tracks, timing_s} per FAMILY in <OUT>/<family>/<win_id>.json (atomic, write-once);
the box-side collect_lane3.py validates and calls reb.writer.write_track. Same compute as ~/eta-data/manoj-package-work/reb-backfill-job/reb_backfill_hf_job_v2.py (12 s chunks + 0.5 s overlap, CTC; SraVaani 30 s chunks) but CPU, fp32.
IDENTITY (like hf-lane1): config = the EXISTING REB config dict + PRODUCER fields => own config_hash + own version string; the job asserts lane hash != existing hash and that stripping the producer fields (and restoring the
existing device) gives exactly the existing hash. Fail closed (exit non-zero) BEFORE any audio is read or model loaded on: own sha16 != EXPECT_SCRIPT_SHA16, HELDOUT_SHA16 != pinned, embedded blind list sha16 != EXPECT_BLIND_SHA16,
snapshot dir != pinned 40-hex revision, a remote-code file whose sha256 differs from the pin (trust_remote_code runs ONLY on files verified against the pins). A blind or unparseable window is refused BEFORE its audio is opened.
Audio sha256 must equal the manifest's. Prints counts and timings only, never transcript text.
  lane3_cpu_job.py --family {indic|sravaani} --windows windows.json [--limit N]"""
import argparse, hashlib, json, os, re, sys, time
from datetime import datetime, timedelta, timezone

HELDOUT_SHA16 = "f672c1ef046089dd"; BLIND_UNION_SHA8 = "f07171dc"
BLIND = {("2026-08-23", "room_qyzghzaf"), ("2026-09-13", "room_ux92qpws"), ("2026-09-14", "room_ux92qpws"),
         ("2026-09-15", "room_qyzghzaf"), ("2026-09-16", "room_ux92qpws"), ("2026-09-18", "room_qyzghzaf"),
         ("2026-09-19", "room_ux92qpws"), ("2026-09-20", "room_ux92qpws"), ("2026-09-20", "room_qyzghzaf"),
         ("2026-09-23", "room_4ggnkg5x"), ("2026-09-23", "room_qyzghzaf"), ("2026-09-26", "room_ux92qpws"),
         ("2026-09-28", "room_ux92qpws"), ("2026-09-28", "room_qyzghzaf")}
IST = timezone(timedelta(hours=5, minutes=30))
VERSION = "hf1-cpu-lane3-1"                       # existing products use version hf-l4-backfill-2 / -1
MODELS = {"indic": ("ai4bharat/indic-conformer-600m-multilingual", "e9b71b369c048e2c6b634d4c131061c34e441179"),
          "sravaani": ("ARTPARK-IISc/SraVaani-1.0", "f5dd5358325a5208775b91dad98918e079ea2b27")}
# sha256 of every remote-code / config file in the pinned snapshots, MEASURED on e2e-c4 (c4_measured-20261008.json); the files are verified against these before trust_remote_code loads them
CODE_PINS = {
 "indic": {
  "config.json": "e73ac7c3bb85d735b4de38dc275c5f99cfa13824d89a9bb7767824ffb441f4c9",
  "model_onnx.py": "700f1897493f68fc522ce73dd7f91aa39b28fc20285d3d635e92de241b3910ae",
  "model_onnx_1b_batched_rnnt.py": "d71f4ab093e7443c0a84af5d7a907d60e3b7458fcb712140e9953e86e60cb30a",
  "model_ts.py": "cbb56e0a3a86f9142e11b29e8f596d615c46f5a6dcc075aadad0f68a3cf2dbfc"
 },
 "sravaani": {
  "config.json": "c794c314a7f82ee5b156f47ed35ccbbaed03fd8378ce1718b038300bd0eb325a",
  "configuration_sravaani.py": "d3ff324a779d9b5b916e9f4367b783ca2fab0ca3f82ef932eb956324b3e285fd",
  "example_inference.py": "f28a742e1179a06a5cf8eba2f7b1a1b247a257ef9d32c0ccdc01a502f736da8a",
  "model_meta.json": "b3e7134ae4cb324f555f3a97d171fc0c0b25a7e102f8757a599f6025a3e94105",
  "modeling_sravaani.py": "1c9335a761ce890b43bd7b116a82caad703abcccd147fca812f1c9b7a936ccc8",
  "processing_sravaani.py": "2d6a08ca5a5bf97242e0abefa4f42a17d3cc492311600cce81df08b42970bfad"
 }
}
LANGS = ("kn", "hi", "ta", "te", "ml"); INDIC_WIN_S, INDIC_OVERLAP_S = 12.0, 0.5; INDIC_MAXWIN_S = INDIC_WIN_S + INDIC_OVERLAP_S; SRA_CHUNK_S = 30
PRODUCER_KEYS = ("producer", "device", "model_revision", "code_sha16", "dtype")
EXISTING_HASHES = {"indic-conformer-kn": "39ec4d29", "indic-conformer-hi": "ab4dc753", "indic-conformer-ta": "000515d7", "indic-conformer-te": "4a42ca36", "indic-conformer-ml": "088e3ac3", "sravaani": "1956ddf2"}
EXISTING_DEVICE = {"sravaani": "cuda"}            # the old SraVaani config carries device=cuda; the indic configs carry no device
ENGINE_OF = {k: ("sravaani" if k == "sravaani" else "indic-conformer") for k in EXISTING_HASHES}
FAMILY_OF = {k: ("sravaani" if k == "sravaani" else "indic") for k in EXISTING_HASHES}

def config_hash(c): return hashlib.sha256(json.dumps(c or {}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:8]
def code_sha16(family): return hashlib.sha256(json.dumps(sorted(CODE_PINS[family].items())).encode()).hexdigest()[:16]
def existing_configs():
    M = MODELS["indic"][0]
    c = {f"indic-conformer-{l}": {"language": l, "decoding": "ctc", "model": M, "chunk_s": INDIC_WIN_S, "overlap_s": INDIC_OVERLAP_S} for l in LANGS}
    c["sravaani"] = {"model": MODELS["sravaani"][0], "device": "cuda", "chunk_s": SRA_CHUNK_S}; return c
def producer(key):
    f = FAMILY_OF[key]; return {"producer": "hf1-cpu-torch-fp32", "device": "cpu", "model_revision": MODELS[f][1], "code_sha16": code_sha16(f), "dtype": "float32"}
def lane_configs(): return {k: {**c, **producer(k)} for k, c in existing_configs().items()}
def to_existing(key, cfg):
    c = {k: v for k, v in cfg.items() if k not in PRODUCER_KEYS}
    if key in EXISTING_DEVICE: c["device"] = EXISTING_DEVICE[key]
    return c
LANE_HASHES = {"indic-conformer-kn": "691771dc", "indic-conformer-hi": "05594b1a", "indic-conformer-ta": "c096eb78", "indic-conformer-te": "8e5b017b", "indic-conformer-ml": "2d04f999", "sravaani": "d3c4613d"}
CONFIGS = {k: (c, LANE_HASHES[k]) for k, c in lane_configs().items()}

def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 22), b""): h.update(c)
    return h.hexdigest()
def blind_list_sha16(blind): return hashlib.sha256(json.dumps(sorted([d, r] for d, r in blind)).encode()).hexdigest()[:16]

def is_blind(w):
    """Same predicate as hf-lane1 / runner.py _blind: IST day of start and end-1s, ist_date, day in the id; any failure = blind (fail closed)."""
    try:
        st = datetime.fromisoformat(w["start"].replace("Z", "+00:00")).astimezone(IST)
        en = datetime.fromisoformat(w["end"].replace("Z", "+00:00")).astimezone(IST) - timedelta(seconds=1)
        m = re.search(r"(\d{4}-\d{2}-\d{2})_room_[a-z0-9]+_\d{4}", w["win_id"])
        if not m: return True
        days = {st.date().isoformat(), en.date().isoformat(), w["ist_date"], m.group(1)}
        return any((d, w["room"]) in BLIND for d in days)
    except Exception: return True

def identity_checks():
    for k, (cfg, h) in CONFIGS.items():
        if config_hash(cfg) != h: raise SystemExit(f"REFUSED: lane config hash for {k} is {config_hash(cfg)} != {h}")
        if h == EXISTING_HASHES[k]: raise SystemExit(f"REFUSED: lane hash for {k} equals the existing hash")
        if config_hash(to_existing(k, cfg)) != EXISTING_HASHES[k]: raise SystemExit(f"REFUSED: stripping the producer fields of {k} does not give the existing hash")
    for k, c in existing_configs().items():
        if config_hash(c) != EXISTING_HASHES[k]: raise SystemExit(f"REFUSED: existing config copy for {k} hashes to {config_hash(c)} != {EXISTING_HASHES[k]}")

def startup_checks(env=os.environ, blind=BLIND, script_path=None):
    own = sha256_file(script_path or __file__)[:16]
    if own != env.get("EXPECT_SCRIPT_SHA16"): raise SystemExit(f"REFUSED: script sha16 {own} != EXPECT_SCRIPT_SHA16")
    if env.get("HELDOUT_SHA16") != HELDOUT_SHA16: raise SystemExit("REFUSED: HELDOUT_SHA16 not the pinned f672c1ef046089dd")
    if len(blind) != 14 or blind_list_sha16(blind) != env.get("EXPECT_BLIND_SHA16"): raise SystemExit("REFUSED: embedded blind list sha16 != EXPECT_BLIND_SHA16 (or not 14 entries)")
    for f, (_, rev) in MODELS.items():
        if not re.fullmatch(r"[0-9a-f]{40}", rev): raise SystemExit(f"REFUSED: {f} revision is not a 40-hex sha")
    identity_checks()

def verify_snapshot(family, snap_dir):
    """Raise SystemExit unless snap_dir is the pinned revision and every pinned code/config file has the pinned sha256 (done BEFORE trust_remote_code loads anything)."""
    rev = MODELS[family][1]
    if os.path.basename(snap_dir.rstrip("/")) != rev: raise SystemExit(f"REFUSED: snapshot dir {os.path.basename(snap_dir)} != pinned revision {rev}")
    for rel, want in CODE_PINS[family].items():
        p = os.path.join(snap_dir, rel)
        if not os.path.exists(p): raise SystemExit(f"REFUSED: pinned file {rel} missing in the snapshot")
        if sha256_file(p) != want: raise SystemExit(f"REFUSED: {rel} sha256 differs from the pin (remote code not loaded)")

def offline_mode(env=os.environ): return env.get("L3_OFFLINE") == "1" or env.get("HF_HUB_OFFLINE") == "1"      # HF-3b: no HF call, no token (snapshots staged into hf_home)
def snapshot_path(hf_home, family):
    repo, rev = MODELS[family]; return os.path.join(hf_home, "hub", "models--" + repo.replace("/", "--"), "snapshots", rev)
def verify_manifest(snap_dir, files):
    """HF-3b: FULL integrity: the snapshot must contain exactly the files of the pinned manifest (relpath -> sha256), every byte-for-byte (follows symlinks), nothing extra. SystemExit otherwise."""
    have = set()
    for dp, _, fns in os.walk(snap_dir):
        for fn in fns: have.add(os.path.relpath(os.path.join(dp, fn), snap_dir))
    if have != set(files): raise SystemExit(f"REFUSED: snapshot file set differs from the pinned manifest (missing {len(set(files) - have)}, extra {len(have - set(files))})")
    for rel, want in sorted(files.items()):
        if sha256_file(os.path.join(snap_dir, rel)) != want: raise SystemExit(f"REFUSED: {rel} sha256 differs from the pinned manifest")

def decode_to_16k_mono(src):
    import av, numpy as np
    c = av.open(src); st = next(s for s in c.streams if s.type == "audio")
    rs = av.AudioResampler(format="fltp", layout="mono", rate=16000)
    ch = [r.to_ndarray().reshape(-1) for fr in c.decode(st) for r in rs.resample(fr)]; c.close()
    return np.concatenate(ch).astype("float32") if ch else np.zeros(0, dtype="float32")
def parse_iso_ms(s): return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)

class Engines:
    """The two model families; heavy imports only here (tests stub this class)."""
    def __init__(self, family, hf_home, threads):
        import torch
        from transformers import AutoModel
        from huggingface_hub import snapshot_download
        torch.set_num_threads(threads); self.torch = torch; self.family = family
        repo, rev = MODELS[family]; hub = os.path.join(hf_home, "hub"); offline = offline_mode()      # L3_OFFLINE=1 / HF_HUB_OFFLINE=1 = use the staged snapshots only (no HF call, no token)
        snap = snapshot_download(repo, revision=rev, cache_dir=hub, local_files_only=offline)        # token (read-only, in the env as HF_TOKEN) only if the repo is gated
        verify_snapshot(family, snap)                                                                # pinned revision dir + sha256 of every pinned code/config file, BEFORE any remote code runs
        import huggingface_hub
        _orig = huggingface_hub.snapshot_download
        def _pinned(*a, **kw):          # the indic remote code (model_onnx.py) calls snapshot_download(repo_id=...) itself, unpinned: force the pinned revision/cache for it too (the old HF job patched it the same way)
            kw["revision"] = rev; kw.setdefault("cache_dir", hub); kw["local_files_only"] = offline; return _orig(*a, **kw)
        huggingface_hub.snapshot_download = _pinned
        try: self.model = AutoModel.from_pretrained(repo, revision=rev, cache_dir=hub, trust_remote_code=True, local_files_only=offline).to("cpu").eval()
        finally: huggingface_hub.snapshot_download = _orig
        if hasattr(self.model, "_ensure_loaded"): self.model._ensure_loaded()
    def indic_chunk(self, chunk, lang):
        wav = self.torch.from_numpy(chunk).unsqueeze(0)
        with self.torch.no_grad(): out = self.model(wav, lang, "ctc")
        return out if isinstance(out, str) else (out[0] if out else "")
    def sravaani_piece(self, wav_path):
        hyps = self.model.transcribe(wav_path, return_hypotheses=True)
        if not hyps: return ""
        h = hyps[0]; return getattr(h, "text", None) or (h if isinstance(h, str) else "") or ""

def run_indic_long(eng, samples, dur_s, lang):
    sr = 16000
    def infer(start_s, length_s): return eng.indic_chunk(samples[int(start_s * sr):int(min(dur_s, start_s + length_s) * sr)], lang)
    if dur_s <= INDIC_MAXWIN_S:
        t = infer(0.0, dur_s); return [{"t0_ms": 0, "t1_ms": int(dur_s * 1000), "text": t.strip(), "lang": lang}] if t.strip() else []
    segs, start = [], 0.0
    while start < dur_s:
        try: t = infer(start, INDIC_WIN_S + INDIC_OVERLAP_S)
        except Exception: t = ""
        if t.strip(): segs.append({"t0_ms": int(start * 1000), "t1_ms": int(min(dur_s, start + INDIC_WIN_S) * 1000), "text": t.strip(), "lang": lang})
        start += INDIC_WIN_S
    return segs

def run_sravaani(eng, samples, tmpwav):
    import soundfile as sf
    segs, CH = [], SRA_CHUNK_S * 16000
    for c0 in range(0, len(samples), CH):
        piece = samples[c0:c0 + CH]
        if len(piece) < 8000: continue
        sf.write(tmpwav, piece, 16000)
        try: t = eng.sravaani_piece(tmpwav)
        except Exception: continue
        if t.strip(): segs.append({"t0_ms": int(c0 / 16), "t1_ms": int(min(len(samples), c0 + CH) / 16), "text": t.strip()})
    return segs

def process(windows, family, audio_root, out_root, eng, machine, prov_extra=None, log=print):
    keys = [k for k in CONFIGS if FAMILY_OF[k] == family]; od = os.path.join(out_root, family); os.makedirs(od, exist_ok=True)
    n_done = n_blind = n_skip = n_bad = 0
    for i, w in enumerate(windows):
        wid = w.get("win_id", "?")
        if is_blind(w): n_blind += 1; log(f"[{i+1}/{len(windows)}] {wid}: BLIND refused (audio not opened)"); continue
        outp = os.path.join(od, f"{wid}.json"); ap = os.path.join(audio_root, os.path.basename(w["audio"]))
        if os.path.exists(outp) or not os.path.exists(ap): n_skip += 1; log(f"[{i+1}/{len(windows)}] {wid}: skip (done or audio absent)"); continue
        if w.get("audio_sha256") and sha256_file(ap) != w["audio_sha256"]: n_bad += 1; log(f"[{i+1}/{len(windows)}] {wid}: audio sha256 != manifest, refused"); continue
        t0 = time.time(); x = decode_to_16k_mono(ap); dur = len(x) / 16000.0; timing = {"decode": round(time.time() - t0, 2)}
        stub = {"window_id": wid, "room_id": w["room"], "room_slug": w["room"], "ist_date": w["ist_date"], "t0_ms": parse_iso_ms(w["start"]), "t1_ms": parse_iso_ms(w["end"]),
                "audio": {"r2_key": os.path.basename(w["audio"]), "sha256": w.get("audio_sha256") or sha256_file(ap), "sample_rate": 16000, "duration_ms": int(dur * 1000)}}
        tracks, failed = {}, False
        for k in keys:
            cfg, h = CONFIGS[k]; t1 = time.time()
            try: segs = run_sravaani(eng, x, os.path.join(out_root, "..", "work", "_sra_tmp.wav")) if k == "sravaani" else run_indic_long(eng, x, dur, k.split("-")[-1])
            except Exception as ex: failed = True; log(f"[{i+1}/{len(windows)}] {wid}: {k} failed {type(ex).__name__}"); break
            timing[k] = round(time.time() - t1, 2)
            tracks[k] = {"schema": "reb.track.v1", "window_id": wid, "layer": "stt", "engine": ENGINE_OF[k], "model": cfg["model"], "version": VERSION, "config": json.loads(json.dumps(cfg)), "config_hash": h, "machine": machine,
                         "status": "ok" if segs else "empty", "reason": None, "segments": segs, "provenance": {**(prov_extra or {}), "existing_config_hash": EXISTING_HASHES[k]}}
        if failed: continue
        tmp = os.path.join(od, f".{wid}.json.tmp")
        with open(tmp, "w") as f: json.dump({"manifest_stub": stub, "tracks": tracks, "timing_s": {**timing, "total": round(time.time() - t0, 2), "audio_s": round(dur, 1)}}, f, ensure_ascii=False); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, outp); n_done += 1
        log(f"[{i+1}/{len(windows)}] {wid}: dur={dur:.0f}s timing={timing} chars={ {k: sum(len(s['text']) for s in t['segments']) for k, t in tracks.items()} }")
    log(f"LANE3_SUMMARY family={family} done={n_done} blind_refused={n_blind} skipped={n_skip} audio_sha_refused={n_bad}")
    return n_done, n_blind, n_skip, n_bad

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--family", required=True, choices=["indic", "sravaani"]); ap.add_argument("--windows", required=True); ap.add_argument("--limit", type=int)
    a = ap.parse_args(); startup_checks()
    root = os.environ.get("L3_ROOT", "/data/lane3"); wins = json.load(open(a.windows)); wins = wins[:a.limit] if a.limit else wins
    for k in ("work",): os.makedirs(os.path.join(root, k), exist_ok=True)
    eng = Engines(a.family, os.path.join(root, "hf_home"), int(os.environ.get("L3_THREADS", "8")))
    import torch, transformers
    prov = {"script_sha16": os.environ["EXPECT_SCRIPT_SHA16"], "heldout_sha16": HELDOUT_SHA16, "family": a.family, "torch": torch.__version__, "transformers": transformers.__version__,
            "model_repo": MODELS[a.family][0], "model_revision": MODELS[a.family][1], "created_at": datetime.now(IST).isoformat(timespec="seconds")}
    process(wins, a.family, os.path.join(root, "audio"), os.path.join(root, "out"), eng, "hf-space:eta-hf-1", prov, lambda s: print(s, flush=True))
    print("LANE3_DONE", flush=True)

if __name__ == "__main__": main()
