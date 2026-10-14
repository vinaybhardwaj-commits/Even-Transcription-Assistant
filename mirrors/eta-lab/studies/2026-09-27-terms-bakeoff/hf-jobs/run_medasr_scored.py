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
# ADDENDUM-21 (refuter-2 C3 / refuter-3 #5130 gate): dependency block is byte-identical to
# hf-jobs/run_medasr_smoke.py's (post-ADDENDUM-20 sentencepiece pin) - same versions verified working in job
# 6ab958586b030d633f69a0e4 / 6ab95b5752d0dbd7f1d9d544. This is the SCORED launcher (any number of windows, across
# rooms/dates), not the 1-3-clip smoke one. Same differences from the smoke script as
# run_whisper_med_scored.py - see that file's header for the full list (per-window room_id/ist_date, real
# audio sha256, required REB_OUT_PREFIX, no per-segment text logging, scratch-root write + separate local commit).
# ADDENDUM-24+ (set c): each window MAY carry a precomputed "manifest_stub" (build_windows_set_c.py's output -
# real source_kind="dev_clip"/clock/source_windows provenance, not this script's generic suite_synthetic
# fallback). When present, it's used instead of the generic stub, but only after the downloaded audio file's own
# sha256 is checked against the stub's recorded value - never trust a precomputed manifest_stub without
# confirming it's actually paired with the bytes just downloaded. Set (b) windows never carry this field, so
# they're unaffected (falls back to the original generic stub, harmless since write_track ignores it once a
# manifest already exists there).
"""W50 terms bake-off: medasr SCORED run (set b and/or set c windows).

Runs the real google/medasr model over whatever windows WINDOWS names, via the actual
chunked_runner/track_builder/pinned_configs code (same as the smoke test), writing REB-shaped track JSON to a
scratch root for later download + commit_scored_tracks.py.
"""
import hashlib
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
OUT_PREFIX = os.environ["REB_OUT_PREFIX"]  # no smoke-specific default - must be set explicitly for a scored run
AUDIO_ROOT = os.environ.get("AUDIO_ROOT", "/mnt/audio")
MACHINE = os.environ.get("HF_JOB_ID") or os.environ.get("HOSTNAME") or "hf-job-unknown"
VERSION = "v1"
# refuter-2/refuter-3 FINAL joint rule (#5161/#5163, correcting my own earlier #5146/K2 mistake): ADDENDUM-9
# (witnessed) pins kit/reb at main@1ee3b4a4 for BOTH the HF Job's write and the local commit step - not
# 18c52b9f (this branch's older vendored copy, which I wrongly treated as the real pin before). Read from env,
# measured via `git rev-parse` on the tree actually synced to the bucket at launch time - never hardcoded, so
# this can't silently go stale the way the hardcoded "18c52b9f" already did once.
REB_LIB_COMMIT = os.environ.get("REB_LIB_COMMIT", "unknown-set-REB_LIB_COMMIT-at-launch")
# refuter-2 #5148 / refuter-3 #5149-#5150 (non-blocking add, not a separate gate): the terms/w50-detect-drugs
# commit this job actually ran from. Read from env, not hardcoded here - a value hardcoded in THIS file would be
# wrong the instant this very edit is committed (the sha would have to be "this commit", which doesn't exist
# until after it's written). Whoever launches the job sets it from `git rev-parse HEAD` at launch time.
TERMS_COMMIT = os.environ.get("TERMS_COMMIT", "unknown-set-TERMS_COMMIT-at-launch")


def claim_windows():
    """Each entry: {"window_id", "audio_file", "room_id", "ist_date"} - see build_windows_set_b.py for set (b)'s
    builder (set (c)'s is not written yet, pending ADDENDUM-21's open question)."""
    return json.loads(os.environ["WINDOWS"])


def upload_window(ist_date, room_id, window_id):
    src_dir = os.path.join(LOCAL_ROOT, ist_date, room_id, window_id)
    dst_dir = os.path.join(BUCKET_ROOT, OUT_PREFIX, ist_date, room_id, window_id)
    os.makedirs(os.path.dirname(dst_dir), exist_ok=True)
    shutil.copytree(src_dir, dst_dir, dirs_exist_ok=True)
    idx_src = os.path.join(LOCAL_ROOT, ist_date, "index.jsonl")
    if os.path.exists(idx_src):
        idx_dst_dir = os.path.join(BUCKET_ROOT, OUT_PREFIX, ist_date)
        os.makedirs(idx_dst_dir, exist_ok=True)
        shutil.copy(idx_src, os.path.join(idx_dst_dir, "index.jsonl"))
    return dst_dir


def upload_run_manifest(record):
    """ADDENDUM-22 (refuter-3 #5145 note 1): a durable record of exactly which dependency versions and model
    dtype produced this job's tracks, uploaded once per job (not per-window) to <out_prefix>/_runs/<job_id>.json.
    commit_scored_tracks.py copies these into ~/eta-data/terms/runs/ on commit."""
    runs_dst_dir = os.path.join(BUCKET_ROOT, OUT_PREFIX, "_runs")
    os.makedirs(runs_dst_dir, exist_ok=True)
    dst = os.path.join(runs_dst_dir, f"{MACHINE}.json")
    with open(dst, "w") as f:
        json.dump(record, f, indent=2, sort_keys=True)
    return dst


def print_dep_versions():
    import torch, transformers, soundfile, numpy, huggingface_hub
    from importlib.metadata import version as pkg_version
    versions = {
        "torch": torch.__version__, "transformers": transformers.__version__,
        "soundfile": soundfile.__version__, "numpy": numpy.__version__,
        "huggingface_hub": huggingface_hub.__version__,
        "sentencepiece": pkg_version("sentencepiece"),
    }
    print(f"[medasr] RESOLVED DEP VERSIONS: {json.dumps(versions)}", flush=True)
    return versions


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    dep_versions = print_dep_versions()
    windows = claim_windows()
    print(f"[medasr] claimed {len(windows)} windows: {[w['window_id'] for w in windows]}", flush=True)

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
    print(f"[medasr] device={device} model_dtype={model_dtype}", flush=True)

    results = []
    for w in windows:
        window_id, audio_file = w["window_id"], w["audio_file"]
        room_id, ist_date = w["room_id"], w["ist_date"]
        audio_path = os.path.join(AUDIO_ROOT, audio_file)
        print(f"[medasr] === window {ist_date}/{room_id}/{window_id} ({audio_path}) ===", flush=True)

        duration_s = probe_duration_s(audio_path)
        audio_array = eng.load_audio(audio_path)
        audio_sha256 = _sha256_file(audio_path)

        precomputed_stub = w.get("manifest_stub")
        if precomputed_stub is not None:
            expected_sha256 = precomputed_stub["audio"]["sha256"]
            if audio_sha256 != expected_sha256:
                raise ValueError(
                    f"{window_id}: downloaded {audio_path} sha256={audio_sha256} != manifest_stub's recorded "
                    f"sha256={expected_sha256} - the file changed in transit or the wrong file was staged, "
                    f"refusing to write (never trust a precomputed manifest_stub without checking the actual "
                    f"bytes it's paired with)"
                )

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

        manifest_stub = precomputed_stub or {
            "window_id": window_id, "room_id": room_id, "room_slug": room_id, "ist_date": ist_date,
            "t0_ms": 0, "t1_ms": int(duration_s * 1000),
            "audio": {"r2_key": f"local:{audio_file}", "sha256": audio_sha256, "sample_rate": 16000,
                      "duration_ms": int(duration_s * 1000)},
            "source_kind": "suite_synthetic", "clock": "clip_local",
        }
        write_track(LOCAL_ROOT, ist_date, room_id, window_id, track, manifest_stub=manifest_stub)
        dst = upload_window(ist_date, room_id, window_id)

        print(f"[medasr]   status={track['status']} n_segments={len(track['segments'])} "
              f"n_chunks={n_chunks} duration_s={duration_s:.2f} wall_s={wall_s} config_hash={track['config_hash']}",
              flush=True)
        if track["status"] == "failed":
            print(f"[medasr]   REASON: {track['reason']}", flush=True)
        results.append({
            "window_id": window_id, "room_id": room_id, "ist_date": ist_date,
            "duration_s": round(duration_s, 2), "wall_s": wall_s,
            "status": track["status"], "n_segments": len(track["segments"]), "n_chunks": n_chunks,
            "config_hash": track["config_hash"], "uploaded_to": dst,
        })

    run_manifest = {
        "job_id": MACHINE, "engine": "medasr", "dep_versions": dep_versions,
        "load_s": load_s, "device": device, "model_dtype": model_dtype,
        "n_windows": len(windows), "reb_lib_commit": REB_LIB_COMMIT, "terms_commit": TERMS_COMMIT,
    }
    run_manifest_dst = upload_run_manifest(run_manifest)
    print(f"[medasr] run manifest uploaded to {run_manifest_dst}", flush=True)

    print("[medasr] === SUMMARY ===", flush=True)
    print(json.dumps({"dep_versions": dep_versions, "load_s": load_s, "device": device,
                       "model_dtype": model_dtype, "results": results}, indent=2), flush=True)


if __name__ == "__main__":
    main()
