#!/usr/bin/env python3
"""Read audio chunks directly from R2 via scribe_get_recording (mode=manifest / mode=chunk) — NOT
scribe_extract_audio, which is invoke-scope and blocked. Mirrors night-drain's own path
(fetchChunkLink -> downloadPiece -> ffmpeg join/trim, ~/night-drain/night-drain.mjs:14257-14420),
just reimplemented in Python for this kit. Read-only: never writes to the DB or voiceprint store.
Downloaded chunk bytes are cached locally (out/chunks_cache/) so repeated clips from the same
5-minute chunk cost one download, not one per clip — keeps the request rate modest while
night-drain is still running.
"""
import datetime
import json
import os
import subprocess
import urllib.request

import mcp_client

WORK = os.path.expanduser("~/dev/_fable/e3kit/out")
MANIFEST_DIR = os.path.join(WORK, "manifests")
CHUNK_CACHE_DIR = os.path.join(WORK, "chunks_cache")
FFMPEG = "/opt/homebrew/bin/ffmpeg" if os.path.exists("/opt/homebrew/bin/ffmpeg") else "ffmpeg"
os.makedirs(MANIFEST_DIR, exist_ok=True)
os.makedirs(CHUNK_CACHE_DIR, exist_ok=True)


def iso_ms(s):
    return int(datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def get_manifest(session_id, refresh=False):
    """Manifest carries chunk boundaries + a fresh presigned_get per chunk (1h TTL). Cached on disk;
    refresh=True re-fetches (e.g. if a presigned URL in the cached copy has expired)."""
    path = os.path.join(MANIFEST_DIR, "%s.json" % session_id)
    if not refresh and os.path.exists(path):
        return json.load(open(path))
    r = mcp_client.call("scribe_get_recording", {"session_id": session_id, "mode": "manifest"})
    json.dump(r, open(path, "w"))
    return r


def covering_chunks(manifest, start_ms, end_ms):
    out = []
    for c in manifest["chunks"]:
        cs, ce = iso_ms(c["started_at"]), iso_ms(c["ended_at"])
        if cs < end_ms and ce > start_ms:
            out.append(c)
    out.sort(key=lambda c: c["idx"])
    return out


def download_chunk(session_id, chunk, refresh_manifest=None):
    """Downloads (or reuses a cached copy of) one chunk's raw bytes. presigned_get expires in 1h;
    if the cache miss and the manifest is stale, the caller should pass a freshly refreshed one."""
    local = os.path.join(CHUNK_CACHE_DIR, "%s_%04d.webm" % (session_id, chunk["idx"]))
    if os.path.exists(local) and os.path.getsize(local) == chunk.get("size_bytes"):
        return local
    url = chunk["presigned_get"]
    try:
        urllib.request.urlretrieve(url, local)
    except Exception:
        if refresh_manifest is None:
            raise
        m2 = get_manifest(session_id, refresh=True)
        c2 = next(c for c in m2["chunks"] if c["idx"] == chunk["idx"])
        urllib.request.urlretrieve(c2["presigned_get"], local)
    return local


def extract_clip(session_id, start_ms, end_ms, out_path, fmt="m4a", mono=True, sr=16000):
    """The one function callers use. start_ms/end_ms are absolute epoch ms (same units as a
    window/turn's start_ms/end_ms everywhere else in this kit). Builds the exact span from the
    original chunk(s) — no re-encoding beyond the one final ffmpeg pass, same filter-graph shape as
    join-core.mjs (aformat per input -> concat -> atrim), just for however many chunks this span
    actually touches (almost always one)."""
    m = get_manifest(session_id)
    chunks = covering_chunks(m, start_ms, end_ms)
    if not chunks:
        m = get_manifest(session_id, refresh=True)
        chunks = covering_chunks(m, start_ms, end_ms)
    if not chunks:
        raise RuntimeError("no chunk covers [%d,%d) for %s" % (start_ms, end_ms, session_id))
    local_paths = [download_chunk(session_id, c, refresh_manifest=True) for c in chunks]
    first_start = iso_ms(chunks[0]["started_at"])
    trim_start_s = (start_ms - first_start) / 1000.0
    dur_s = (end_ms - start_ms) / 1000.0

    n = len(local_paths)
    parts = []
    for i in range(n):
        parts.append("[%d:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono[a%d]" % (i, i))
    labels = "".join("[a%d]" % i for i in range(n))
    parts.append("%sconcat=n=%d:v=0:a=1[joined]" % (labels, n))
    parts.append("[joined]atrim=start=%.3f:end=%.3f,asetpts=PTS-STARTPTS[out]" % (trim_start_s, trim_start_s + dur_s))
    graph = ";".join(parts)

    args = [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
    for p in local_paths:
        args += ["-i", p]
    args += ["-filter_complex", graph, "-map", "[out]", "-vn", "-sn", "-dn"]
    if mono:
        args += ["-ac", "1"]
    if fmt == "m4a":
        args += ["-ar", str(sr), "-c:a", "aac", "-b:a", "48k", out_path]
    elif fmt == "mp3":
        args += ["-ar", str(sr), "-c:a", "libmp3lame", "-b:a", "48k", out_path]
    else:
        args += ["-ar", str(sr), "-c:a", "pcm_s16le", out_path]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg failed: %s" % r.stderr[-500:])
    return out_path
