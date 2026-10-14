# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "torch==2.14.0",
#   "transformers==4.57.6",
#   "numpy==2.5.3",
#   "soundfile==0.14.0",
#   "requests==2.32.3",
#   "huggingface_hub==1.33.0",
# ]
#
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
#
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }
# ///
# Fable (13:10, relayed - eta-bus was down): move set (c) baselines OFF the box T4 onto HF Jobs (hf-fleet
# providing machines), same 87 consults already at hf://buckets/vrbeven/eta-parity-io/w50-setc-2026-09-28/.
# User approved the "ephemeral HF Jobs" assumption (same primitive as the candidate launchers) via
# AskUserQuestion, since the current baseline code has no other portable shape (see below).
#
# WHY THIS EXISTS (whisper.py/box_twin.py can't run on HF as-is): kit/reb_runner/engines/whisper.py's
# _call_whisper() and box_twin.py's _post_file() are thin HTTP clients to two long-running LOCAL services on
# this box (whisper.cpp's server on 127.0.0.1:8080, a transformers-based sravaani service on 127.0.0.1:8085).
# An ephemeral HF Job cannot reach those - it must start its OWN local instances of both, then run
# whisper.py/box_twin.py COMPLETELY UNCHANGED against them (REB_WHISPER_URL/REB_SRAVAANI_URL already default to
# 127.0.0.1, matching this job's own local instances), preserving byte-identical config/config_hash:
# whisper-auto=4b67551a, whisper-cap2=c7bd317b, sravaani (set c, chunk_s=30)=b3584dd6.
#
# whisper-server: built from source at the EXACT commit this box's own L4-targeted build uses
# (ggerganov/whisper.cpp @ e0fd1f67, tag v1.8.5, CMAKE_CUDA_ARCHITECTURES=89 - L4's own compute capability,
# confirmed via this box's build-l4/CMakeCache.txt) rather than shipping the box's compiled binary - a compiled
# ELF binary's glibc/CUDA-driver compatibility with whatever base image the HF Job actually runs is not
# something verifiable from here; building fresh against the job's own toolchain is the safer choice, at the
# cost of real build wall-clock time per job (see build_whisper_server()'s docstring - NOT unit-testable in this
# sandbox, no GPU/cmake/network here; only a real smoke-test job run proves this works, per this bake-off's
# standing smoke-before-scored gate). Startup flags match this box's systemd unit (whisper-twin.service, "V
# ruling 24 Sep"): -m <model> --no-speech-thold 0.7 --suppress-nst --port 8080 (no --vad).
#
# Model file ggml-large-v3-turbo.bin: this box's copy sha256 is 1fc70f774d38eb169993ac391eea357ef47c88757ef7
# 2ee5943879b7e8e2bc69 (confirmed via `sha256sum` on the box). download_whisper_model() assumes it's ggerganov's
# standard public HF Hub conversion (repo "ggerganov/whisper.cpp", same filename) and REFUSES if the fetched
# file's sha256 doesn't match - but this repo/filename guess has NOT been independently confirmed against a live
# network fetch from the sandbox that wrote this script (no internet access there). If the real smoke-test job
# can't find/download it from that repo, the fallback is shipping the model via a private bucket copy from this
# box instead (KIT_ROOT-style mount) - not implemented here since the HF Hub path is the more likely one to
# already work (ggerganov publishes ggml conversions there for exactly this reuse case).
#
# sravaani: /home/eta/services/eta-sravaani-twin/sravaani_server.py (vendor this exact file into the kit bucket
# at KIT_ROOT/sravaani_server.py before launch - not fetched from anywhere else). CRITICAL correctness
# requirement (the K1/K2 "hash hides a change" class this whole bake-off exists to prevent): this box's own
# instance is genuinely CPU-only, not just "CUDA available but forced to cpu" - confirmed via
# `curl 127.0.0.1:8085/healthz` -> "device":"cpu", and its venv has the literal CPU-only wheel
# (torch 2.14.0+cpu, transformers 4.57.6, numpy 2.5.3). The pinned config claims "backend":"box-twin-cpu". This
# job installs the SAME torch==2.14.0+cpu wheel (via the pytorch-cpu index above, not the default CUDA-capable
# build) AND sets SRAVAANI_DEVICE=cpu explicitly (defense in depth - sravaani_server.py's own fallback chain is
# FORCE env var -> MPS -> torch.cuda.is_available() -> cpu, so a GPU job with a default torch install would
# otherwise silently pick CUDA and produce different numerics under the identical config_hash b3584dd6).
#
# KIT_ROOT (/mnt/kit, bucket-mounted read-only) must contain, in addition to what the candidate launchers
# already need: reb_runner/engines/{whisper.py, box_twin.py, audio_utils.py} at commit a5def748 (byte-identical
# kit/reb between 1ee3b4a4 and a5def748, confirmed in run_setc_baselines.py's own docstring), terms/pinned_configs.py,
# and sravaani_server.py (see above). Verify kit/reb_runner/engines' content against a5def748 (e.g. via
# commit_scored_tracks.verify_kit_reb_pin(local_source_dir, pinned_commit="a5def748",
# subpath="reb_runner/engines")) on THIS BOX, against the exact files about to be uploaded, BEFORE syncing the
# kit bucket - this job's container has no git history to self-verify against once it starts (unlike
# run_setc_baselines.py's box-local KIT_ROOT, which is a real git worktree), so the pin check must happen at
# bucket-build time, not job-run time. This is a disclosed limitation of the HF path, not silently accepted:
# REB_RUNNER_COMMIT below is recorded AS SUPPLIED, not re-verified from inside the job.
#
# Unlike the candidate launchers (which write ONE track per window), this job writes THREE tracks per window
# (whisper-auto, whisper-cap2, sravaani) to the SAME manifest - same 2-phase pattern (scratch write here,
# real commit via commit_scored_tracks.py afterward). No K2 TrackExistsError handling is needed here (LOCAL_ROOT
# is a fresh scratch dir every job run, so a collision would be a genuine bug in this script, not a real
# concurrent-write scenario) - K2 conflict logic lives entirely in commit_scored_tracks.py, which handles
# whatever gets downloaded from here exactly the same way regardless of whether it came from an HF job or the
# (now-paused) box-local driver. A write_track() exception OTHER than the engine call itself failing (a
# ValidationError/PathComponentError from a bad manifest_stub field) is still caught per-window and recorded,
# rather than crashing the whole remaining batch and wasting the rest of this job's GPU rental (same shape as
# reb's #5279 finding on the box-local driver, applied here proactively rather than waiting to hit it for real).
#
# commit_scored_tracks.py's new _assert_all_manifests_exist() guard (b9f4c8e8) means: if candidates for set (c)
# are committed via a SEPARATE job/commit step, THIS baseline job's commit must run first (it's the one that
# creates each window's manifest via manifest_stub) - same ordering as the box-local plan, just both halves now
# run on HF instead of one being box-local.
#
# NOT YET RUN - not even a smoke test. Needs bucket/kit prep (see above) and both checkers' + reb's PASS before
# any real launch, matching the gate on every other scored write this bake-off (eta-bus is down as of this
# writing; post for review the moment it reconnects).
"""W50 terms bake-off: set (c) baselines (whisper-auto, whisper-cap2, sravaani) via ephemeral HF Job.

Starts a job-local whisper.cpp server + a job-local sravaani service, then runs kit/reb_runner/engines'
whisper.py/box_twin.py UNCHANGED against them for every window in WINDOWS, writing REB-shaped track JSON to a
scratch root for later download + commit_scored_tracks.py (same 2-phase pattern as the candidate launchers).
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

KIT_ROOT = os.environ.get("KIT_ROOT", "/mnt/kit")
sys.path.insert(0, os.path.join(KIT_ROOT, "terms"))
sys.path.insert(0, KIT_ROOT)

from reb import write_track  # noqa: E402
from reb_runner.engines import whisper, box_twin  # noqa: E402
from pinned_configs import assert_pinned, PinnedConfigMismatch, config_hash as recompute_config_hash  # noqa: E402

LOCAL_ROOT = "/tmp/reb-local"
BUCKET_ROOT = os.environ.get("REB_BUCKET_ROOT", "/mnt/reb")
OUT_PREFIX = os.environ["REB_OUT_PREFIX"]  # no default - must be private, holds real patient transcript text
AUDIO_ROOT = os.environ.get("AUDIO_ROOT", "/mnt/audio")
MACHINE = os.environ.get("HF_JOB_ID") or os.environ.get("HOSTNAME") or "hf-job-unknown"
LAYER = "stt"  # matches the box-local baseline convention, distinct from candidates' "terms" layer

REB_LIB_COMMIT = os.environ.get("REB_LIB_COMMIT", "unknown-set-REB_LIB_COMMIT-at-launch")
REB_RUNNER_COMMIT = os.environ.get("REB_RUNNER_COMMIT", "unknown-set-REB_RUNNER_COMMIT-at-launch")  # AS SUPPLIED,
# not self-verified from inside this job (see module docstring) - verify at kit-bucket-build time instead.
TERMS_COMMIT = os.environ.get("TERMS_COMMIT", "unknown-set-TERMS_COMMIT-at-launch")

WHISPER_CPP_COMMIT = "e0fd1f67"  # ggerganov/whisper.cpp v1.8.5 - the exact commit this box's build-l4 used
WHISPER_CPP_SRC = "/tmp/whisper-cpp-src"
WHISPER_SERVER_BIN = os.path.join(WHISPER_CPP_SRC, "build", "bin", "whisper-server")
WHISPER_MODEL_REPO = "ggerganov/whisper.cpp"
WHISPER_MODEL_FILE = "ggml-large-v3-turbo.bin"
WHISPER_MODEL_SHA256 = "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69"
WHISPER_MODEL_DIR = "/tmp/whisper-model"
WHISPER_PORT = 8080
SRAVAANI_PORT = 8085
SRAVAANI_SCRIPT = os.path.join(KIT_ROOT, "sravaani_server.py")

SRAVAANI_MODEL = "ARTPARK-IISc/SraVaani-1.0"
SRAVAANI_VERSION = "v1"
SRAVAANI_CHUNK_S = 30


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def claim_windows():
    """Each entry: {"window_id", "audio_file", "room_id", "ist_date", "manifest_stub"} - computed LOCALLY on the
    box via build_windows_set_c() (this job has no access to the local hist-inventory files that requires) and
    passed in at launch time, same as the candidate launchers' WINDOWS env var."""
    return json.loads(os.environ["WINDOWS"])


def build_whisper_server():
    """Clones+builds ggerganov/whisper.cpp at WHISPER_CPP_COMMIT with the same CUDA target this box's own
    build-l4 uses. NOT unit-testable in this sandbox (no GPU/cmake/network here) - see module docstring."""
    if not os.path.isdir(os.path.join(WHISPER_CPP_SRC, ".git")):
        subprocess.run(["git", "clone", "https://github.com/ggerganov/whisper.cpp.git", WHISPER_CPP_SRC], check=True)
    subprocess.run(["git", "-C", WHISPER_CPP_SRC, "checkout", WHISPER_CPP_COMMIT], check=True)
    build_dir = os.path.join(WHISPER_CPP_SRC, "build")
    subprocess.run(
        ["cmake", "-B", build_dir, "-S", WHISPER_CPP_SRC, "-DGGML_CUDA=ON", "-DCMAKE_CUDA_ARCHITECTURES=89",
         "-DCMAKE_BUILD_TYPE=Release"],
        check=True,
    )
    subprocess.run(["cmake", "--build", build_dir, "--config", "Release", "-j"], check=True)
    if not os.path.exists(WHISPER_SERVER_BIN):
        raise RuntimeError(f"whisper.cpp build succeeded but {WHISPER_SERVER_BIN} was not produced")
    return WHISPER_SERVER_BIN


def download_whisper_model():
    """-> local path to a verified copy of ggml-large-v3-turbo.bin. Refuses (does not use) any download whose
    sha256 doesn't match this box's own reference copy - see module docstring for the unverified-provenance
    caveat."""
    from huggingface_hub import hf_hub_download

    os.makedirs(WHISPER_MODEL_DIR, exist_ok=True)
    downloaded = hf_hub_download(repo_id=WHISPER_MODEL_REPO, filename=WHISPER_MODEL_FILE, local_dir=WHISPER_MODEL_DIR)
    actual = _sha256_file(downloaded)
    if actual != WHISPER_MODEL_SHA256:
        raise RuntimeError(
            f"downloaded {WHISPER_MODEL_FILE} sha256={actual} != expected {WHISPER_MODEL_SHA256} (this box's "
            f"own reference copy) - refusing to use an unverified model file."
        )
    return downloaded


def _wait_for_health(url, timeout_s=300, interval_s=2):
    import requests

    t0 = time.time()
    last_exc = None
    while time.time() - t0 < timeout_s:
        try:
            r = requests.get(url, timeout=5)
            if r.status_code == 200:
                return
        except Exception as e:
            last_exc = e
        time.sleep(interval_s)
    raise RuntimeError(f"{url} did not become healthy within {timeout_s}s (last error: {last_exc!r})")


def start_whisper_server(binary_path, model_path):
    proc = subprocess.Popen(
        [binary_path, "-m", model_path, "--no-speech-thold", "0.7", "--suppress-nst", "--port", str(WHISPER_PORT)]
    )
    _wait_for_health(f"http://127.0.0.1:{WHISPER_PORT}/health")
    return proc


def start_sravaani_server():
    """Forces CPU explicitly (see module docstring's K1/K2 note) - SRAVAANI_DEVICE=cpu on top of the CPU-only
    torch wheel already pinned in this script's dependency block, defense in depth."""
    env = dict(os.environ, SRAVAANI_DEVICE="cpu", SRAVAANI_PORT=str(SRAVAANI_PORT))
    proc = subprocess.Popen([sys.executable, SRAVAANI_SCRIPT], env=env)
    _wait_for_health(f"http://127.0.0.1:{SRAVAANI_PORT}/healthz")
    return proc


def _sravaani_device():
    import requests

    return requests.get(f"http://127.0.0.1:{SRAVAANI_PORT}/healthz", timeout=5).json().get("device")


def _write_track_or_error(window_id, stub, track):
    """-> None on success, or a conflict-shaped dict on a write_track failure OTHER than a clean write. LOCAL_ROOT
    is a fresh scratch dir every job run, so no K2 TrackExistsError handling is needed here (that logic lives in
    commit_scored_tracks.py, applied uniformly to whatever gets downloaded from here) - but a ValidationError/
    PathComponentError from a bad manifest_stub field must still be caught per-window rather than crash the
    whole remaining batch (reb #5279's finding, applied here proactively)."""
    try:
        write_track(LOCAL_ROOT, stub["ist_date"], stub["room_id"], window_id, track, manifest_stub=stub)
        return None
    except ValueError as e:
        print(f"  WRITE FAILED (not written): {type(e).__name__}: {e}", flush=True)
        return {"window_id": window_id, "engine": track.get("engine"), "kind": "write_error",
                "error": f"{type(e).__name__}: {e}"}


def _failed_track(template, exc):
    return {**template, "status": "failed", "reason": f"{type(exc).__name__}: {exc}"[:500], "segments": []}


def run_whisper_variant(variant, window_id, wav_path, duration_ms, stub):
    config, cfg_hash = whisper.expected_config(variant)
    try:
        assert_pinned(variant, config)
    except PinnedConfigMismatch as e:
        raise PinnedConfigMismatch(f"{variant}: {e}") from e
    try:
        track = whisper.build_track(window_id, wav_path, duration_ms, variant, machine=MACHINE)
    except Exception as e:
        track = _failed_track(
            {"schema": "reb.track.v1", "window_id": window_id, "layer": LAYER, "engine": variant,
             "model": whisper.MODEL, "version": whisper.VERSION, "config": config, "config_hash": cfg_hash,
             "machine": MACHINE},
            e,
        )
    return track, _write_track_or_error(window_id, stub, track)


def run_sravaani(window_id, wav_path, duration_ms, stub):
    config = {"backend": "box-twin-cpu", "chunk_s": SRAVAANI_CHUNK_S}
    cfg_hash = recompute_config_hash(config)
    try:
        assert_pinned("sravaani", config, dataset_set="c")
    except PinnedConfigMismatch as e:
        raise PinnedConfigMismatch(f"sravaani: {e}") from e
    try:
        track = box_twin.build_sravaani_track(window_id, wav_path, machine=MACHINE, chunk_s=SRAVAANI_CHUNK_S)
    except Exception as e:
        track = _failed_track(
            {"schema": "reb.track.v1", "window_id": window_id, "layer": LAYER, "engine": "sravaani",
             "model": SRAVAANI_MODEL, "version": SRAVAANI_VERSION, "config": config, "config_hash": cfg_hash,
             "machine": MACHINE},
            e,
        )
    return track, _write_track_or_error(window_id, stub, track)


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
    runs_dst_dir = os.path.join(BUCKET_ROOT, OUT_PREFIX, "_runs")
    os.makedirs(runs_dst_dir, exist_ok=True)
    dst = os.path.join(runs_dst_dir, f"{MACHINE}.json")
    with open(dst, "w") as f:
        json.dump(record, f, indent=2, sort_keys=True)
    return dst


def main():
    windows = claim_windows()
    print(f"[baselines-hf] claimed {len(windows)} windows: {[w['window_id'] for w in windows]}", flush=True)

    print("[baselines-hf] building whisper.cpp ...", flush=True)
    whisper_bin = build_whisper_server()
    print("[baselines-hf] downloading + verifying ggml model ...", flush=True)
    model_path = download_whisper_model()
    whisper_proc = start_whisper_server(whisper_bin, model_path)
    print(f"[baselines-hf] whisper-server up (pid={whisper_proc.pid})", flush=True)

    sravaani_proc = start_sravaani_server()
    sravaani_device = _sravaani_device()
    print(f"[baselines-hf] sravaani-twin up (pid={sravaani_proc.pid}) device={sravaani_device!r}", flush=True)
    if sravaani_device != "cpu":
        raise RuntimeError(
            f"sravaani reports device={sravaani_device!r}, expected 'cpu' - the pinned config claims "
            f"backend=box-twin-cpu; refusing to write under a config_hash that would misrepresent the actual "
            f"inference backend used."
        )

    conflicts = []
    tally = {}
    results = []
    try:
        for i, w in enumerate(windows):
            window_id, audio_file = w["window_id"], w["audio_file"]
            room_id, ist_date = w["room_id"], w["ist_date"]
            stub = w["manifest_stub"]
            audio_path = os.path.join(AUDIO_ROOT, audio_file)
            audio_sha256 = _sha256_file(audio_path)
            expected_sha256 = stub["audio"]["sha256"]
            if audio_sha256 != expected_sha256:
                raise ValueError(
                    f"{window_id}: downloaded {audio_path} sha256={audio_sha256} != manifest_stub's recorded "
                    f"sha256={expected_sha256} - refusing to write (never trust a precomputed manifest_stub "
                    f"without checking the actual bytes it's paired with)"
                )
            duration_ms = stub["t1_ms"] - stub["t0_ms"]

            print(f"[baselines-hf] === {i + 1}/{len(windows)} {window_id} ===", flush=True)
            for variant in ("whisper-auto", "whisper-cap2"):
                track, err = run_whisper_variant(variant, window_id, audio_path, duration_ms, stub)
                if err is not None:
                    conflicts.append(err)
                else:
                    tally.setdefault(variant, {}).setdefault(track["status"], 0)
                    tally[variant][track["status"]] += 1
                    print(f"  [{variant}] wrote status={track['status']}", flush=True)
                results.append({"window_id": window_id, "engine": variant, "status": track["status"]})

            track, err = run_sravaani(window_id, audio_path, duration_ms, stub)
            if err is not None:
                conflicts.append(err)
            else:
                tally.setdefault("sravaani", {}).setdefault(track["status"], 0)
                tally["sravaani"][track["status"]] += 1
                print(f"  [sravaani] wrote status={track['status']}", flush=True)
            results.append({"window_id": window_id, "engine": "sravaani", "status": track["status"]})

            dst = upload_window(ist_date, room_id, window_id)
            results[-1]["uploaded_to"] = dst
    finally:
        for proc in (whisper_proc, sravaani_proc):
            proc.terminate()

    run_manifest = {
        "job_id": MACHINE, "engines": ["whisper-auto", "whisper-cap2", "sravaani"],
        "whisper_cpp_commit": WHISPER_CPP_COMMIT, "whisper_model_sha256": WHISPER_MODEL_SHA256,
        "sravaani_device": sravaani_device, "n_windows": len(windows), "tally": tally, "conflicts": conflicts,
        "reb_lib_commit": REB_LIB_COMMIT, "reb_runner_commit": REB_RUNNER_COMMIT, "terms_commit": TERMS_COMMIT,
    }
    run_manifest_dst = upload_run_manifest(run_manifest)
    print(f"[baselines-hf] run manifest uploaded to {run_manifest_dst}", flush=True)

    print("[baselines-hf] === SUMMARY ===", flush=True)
    print(json.dumps({"tally": tally, "conflicts": conflicts, "n_results": len(results)}, indent=2), flush=True)
    if conflicts:
        print(f"[baselines-hf] *** {len(conflicts)} CONFLICTS NEED HUMAN REVIEW *** "
              f"{json.dumps(conflicts, indent=2)}", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
