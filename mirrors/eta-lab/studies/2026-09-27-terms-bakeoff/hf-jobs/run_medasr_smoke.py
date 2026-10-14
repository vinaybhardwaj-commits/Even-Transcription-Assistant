# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "torch==2.14.0",
#   "transformers @ git+https://github.com/huggingface/transformers.git@65dc261512cbdb1ee72b88ae5b222f2605aad8e5",
#   "soundfile==0.14.0",
#   "huggingface_hub==1.33.0",
#   "numpy==2.5.3",
#   "sentencepiece==0.2.2",
# ]
# ///
# ADDENDUM-19 (refuter-2 #5120, refuter-3 #5113 R3/#5122): pinned to the EXACT versions verified working in the
# job that produced job id 6ab958586b030d633f69a0e4 (27 Sep 2026) - transformers is already pinned to the specific
# unreleased git commit STEP0-FACTS.md named (5.0.0.dev0 at that commit); everything else was resolving "latest"
# unpinned before. A scored run MUST use this committed script, not a re-derived one.
# ADDENDUM-20 (refuter-2 C2, bus #5129): sentencepiece was resolved but never pinned or logged - job
# 6ab95b5752d0dbd7f1d9d544 (27 Sep 2026, 1-clip re-run of this exact script) resolved it to 0.2.2, now pinned here
# and logged every run (print_dep_versions below). Same job also logged medasr's from_pretrained dtype for the
# first time (refuter-3 #5130): torch.float32, deterministic (the checkpoint's own stored config, not a cast this
# code applies), so unlike whisper-med-merged's explicit fp32 CAST it does not belong in the config dict - it is
# logged for reproducibility, not pinned as a config field.
"""W50 terms bake-off: medasr smoke test (S1/S2/S3 of the #4949 checklist).

Runs the real google/medasr model against 3 clinical1 clips (same 3 as the whisper-med-merged
smoke test), via the actual chunked_runner/track_builder/pinned_configs code, writing real REB
tracks. medasr needs an unreleased transformers git commit (STEP0-FACTS.md) - confirmed on this
box's stock transformers 4.48.2 that AutoConfig fails with "model type lasr_ctc" unrecognized, so
this is the first real test of whether the pinned git-commit transformers actually loads it.
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
import engine_medasr as eng  # noqa: E402

LOCAL_ROOT = "/tmp/reb-local"
BUCKET_ROOT = os.environ.get("REB_BUCKET_ROOT", "/mnt/reb")
OUT_PREFIX = os.environ.get("REB_OUT_PREFIX", "terms-smoke")
AUDIO_ROOT = os.environ.get("AUDIO_ROOT", "/mnt/audio")
MACHINE = os.environ.get("HF_JOB_ID") or os.environ.get("HOSTNAME") or "hf-job-unknown"
ROOM_ID = "suite-smoke-w50"
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
    from importlib.metadata import version as pkg_version
    versions = {
        "torch": torch.__version__, "transformers": transformers.__version__,
        "soundfile": soundfile.__version__, "numpy": numpy.__version__,
        "huggingface_hub": huggingface_hub.__version__,
        "sentencepiece": pkg_version("sentencepiece"),  # ADDENDUM-20 (refuter-2 C2): was resolved but never logged
    }
    print(f"[medasr] RESOLVED DEP VERSIONS: {json.dumps(versions)}", flush=True)
    return versions


def main():
    dep_versions = print_dep_versions()

    windows = claim_windows()
    print(f"[medasr] claimed {len(windows)} windows: {[w['window_id'] for w in windows]}", flush=True)

    hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    revision = reuse_config("medasr")["revision"]

    print(f"[medasr] loading model @ revision {revision} ...", flush=True)
    t0 = time.time()
    model, processor = eng.load_model(revision)
    load_s = round(time.time() - t0, 1)
    print(f"[medasr] loaded in {load_s}s", flush=True)

    try:
        model = model.to("cuda")
        device = "cuda"
    except Exception as e:
        print(f"[medasr] WARNING: .to('cuda') failed ({e!r}); staying on CPU", flush=True)
        device = "cpu"
    model_dtype = str(next(model.parameters()).dtype)
    print(f"[medasr] device={device} model_dtype={model_dtype}", flush=True)  # ADDENDUM-20 (refuter-3): from_pretrained's
    # default dtype was never logged; medasr's config has no explicit "dtype" field (unlike whisper-med-merged),
    # so this line is the only record of what actually ran - log it every time, not just this once.

    results = []
    for w in windows:
        window_id, audio_file = w["window_id"], w["audio_file"]
        audio_path = os.path.join(AUDIO_ROOT, audio_file)
        print(f"[medasr] === window {window_id} ({audio_path}) ===", flush=True)

        duration_s = probe_duration_s(audio_path)
        audio_array = eng.load_audio(audio_path)

        config = reuse_config("medasr")
        transcribe_chunk = eng.make_transcribe_chunk(model, processor, audio_array, sample_rate=16000)

        wall_t0 = time.time()
        try:
            track = build_track(
                engine="medasr", config=config, model="google/medasr",
                version=VERSION, machine=MACHINE, window_id=window_id, layer="terms",
                duration_s=duration_s, transcribe_chunk=transcribe_chunk,
            )
        except PinnedConfigMismatch as e:
            print(f"[medasr] REFUSED (config drift): {e}", flush=True)
            raise
        wall_s = round(time.time() - wall_t0, 2)
        print(f"[medasr]   assert_pinned PASSED for engine=medasr config_hash={track['config_hash']}", flush=True)

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

        print(f"[medasr]   status={track['status']} n_segments={len(track['segments'])} "
              f"n_chunks={n_chunks} duration_s={duration_s:.2f} wall_s={wall_s} config_hash={track['config_hash']}",
              flush=True)
        if track["status"] == "failed":
            print(f"[medasr]   REASON: {track['reason']}", flush=True)
        for seg in track["segments"]:
            print(f"[medasr]     [{seg['t0_ms']}-{seg['t1_ms']}ms] {seg.get('text','')!r}", flush=True)
        results.append({
            "window_id": window_id, "duration_s": round(duration_s, 2), "wall_s": wall_s,
            "status": track["status"], "n_segments": len(track["segments"]), "n_chunks": n_chunks,
            "config_hash": track["config_hash"], "uploaded_to": dst,
        })

    print("[medasr] === SUMMARY ===", flush=True)
    print(json.dumps({"dep_versions": dep_versions, "load_s": load_s, "device": device,
                       "model_dtype": model_dtype, "results": results}, indent=2), flush=True)


if __name__ == "__main__":
    main()
