#!/usr/bin/env python3
"""orders/queue 001-herdr-kit.md item 2. Fetch a room-diarize-window's clip audio via the
Scribe MCP instead of direct R2 access -- the real R2 keys don't exist on the Mini or the box
(.env.local's values are placeholders; the real ones live only in Vercel prod, confirmed 23 Sep).

scribe_extract_audio (the obvious tool) needs "invoke" scope -- confirmed live, 403 with the
token at ~/.claude/secrets/scribe_mcp_token, which only holds "read". scribe_get_recording
(mode=manifest, the default) is scope:"read" and gives every chunk's r2_key/started_at/
ended_at/duration_ms PLUS a presigned_get for each in one call -- this fetches the window by
finding every chunk that overlaps its [start,end) itself, trimming each to the overlap, and
concatenating with ffmpeg. Chunks run ~5 min each, so a 15-min window is normally 3-4 chunks.

A window's session_id and UTC time range are read from room_diarize_window.clip_r2_key (shape:
clips/<session_id>/<START>Z-<END>Z-<label>.<ext>) via kit/neon-select.mjs. Never logs a
presigned URL.

TIMING CORRECTNESS (eta-refuter-2 FAIL K1/K2, 23 Sep -- studies/2026-09-23-queue001-kit-refuter-2/
VERDICT.md; every window exported before this fix must be re-fetched):
- K1: the original trim() put `-ss` BEFORE `-i` with `-c copy` (stream copy). On webm/opus that
  can only start at a seek point AT OR BEFORE the requested offset, so the cut starts early and
  everything in it lands late against the window's real clock -- reproduced synthetically as a
  2.5s shift, and it explains the "903s from a 900s window" this module's own live check saw
  and treated as harmless keyframe rounding. Fixed: every chunk is DECODED with OUTPUT-side
  seeking (`-i src -ss off -t dur -c:a pcm_s16le`), which seeks exactly, then the PCM pieces are
  concatenated and only the final result is re-encoded to whatever the caller asked for.
- K2, ROUND 2 (eta-refuter-2, 24 Sep, studies/2026-09-23-vad-v3/REVIEW-eta-refuter-2.md): the
  first K2 fix padded real inter-chunk gaps with silence to preserve wall-clock alignment -- that
  was wrong. bench-join.ts:221 trims the production clip "against the JOINED stream, which has
  no gaps in it": the teacher (pyannote.ai) labels were generated on GAP-CLOSED audio, so padding
  a gap shifts everything after it LATE relative to the labels by exactly the pad duration --
  reproduced live: two nrqthr5b windows measured +5.6/+5.8s misaligned after a ~5.5s padded gap,
  aligned before it. Fixed: chunks are concatenated back-to-back with no padding, matching
  bench-join's gap-closing, and the duration check is against the sum of the chunks' own trimmed
  durations (the audio actually covered), not the window's nominal wall-clock length -- a window
  with a real gap is now shorter than (end - start), by design, same as production's clip.
- Both are checked, not just fixed: the final output duration must land within 0.1s of what was
  actually decoded or this raises ClipFetchError -- a wrong-length result is a bug to fix, never
  a result to hand to a caller.
"""
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from clip_fetch_mcp import call, McpError  # noqa: E402

ETA_REPO = os.path.expanduser("~/dev/Even-Transcription-Assistant")
NEON_SELECT = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")
R2_KEY_RE = re.compile(r"^clips/([^/]+)/(\d{8}T\d{6}Z)-(\d{8}T\d{6}Z)-")
WINDOW_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
DURATION_TOLERANCE_S = 0.1


class ClipFetchError(RuntimeError):
    pass


def neon_select(sql):
    r = subprocess.run(["node", NEON_SELECT, sql], cwd=ETA_REPO, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"neon-select failed: {r.stderr.strip()[:500]}")
    return json.loads(r.stdout)


def clip_key_for(window_id):
    if not WINDOW_ID_RE.match(window_id):
        raise RuntimeError(f"window_id has unexpected characters, refusing to interpolate into SQL: {window_id!r}")
    rows = neon_select(f"SELECT clip_r2_key FROM room_diarize_window WHERE window_id = '{window_id}'")
    if not rows or not rows[0].get("clip_r2_key"):
        raise RuntimeError(f"no clip_r2_key for window {window_id}")
    return rows[0]["clip_r2_key"]


def parse_clip_key(key):
    m = R2_KEY_RE.match(key)
    if not m:
        raise RuntimeError(f"clip_r2_key does not match the expected clips/<session>/<start>Z-<end>Z-... shape: {key}")
    session_id, start_z, end_z = m.groups()
    start_utc = datetime.datetime.strptime(start_z.rstrip("Z"), "%Y%m%dT%H%M%S").replace(tzinfo=datetime.timezone.utc)
    end_utc = datetime.datetime.strptime(end_z.rstrip("Z"), "%Y%m%dT%H%M%S").replace(tzinfo=datetime.timezone.utc)
    return session_id, start_utc, end_utc


def parse_iso(ts):
    return datetime.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.timezone.utc)


def fetch_url(url, out_path):
    with urllib.request.urlopen(url, timeout=120) as resp, open(out_path, "wb") as f:
        f.write(resp.read())


def decode_trim(src, out_path, offset_s, duration_s):
    """Output-side seek + decode: exact, unlike `-ss` before `-i` with `-c copy` (K1)."""
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-ss", f"{offset_s:.3f}", "-t", f"{duration_s:.3f}",
         "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out_path],
        check=True,
    )


def probe_duration_s(path):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True,
    )
    return float(r.stdout.strip())


def fetch_window_clip(window_id, out_path):
    """Fetch one window's clip audio to out_path. Raises ClipFetchError on any failure
    (lookup, MCP refusal, no covering chunk, a result that doesn't match the window's real
    length) -- callers decide skip-vs-abort. Returns (chunk_count, session_id) on success."""
    try:
        key = clip_key_for(window_id)
        session_id, win_start, win_end = parse_clip_key(key)
    except RuntimeError as e:
        raise ClipFetchError(f"LOOKUP FAILED: {e}") from e
    window_len_s = (win_end - win_start).total_seconds()

    try:
        manifest = call("scribe_get_recording", {"session_id": session_id, "mode": "manifest"})
    except McpError as e:
        raise ClipFetchError(f"MCP CALL FAILED: {e}") from e
    if manifest.get("error"):
        raise ClipFetchError(f"SCRIBE REFUSED: {manifest['error']}")

    covering = []
    for c in manifest.get("chunks", []):
        c_start, c_end = parse_iso(c["started_at"]), parse_iso(c["ended_at"])
        if c_end > win_start and c_start < win_end and c.get("presigned_get"):
            covering.append((c, c_start, c_end))
    covering.sort(key=lambda t: t[1])

    if not covering:
        raise ClipFetchError(f"no chunk covers [{win_start.isoformat()}, {win_end.isoformat()})")

    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    # Private scratch dir for patient audio (Fable, 23 Sep, on top of eta-refuter-2's K-lower):
    # mkdtemp defaults to 0700 and is chmod'd explicitly anyway, but files CREATED inside it
    # (by ffmpeg, not by this process) would still follow the process's own umask -- 077 makes
    # every one of those 0600 too, not just the directory. Restored in finally regardless of
    # how this function exits. Never the shared, world-readable-by-default /tmp namespace
    # tempfile.mktemp() used before; the whole dir is removed in finally even on a failed
    # download or trim (the old code leaked raw_path in that case).
    old_umask = os.umask(0o077)
    tmp_root = tempfile.mkdtemp(prefix="clip-fetch-")
    os.chmod(tmp_root, 0o700)
    try:
        pcm_pieces = []
        covered_s = 0.0
        for c, c_start, c_end in covering:
            raw_path = os.path.join(tmp_root, f"raw_{len(pcm_pieces)}.webm")
            fetch_url(c["presigned_get"], raw_path)
            overlap_start = max(win_start, c_start)
            overlap_end = min(win_end, c_end)
            offset_s = (overlap_start - c_start).total_seconds()
            duration_s = (overlap_end - overlap_start).total_seconds()
            pcm_path = os.path.join(tmp_root, f"pcm_{len(pcm_pieces)}.wav")
            decode_trim(raw_path, pcm_path, offset_s, duration_s)
            pcm_pieces.append(pcm_path)
            covered_s += duration_s

        pcm_result = os.path.join(tmp_root, "result.wav")
        if len(pcm_pieces) == 1:
            shutil.copyfile(pcm_pieces[0], pcm_result)
        else:
            concat_list = os.path.join(tmp_root, "concat.txt")
            with open(concat_list, "w") as f:
                for p in pcm_pieces:
                    f.write(f"file '{p}'\n")
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat_list,
                 "-c", "copy", pcm_result],
                check=True,
            )

        actual_s = probe_duration_s(pcm_result)
        if abs(actual_s - covered_s) > DURATION_TOLERANCE_S:
            raise ClipFetchError(
                f"result duration {actual_s:.3f}s does not match the covered audio's {covered_s:.3f}s "
                f"(tolerance {DURATION_TOLERANCE_S}s) -- refusing a misaligned result"
            )
        if covered_s > window_len_s + DURATION_TOLERANCE_S:
            raise ClipFetchError(
                f"covered audio {covered_s:.3f}s exceeds the window's own {window_len_s:.3f}s -- "
                f"overlap math is wrong somewhere, refusing"
            )

        if out_path.endswith(".wav"):
            shutil.copyfile(pcm_result, out_path)
        else:
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", pcm_result, out_path], check=True)
    finally:
        os.umask(old_umask)
        shutil.rmtree(tmp_root, ignore_errors=True)
    return len(covering), session_id
