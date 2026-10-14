#!/usr/bin/env python3
"""Shared helpers for the diar-lab phase-2 durable pipeline: Neon reads (via the
same read-only neon-select.mjs contract, called as a subprocess so credentials
never enter this process's env) and an R2 client for clip audio.

R2 credentials: R2_ACCOUNT_ID, R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID,
R2_SECRET_ACCESS_KEY (names match Even-Transcription-Assistant/.env.example).
Not present on this box as of 2026-09-23 — every R2 call here will raise
until they're provided. The Neon-only parts (querying labels, building/
checking manifests) work today without them.

No transcript text or audio bytes are ever printed by this module — only
ids, counts, and hashes.
"""
import os
import json
import subprocess
import hashlib
import pathlib

NEON_SELECT = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")
ETA_REPO = os.path.expanduser("~/dev/Even-Transcription-Assistant")


def neon_select(sql: str):
    """Run a single read-only SELECT/WITH via the shared helper. Returns parsed rows."""
    r = subprocess.run(
        ["node", NEON_SELECT, sql],
        cwd=ETA_REPO,
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        raise RuntimeError(f"neon-select failed: {r.stderr.strip()[:500]}")
    return json.loads(r.stdout)


def r2_client():
    """Boto3 S3-compatible client for Cloudflare R2. Raises if creds are missing."""
    for var in ("R2_ACCOUNT_ID", "R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        if not os.environ.get(var):
            raise RuntimeError(
                f"R2 credential {var} not set. This box has no R2 access as of 2026-09-23 "
                "(flagged to Fable). Set the R2_* env vars (see Even-Transcription-Assistant/.env.example) "
                "to run this for real."
            )
    import boto3
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",  # the R2 convention (lib/r2.ts uses the same) -- without it,
        # boto3's default region produces a SigV4 signature R2 rejects (400 Bad Request
        # on HeadObject, found live 23 Sep running this for the first time ever with
        # real credentials -- this whole function was previously untested).
    )


def r2_bucket():
    return os.environ.get("R2_BUCKET", "eta-audio")


def fetch_clip(clip_r2_key: str, out_path: str):
    """Download one clip from R2 to out_path. Raises RuntimeError if R2 creds are missing."""
    client = r2_client()
    pathlib.Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    client.download_file(r2_bucket(), clip_r2_key, out_path)


def fetch_clip_via_scribe(window_id: str, out_path: str):
    """Fetch a window's clip via the Scribe MCP (kit/clip_fetch_core.py) instead of R2 direct --
    real R2 keys exist only in Vercel prod (orders/queue 001-herdr-kit.md item 2, 23 Sep); this
    is the unblocked path every caller should use until that changes. Raises RuntimeError
    (wrapping ClipFetchError) on any failure."""
    import sys as _sys
    _sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/kit"))
    from clip_fetch_core import fetch_window_clip, ClipFetchError
    try:
        fetch_window_clip(window_id, out_path)
    except ClipFetchError as e:
        raise RuntimeError(str(e)) from e


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def segments_to_rttm(window_id: str, segments: list, out_path: str):
    """Write pyannote-style RTTM from a {start_ms,end_ms,speaker_idx} segment list.
    RTTM speaker field uses speaker_idx directly (stable, no name/PII)."""
    lines = []
    for seg in segments:
        start_s = seg["start_ms"] / 1000.0
        dur_s = (seg["end_ms"] - seg["start_ms"]) / 1000.0
        if dur_s <= 0:
            continue
        speaker = f"SPK{seg['speaker_idx']}"
        lines.append(
            f"SPEAKER {window_id} 1 {start_s:.3f} {dur_s:.3f} <NA> <NA> {speaker} <NA> <NA>"
        )
    with open(out_path, "w") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))


def weights_sha256(ckpt_path: str) -> str:
    """Hash of the model weights only (sorted state_dict tensors), independent of the checkpoint file's
    bytes. Lightning stores callback state (e.g. ModelCheckpoint.best_model_path) in the file, so two
    bit-identical trainings written to different directories differ as files but not as weights."""
    import torch
    sd = torch.load(ckpt_path, map_location="cpu", weights_only=False)["state_dict"]
    h = hashlib.sha256()
    for k in sorted(sd):
        h.update(k.encode()); h.update(sd[k].cpu().numpy().tobytes())
    return h.hexdigest()
