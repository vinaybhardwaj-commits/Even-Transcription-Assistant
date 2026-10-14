"""W50 set (c): decode+concatenate each 'ok' consult's planned segments into one 16kHz mono wav, staged LOCALLY
ONLY (never to a bucket - the actual upload to hf://buckets/vrbeven/eta-parity-io/w50-setc-2026-09-28/ is a
human/Fable-run step, per the independently-confirmed permission-classifier constraint, hf-fleet #5170 / reb
#5171). Writes the per-consult sha256 manifest BEFORE any staging, per refuter-3's #5173/#5196 checklist.

r2_key -> local cached file: reb #5169/#5207 confirmed raw tape chunks are cached at
~/eta-data/hist-mining/audio/bench__<room-slug>__<date>__<session-id>__chunk_NNNNN.webm - i.e. the r2_key's
slashes become double underscores. Verified directly (not assumed) against real files for every chunk this
module needs before writing this code.

refuter-3 review (#5208) fixes, all applied before the bulk run:
D1 - the duration check now compares against the SUM of the planned segments' own local durations, not the full
     span duration. A tolerated (<=2s, ADDENDUM-2 G1) gap inside an otherwise-"ok" crop means the segments
     legitimately cover LESS than the full span - comparing against the full span would wrongly refuse a real
     consult (confirmed: GQlym1Pu... has exactly this shape, a 1.26s tolerated gap, span=815.0s vs
     segment-sum=813.739s - the old check would refuse it). Both durations are now recorded in the manifest row.
D2 - the wav is now decoded to a _tmp path FIRST, duration-checked, and only os.replace()'d into audio/ on
     success - a failed consult never leaves a file in audio/ that isn't in the manifest (which a naive
     "hf cp audio/*" glob could otherwise upload).
D3 - manifest.jsonl is now built as manifest.jsonl.tmp during the run (crash-safe: a partial run's progress is
     still on disk, just not under the final name) and atomically renamed to manifest.jsonl only once the full
     run completes - one run always produces one coherent manifest, never silently-appended duplicate/stale rows
     from a rerun. stage_all() refuses outright if manifest.jsonl already exists.
"""
import hashlib
import json
import os
import subprocess
import uuid

import numpy as np
import soundfile as sf

from build_set_c_crop_plan import build_plan

RAW_AUDIO_ROOT = os.path.expanduser("~/eta-data/hist-mining/audio")
DEFAULT_STAGE_DIR = os.path.expanduser("~/eta-data/terms/setc-stage")
TARGET_SAMPLE_RATE = 16000
DURATION_TOLERANCE_S = 1.0  # refuter-3 #5196/#5208: decoded duration within ~1s of the SEGMENT-SUM duration


def r2_key_to_local_path(r2_key, raw_audio_root=RAW_AUDIO_ROOT):
    return os.path.join(raw_audio_root, r2_key.replace("/", "__"))


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def decode_segment(local_webm_path, start_s, end_s, tmp_dir, sample_rate=TARGET_SAMPLE_RATE):
    """ffmpeg -ss/-to on ONE chunk file -> a float32 mono array at sample_rate. Output-seeking (-ss AFTER -i, not
    before) for accurate frame-level cuts at segment boundaries, not fast/approximate keyframe seeking - boundary
    accuracy matters here since segments get concatenated edge-to-edge."""
    tmp_wav = os.path.join(tmp_dir, f"seg_{uuid.uuid4().hex}.wav")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", local_webm_path,
         "-ss", str(start_s), "-to", str(end_s), "-ac", "1", "-ar", str(sample_rate), tmp_wav],
        check=True, capture_output=True,
    )
    try:
        data, sr = sf.read(tmp_wav, dtype="float32")
        if sr != sample_rate:
            raise ValueError(f"ffmpeg produced {sr}Hz, expected {sample_rate}Hz: {tmp_wav}")
        return data
    finally:
        os.remove(tmp_wav)


def decode_consult(segments, tmp_dir, raw_audio_root=RAW_AUDIO_ROOT, sample_rate=TARGET_SAMPLE_RATE):
    """segments: tape_crop.plan_crop's ordered [{"r2_key", "local_start_s", "local_end_s"}, ...].
    -> (audio: float32 mono array at sample_rate, source_chunk_keys: [r2_key, ...] in order)."""
    arrays = []
    for seg in segments:
        local_path = r2_key_to_local_path(seg["r2_key"], raw_audio_root)
        if not os.path.exists(local_path):
            raise FileNotFoundError(f"{seg['r2_key']} not cached locally at {local_path}")
        arrays.append(decode_segment(local_path, seg["local_start_s"], seg["local_end_s"], tmp_dir, sample_rate))
    audio = np.concatenate(arrays) if len(arrays) > 1 else arrays[0]
    return audio, [seg["r2_key"] for seg in segments]


def stage_consult(result, stage_dir, raw_audio_root=RAW_AUDIO_ROOT, sample_rate=TARGET_SAMPLE_RATE):
    """result: one "ok"-status entry from build_set_c_crop_plan.build_plan(). Decodes to a _tmp path, duration-
    checks against the planned SEGMENT-SUM (not the full span - D1), and only then moves the file into
    <stage_dir>/audio/<consult_id>.wav (D2: a failed consult never leaves a file in audio/). Returns the manifest
    row - never writes the manifest itself, so a manifest row always reflects a real, already-staged file."""
    audio_dir = os.path.join(stage_dir, "audio")
    os.makedirs(audio_dir, exist_ok=True)
    tmp_dir = os.path.join(stage_dir, "_tmp")
    os.makedirs(tmp_dir, exist_ok=True)

    audio, source_chunk_keys = decode_consult(result["segments"], tmp_dir, raw_audio_root, sample_rate)
    tmp_wav_path = os.path.join(tmp_dir, f"{result['consult_id']}_{uuid.uuid4().hex}.wav")
    sf.write(tmp_wav_path, audio, sample_rate, subtype="PCM_16")

    try:
        decoded_duration_s = len(audio) / sample_rate
        span_duration_s = result["duration_s"]
        segment_sum_duration_s = sum(seg["local_end_s"] - seg["local_start_s"] for seg in result["segments"])
        if abs(decoded_duration_s - segment_sum_duration_s) > DURATION_TOLERANCE_S:
            raise ValueError(
                f"{result['consult_id']}: decoded duration {decoded_duration_s:.2f}s differs from the planned "
                f"segment sum {segment_sum_duration_s:.2f}s by more than {DURATION_TOLERANCE_S}s - refusing to "
                f"stage a mismatched file"
            )
        final_wav_path = os.path.join(audio_dir, f"{result['consult_id']}.wav")
        os.replace(tmp_wav_path, final_wav_path)
    except Exception:
        if os.path.exists(tmp_wav_path):
            os.remove(tmp_wav_path)
        raise

    return {
        "consult_id": result["consult_id"], "day": result["day"], "room_id": result["room_id"],
        "span_start": result["span_start"].isoformat(), "span_end": result["span_end"].isoformat(),
        "span_duration_s": round(span_duration_s, 3), "segment_sum_duration_s": round(segment_sum_duration_s, 3),
        "decoded_duration_s": round(decoded_duration_s, 3),
        "n_segments": len(result["segments"]), "source_chunk_keys": source_chunk_keys,
        "sample_rate": sample_rate, "wav_path": final_wav_path, "sha256": _sha256_file(final_wav_path),
    }


def stage_all(stage_dir=DEFAULT_STAGE_DIR, raw_audio_root=RAW_AUDIO_ROOT, sample_rate=TARGET_SAMPLE_RATE):
    """Decodes and stages every "ok" consult. Refuses outright if <stage_dir>/manifest.jsonl already exists (D3:
    one run = one manifest, never silently-appended duplicate/stale rows from a rerun) - remove or move aside the
    old manifest.jsonl (and its audio/ dir, if starting fresh) before re-running. Writes manifest.jsonl.tmp
    incrementally (crash-safe: a partial run's progress is still on disk under that name) and atomically renames
    it to manifest.jsonl only once the full run completes.
    -> (staged: [manifest row, ...], failed: [(consult_id, error), ...])."""
    manifest_path = os.path.join(stage_dir, "manifest.jsonl")
    manifest_tmp_path = manifest_path + ".tmp"
    audio_dir = os.path.join(stage_dir, "audio")
    if os.path.exists(manifest_path):
        raise FileExistsError(
            f"{manifest_path} already exists - refusing to append/overwrite. Move it aside (or its whole "
            f"directory) before re-running, so one run always produces one coherent manifest."
        )
    # refuter-3 #5213 nit: a crashed prior run leaves manifest.jsonl.tmp and/or partial audio/*.wav with no
    # manifest.jsonl to explain them - a fresh run must not silently mix its own output with those leftovers
    # (a consult that fails on the second attempt could leave a stale, unlisted audio/<id>.wav from the first).
    if os.path.exists(manifest_tmp_path):
        raise FileExistsError(
            f"{manifest_tmp_path} exists with no {manifest_path} - looks like a crashed prior run. Move aside "
            f"(or delete) the whole {stage_dir!r} before re-running, so no stale output mixes with a fresh run."
        )
    if os.path.isdir(audio_dir) and os.listdir(audio_dir):
        raise FileExistsError(
            f"{audio_dir} is non-empty with no {manifest_path} - looks like a crashed prior run. Move aside "
            f"(or delete) the whole {stage_dir!r} before re-running, so no stale output mixes with a fresh run."
        )

    results, _excluded_by_span_cap = build_plan()
    ok_results = [r for r in results if r["status"] == "ok"]

    os.makedirs(stage_dir, exist_ok=True)
    staged, failed = [], []
    with open(manifest_tmp_path, "w") as manifest_f:
        for r in ok_results:
            try:
                row = stage_consult(r, stage_dir, raw_audio_root, sample_rate)
            except Exception as e:  # noqa: BLE001 - one bad consult must not abort the whole batch
                failed.append((r["consult_id"], f"{type(e).__name__}: {e}"))
                continue
            manifest_f.write(json.dumps(row, sort_keys=True) + "\n")
            manifest_f.flush()
            staged.append(row)
    os.replace(manifest_tmp_path, manifest_path)
    return staged, failed


if __name__ == "__main__":
    staged, failed = stage_all()
    print(f"[decode] staged={len(staged)} failed={len(failed)}")
    for consult_id, error in failed:
        print(f"[decode] FAILED {consult_id}: {error}")
    if staged:
        total_duration_s = sum(r["decoded_duration_s"] for r in staged)
        max_diff = max(abs(r["decoded_duration_s"] - r["segment_sum_duration_s"]) for r in staged)
        print(f"[decode] total_duration_s={total_duration_s:.1f} max|decoded-segment_sum|={max_diff:.3f}")
    print(f"[decode] output: {DEFAULT_STAGE_DIR}/audio/*.wav, manifest: {DEFAULT_STAGE_DIR}/manifest.jsonl")
    print("[decode] NOTHING has been uploaded anywhere. The bucket copy to "
          "hf://buckets/vrbeven/eta-parity-io/w50-setc-2026-09-28/ is a human/Fable-run step - see the addendum "
          "for the exact command, which copies exactly the files listed in manifest.jsonl (verifying sha256 "
          "before each), not a directory glob.")
