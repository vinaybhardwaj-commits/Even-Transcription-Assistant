# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "torch==2.14.0",
#   "transformers==5.17.0",
#   "soundfile==0.14.0",
#   "huggingface_hub==1.33.0",
#   "numpy==2.5.3",
# ]
# ///
# ADDENDUM-19 (refuter-2 #5120, refuter-3 #5113 R3/#5122): pinned to the EXACT versions verified working in the
# job that produced job id 6ab9583252d0dbd7f1d9d468 (27 Sep 2026) - `uv` was resolving "latest" unpinned before,
# so a scored run tomorrow could have silently picked up different dependency behavior with no config_hash change
# to flag it. A scored run MUST use this committed script, not a re-derived one.
"""W50 terms bake-off: whisper-med-merged smoke test (S1/S2 of the #4949 checklist).

Runs the real taphuynh/whisper-large-en-medical-2607.26-merged model against 3 clinical1 clips
(clin_en_3 23.1s single-chunk, clin_en_8 28.5s single-chunk, clin_en_7 30.8s - the required
30-31s boundary case that exercises F1's chunk_s=29 fix for real), via the actual
chunked_runner/track_builder/pinned_configs code (not a stub), writing real REB tracks.
"""
import json
import os
import shutil
import sys
import time

KIT_ROOT = os.environ.get("KIT_ROOT", "/mnt/kit")
sys.path.insert(0, os.path.join(KIT_ROOT, "terms"))
sys.path.insert(0, KIT_ROOT)

from reb import write_track  # noqa: E402
from track_builder import build_track  # noqa: E402
from duration_probe import probe_duration_s  # noqa: E402
from pinned_configs import reuse_config, PinnedConfigMismatch  # noqa: E402
import engine_whisper_med_merged as eng  # noqa: E402

LOCAL_ROOT = "/tmp/reb-local"
BUCKET_ROOT = os.environ.get("REB_BUCKET_ROOT", "/mnt/reb")
OUT_PREFIX = os.environ.get("REB_OUT_PREFIX", "terms-smoke")
AUDIO_ROOT = os.environ.get("AUDIO_ROOT", "/mnt/audio")
MACHINE = os.environ.get("HF_JOB_ID") or os.environ.get("HOSTNAME") or "hf-job-unknown"
ROOM_ID = "suite-smoke-w50"  # smoke-only room_id, distinct from reb's own suite-clinical1
IST_DATE = "2026-09-27"
VERSION = "v1"


def claim_windows():
    return json.loads(os.environ["WINDOWS"])


def upload_window(window_id):
    src_dir = os.path.join(LOCAL_ROOT, IST_DATE, ROOM_ID, window_id)
    dst_dir = os.path.join(BUCKET_ROOT, OUT_PREFIX, IST_DATE, ROOM_ID, window_id)
    os.makedirs(os.path.dirname(dst_dir), exist_ok=True)
    shutil.copytree(src_dir, dst_dir, dirs_exist_ok=True)
    idx_src = os.path.join(LOCAL_ROOT, IST_DATE, "index.jsonl")
    if os.path.exists(idx_src):
        idx_dst_dir = os.path.join(BUCKET_ROOT, OUT_PREFIX, IST_DATE)
        os.makedirs(idx_dst_dir, exist_ok=True)
        shutil.copy(idx_src, os.path.join(idx_dst_dir, "index.jsonl"))
    return dst_dir


def print_dep_versions():
    import torch, transformers, soundfile, numpy, huggingface_hub
    versions = {
        "torch": torch.__version__, "transformers": transformers.__version__,
        "soundfile": soundfile.__version__, "numpy": numpy.__version__,
        "huggingface_hub": huggingface_hub.__version__,
    }
    print(f"[whisper-med] RESOLVED DEP VERSIONS: {json.dumps(versions)}", flush=True)
    return versions


def main():
    dep_versions = print_dep_versions()
    windows = claim_windows()
    print(f"[whisper-med] claimed {len(windows)} windows: {[w['window_id'] for w in windows]}", flush=True)

    hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    config_preview = reuse_config("whisper-med-merged")
    revision = config_preview["revision"]
    dtype = config_preview["dtype"]

    print(f"[whisper-med] loading model @ revision {revision} dtype={dtype} ...", flush=True)
    t0 = time.time()
    model, processor, loading_path = eng.load_model(revision, dtype=dtype)
    load_s = round(time.time() - t0, 1)
    print(f"[whisper-med] loaded in {load_s}s via loading_path={loading_path!r}", flush=True)

    try:
        import torch
        model = model.to("cuda")
        device = "cuda"
    except Exception as e:
        print(f"[whisper-med] WARNING: .to('cuda') failed ({e!r}); staying on CPU", flush=True)
        device = "cpu"
    print(f"[whisper-med] device={device}", flush=True)

    results = []
    for w in windows:
        window_id, audio_file = w["window_id"], w["audio_file"]
        audio_path = os.path.join(AUDIO_ROOT, audio_file)
        print(f"[whisper-med] === window {window_id} ({audio_path}) ===", flush=True)

        duration_s = probe_duration_s(audio_path)
        import soundfile as sf
        data, sr = sf.read(audio_path, dtype="float32")
        if sr != 16000:
            raise ValueError(f"{audio_path}: expected 16kHz, got {sr}")
        if data.ndim > 1:
            data = data.mean(axis=1)
        audio_array = data

        config = reuse_config("whisper-med-merged")
        transcribe_chunk = eng.make_transcribe_chunk(model, processor, audio_array, sample_rate=16000, language="en")

        wall_t0 = time.time()
        try:
            track = build_track(
                engine="whisper-med-merged", config=config, model="taphuynh/whisper-large-en-medical-2607.26-merged",
                version=VERSION, machine=MACHINE, window_id=window_id, layer="terms",
                duration_s=duration_s, transcribe_chunk=transcribe_chunk,
            )
        except PinnedConfigMismatch as e:
            print(f"[whisper-med] REFUSED (config drift): {e}", flush=True)
            raise
        wall_s = round(time.time() - wall_t0, 2)
        # ADDENDUM-19 R2/#5116.3: explicit evidence that assert_pinned passed on the config THIS adapter actually
        # built in this HF Job (build_track calls it internally inside run_engine_for_track - if it had failed, the
        # PinnedConfigMismatch except block above would have caught it and re-raised before this line is reached).
        print(f"[whisper-med]   assert_pinned PASSED for engine=whisper-med-merged config_hash={track['config_hash']}",
              flush=True)

        n_chunks = "n/a"
        try:
            from chunked_runner import chunk_windows
            n_chunks = len(chunk_windows(duration_s, config["chunk_s"], config.get("chunk_overlap_s", 0.0)))
        except Exception:
            pass

        manifest_stub = {
            "window_id": window_id, "room_id": ROOM_ID, "room_slug": ROOM_ID, "ist_date": IST_DATE,
            "t0_ms": 0, "t1_ms": int(duration_s * 1000),
            "audio": {"r2_key": audio_file, "sha256": "smoke-not-computed", "sample_rate": 16000,
                      "duration_ms": int(duration_s * 1000)},
            "source_kind": "suite_synthetic", "clock": "clip_local",
        }
        write_track(LOCAL_ROOT, IST_DATE, ROOM_ID, window_id, track, manifest_stub=manifest_stub)
        dst = upload_window(window_id)

        print(f"[whisper-med]   status={track['status']} n_segments={len(track['segments'])} "
              f"n_chunks={n_chunks} duration_s={duration_s:.2f} wall_s={wall_s} config_hash={track['config_hash']}",
              flush=True)
        if track["status"] == "failed":
            print(f"[whisper-med]   REASON: {track['reason']}", flush=True)
        for seg in track["segments"]:
            print(f"[whisper-med]     [{seg['t0_ms']}-{seg['t1_ms']}ms] {seg.get('text','')!r}", flush=True)
        results.append({
            "window_id": window_id, "duration_s": round(duration_s, 2), "wall_s": wall_s,
            "status": track["status"], "n_segments": len(track["segments"]), "n_chunks": n_chunks,
            "config_hash": track["config_hash"], "uploaded_to": dst,
        })

    print("[whisper-med] === SUMMARY ===", flush=True)
    print(json.dumps({"loading_path": loading_path, "load_s": load_s, "device": device,
                       "dep_versions": dep_versions, "results": results}, indent=2),
          flush=True)


if __name__ == "__main__":
    main()
