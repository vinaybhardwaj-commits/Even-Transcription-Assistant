"""sarvam_sync_smoke.py: Sarvam SYNC speech-to-text latency smoke (ORDER 21A; research use, for the live copilot baseline).

Takes ONE existing cut consult clip (cutter index row, consult.flac on the box), decodes it to 16 kHz mono, cuts consecutive chunks of --chunk-s seconds (<= 25; the sync limit is
29 s / 10 MB) and sends each chunk, one at a time, to the SYNC route POST /speech-to-text (saaras:v3, mode transcribe) through sarvam_lane.Gateway (the same ZDR gateway, service account
and SigV4 path; Gateway.call_form, no retry so the wall time is the time of one request). Per chunk it measures the request wall time (send to full response), the bytes sent and received
and the chunk's audio seconds; the report has p50 / p95 / max wall and wall / audio_s (per chunk and over the whole run).
Usage contract v1.2: one ledger line per call (sarvam.call.v1: task stt_sync, mode sync, model saaras:v3, use research, scope consult_clip, ref = the consult_uid, chars 0); a call that
raises (timeout, connection error, bad JSON, token error) is ledgered as failed. Stops: any throttled response, or more than STOP_FAILED failed calls. The sink is always closed.
Output is counts and timings only: the transcript is never read into the report, printed or stored. Nothing is written to the REB store. Default is DRY-RUN (decodes nothing and sends
nothing: only the planned chunk count). --write-report FILE writes the same JSON as stdout (0600). The held-out guard (fail closed) is applied to the clip span before any send.
"""
import argparse
import collections
import json
import math
import os
import subprocess
import sys
import time

from . import r2_mirror
from . import sarvam_lane as sl
from .from_hist import GuardUnavailable, load_heldout, window_held

MODEL, MODE, PATH = "saaras:v3", "transcribe", "/speech-to-text"
TASK, SCOPE, USE = "stt_sync", "consult_clip", "research"
MAX_CHUNK_S = 25.0
MIN_TAIL_S = 0.5      # a shorter last piece is not worth a call
MAX_BYTES = 10 * 1024 * 1024
STOP_FAILED = 2
SR = 16000


class Stop(RuntimeError):
    pass


def duration_s(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], capture_output=True, text=True, timeout=60)
    return float(r.stdout.strip())


def decode_chunk(path, start_s, len_s):
    """-> 16 kHz mono 16-bit WAV bytes of [start_s, start_s+len_s) of the clip."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{start_s:.3f}", "-t", f"{len_s:.3f}", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "wav", "-"], capture_output=True, timeout=120)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError("ffmpeg could not decode the chunk")
    return r.stdout


def plan(total_s, chunk_s, max_chunks=0):
    """-> [(start_s, len_s)] consecutive chunks; a tail under MIN_TAIL_S is dropped."""
    out, t = [], 0.0
    while total_s - t >= MIN_TAIL_S and (not max_chunks or len(out) < max_chunks):
        out.append((round(t, 3), round(min(chunk_s, total_s - t), 3)))
        t += chunk_s
    return out


def pct(vals, p):
    """Nearest-rank percentile (p in 0..100); None for no values."""
    if not vals:
        return None
    v = sorted(vals)
    return v[max(0, math.ceil(p / 100 * len(v)) - 1)]


def r3(x):
    return None if x is None else round(x, 3)


def summarize(rows):
    ok = [r for r in rows if r["status"] == "ok"]
    wall, ratio = [r["wall_s"] for r in ok], [r["wall_s"] / r["audio_s"] for r in ok if r["audio_s"] > 0]
    tw, ta = sum(wall), sum(r["audio_s"] for r in ok)
    return {"wall_s": {"p50": r3(pct(wall, 50)), "p95": r3(pct(wall, 95)), "max": r3(max(wall) if wall else None)},
            "wall_per_audio_s": {"p50": r3(pct(ratio, 50)), "p95": r3(pct(ratio, 95)), "max": r3(max(ratio) if ratio else None), "total": r3(tw / ta) if ta else None},
            "ok_audio_s": r3(ta), "ok_wall_s": r3(tw)}


def run(uid, chunk_s=MAX_CHUNK_S, max_chunks=0, write=False, gw=None, sink=None, is_held=None, index_path=sl.CLIP_INDEX, clips_root=sl.CLIPS,
        probe=None, decode=None, clock=time.perf_counter):
    """-> report dict (counts and timings only). Raises nothing for a refused clip: `refused` names the reason."""
    if not 0 < chunk_s <= MAX_CHUNK_S:
        raise ValueError(f"--chunk-s must be in (0, {MAX_CHUNK_S:g}]")
    cnt = collections.Counter()
    rep = {"mode": "write" if write else "dry-run", "chunk_s": chunk_s, "model": MODEL, "stt_mode": MODE, "path": PATH, "refused": None}
    index = sl.latest_rows(index_path) if os.path.exists(index_path) else {}
    row = index.get(uid)
    if row is None:
        rep["refused"] = "not_cutter"
        return rep
    try:
        clip = sl.open_clip(row, clips_root)
    except sl.ClipRefused as e:
        rep["refused"] = str(e).split(":")[0]
        return rep
    if is_held is None or window_held(is_held, row["room_id"], clip["span_start_ms"], clip["span_end_ms"]):
        rep["refused"] = "blind_refused"
        return rep
    probe, decode = probe or duration_s, decode or decode_chunk
    total = probe(clip["path"])
    chunks = plan(total, chunk_s, max_chunks)
    rep.update(clip_audio_s=r3(total), planned_chunks=len(chunks), chunks_total=len(plan(total, chunk_s)))
    rows = []
    if write:
        if gw is None:
            raise ValueError("write needs a gateway")
        if hasattr(gw, "creds"):
            gw.creds()   # mint the token before the first timed request, so it is not counted as latency
        for i, (a, n) in enumerate(chunks):
            wav = decode(clip["path"], a, n)
            if len(wav) > MAX_BYTES:
                raise ValueError("chunk over the 10 MB sync limit")
            key = f"syncsmoke-{i + 1}"
            if sink is not None:
                sink.safe(sink.begin, key, TASK, n, SCOPE, model=MODEL, mode="sync")
            started, throttled_before = time.time(), gw.throttled
            status, http, rid, resp_bytes, empty, reason = "failed", None, None, 0, False, None
            t = clock()
            try:
                r, resp_bytes = gw.call_form(PATH, {"model": MODEL, "mode": MODE}, "file", "chunk.wav", wav, "audio/wav")
                wall = clock() - t
                rid, http = (r or {}).get("request_id"), 200
                empty = not ((r or {}).get("transcript") or "").strip()   # read for emptiness only; never kept
                status = "ok"
            except Exception as e:  # noqa: BLE001 - a timeout, connection error, bad JSON or token error may still have been billed: ledgered as failed
                wall = clock() - t
                http = getattr(e, "status", None)
                if isinstance(e, sl.GatewayError):
                    reason = str(e)[:260]   # built by the gateway: status, path and the first 200 chars of an error body
                cnt["call_errors_" + type(e).__name__] += 1   # class name only
            finally:
                if sink is not None:
                    sink.safe(sink.end, key)
            throttled = gw.throttled > throttled_before
            if sink is not None:
                line = sink.call_line(rid if isinstance(rid, str) and rid else "none", rid if isinstance(rid, str) else None, TASK, n, started, time.time(), status, http, throttled, SCOPE, uid, model=MODEL, use=USE)
                line["mode"], line["chars"] = "sync", 0
                sink.safe(sink.record, line)
            rows.append({"i": i + 1, "start_s": a, "audio_s": n, "wall_s": round(wall, 3), "bytes_sent": len(wav), "bytes_resp": resp_bytes, "status": status, "http": http, "empty_response": empty}
                    | ({"reason": reason} if reason else {}))
            cnt["calls"] += 1
            cnt["call_failures"] += status != "ok"
            cnt["empty_responses"] += empty
            if gw.throttled > 0:
                cnt["stopped_throttled"] = 1
                break
            if cnt["call_failures"] > STOP_FAILED:
                cnt["stopped_failed"] = 1
                break
        cnt["throttled_responses"] = gw.throttled
    rep.update({k: cnt[k] for k in ("calls", "call_failures", "empty_responses", "stopped_throttled", "stopped_failed", "throttled_responses")})
    rep.update({k: v for k, v in cnt.items() if k.startswith("call_errors_")})
    rep["chunks"] = rows
    rep.update(summarize(rows))
    return rep


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--uid", required=True, help="one consult_uid (a cut clip in the cutter index)")
    ap.add_argument("--chunk-s", type=float, default=MAX_CHUNK_S, help="chunk length in seconds (<= 25)")
    ap.add_argument("--max-chunks", type=int, default=0, help="at most N chunks (0 = the whole clip)")
    ap.add_argument("--write", action="store_true", help="send to Sarvam (default: dry-run, nothing is decoded or sent)")
    ap.add_argument("--write-report", default=None, help="also write the report JSON here (0600)")
    ap.add_argument("--index", default=sl.CLIP_INDEX)
    a = ap.parse_args(argv)
    if not 0 < a.chunk_s <= MAX_CHUNK_S:
        print(f"refused: --chunk-s must be in (0, {MAX_CHUNK_S:g}]", file=sys.stderr)
        return 2
    if a.write and r2_mirror.enabled():
        sys.exit("REB_R2_MIRROR is on: sarvam_sync_smoke must not push to R2; unset it")
    try:
        is_held = load_heldout()   # fail closed
    except GuardUnavailable:
        print("refused: held-out guard unavailable", file=sys.stderr)
        return 2
    gw = sink = None
    if a.write:
        keyf = os.environ.get("SARVAM_R2_KEY_FILE")
        sink = sl.UsageSink(put=sl.R2Put(keyf) if keyf and os.path.isfile(keyf) else None)
        gw = sl.Gateway()
        if sink.put is None:
            print("WARNING: SARVAM_R2_KEY_FILE not set: usage ledger and lane file are written locally only", file=sys.stderr)
    try:
        rep = run(a.uid, a.chunk_s, a.max_chunks, a.write, gw, sink, is_held, a.index)
    finally:
        if sink is not None:
            sink.close()
    out = json.dumps(rep, sort_keys=True)
    print(out)
    if a.write_report:
        fd = os.open(a.write_report, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(out + "\n")
        os.chmod(a.write_report, 0o600)
    return 2 if rep["refused"] else 0


if __name__ == "__main__":
    sys.exit(main())
