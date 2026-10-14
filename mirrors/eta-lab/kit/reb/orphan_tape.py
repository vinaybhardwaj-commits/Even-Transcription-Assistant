"""orphan_tape.py: scout and window the ORPHAN OPD 4 tape (ORDERS-PALIMPSEST-13A B4). Read-only on the tape; the windows go to the REB store only with --write.

The tape: <dir>/tape.pcm (raw mono s16le 16 kHz, decimated from a 48 kHz float capture) + tape.idx (JSON lines: byte_offset, wall_ns = the capture wall clock, samples, rms, and
`discontinuity` marks device_lost / resumed / day_rollover / stopped) + tapewriter.log + mic_mode.json. A recording with no session. The index rows give the wall time of
every block, so any byte maps to a wall time and any wall interval to a byte range; a device-loss gap has wall time but no bytes (silence is laid in its place, so the window
keeps the TAPE clock).

scout: format check (the PCM block rms equals the index rms), continuous audio hours vs the wall span, every gap, the share of silent blocks (rms 0), the room claim, and how much of it
the room's primary tape already covers. Counts only.
window: 15-min IST-aligned REB windows `o-<ist_date>_<room_id>_<HHMM>` (the "o-" prefix keeps them apart from the "c-" production/hist windows) over the recorded span: each window's audio is cut
from the PCM at its wall time, encoded to FLAC under <data>/orphan-windows/opd4/<date>/<window_id>.flac, and written as manifest.json through writer.write_manifest with
source_kind room_tape_orphan, clock tape_utc, audio {r2_key local:..., sha256 of the FLAC, sample_rate 16000, duration_ms 900000, extras {covered_fraction, gap_s, tape sha256, byte range}}.
covered_fraction is what the window planner (sarvam_lane.window_plan) reports as coverage, so the driver's coverage >= 0.99 rule sees the device-loss gaps. Existing windows are never
overwritten (counted `exists`). One window per slot (architect 15A ruling #11570): a slot that any window of that room-day already overlaps (the room_windows tape windows, a hist window)
gets no orphan window (counted `exists_overlap`); room_windows applies the same rule the other way round, so whichever runs first wins the slot.
The room: the directory says opd4 and room-labels.json names room_ux92qpws "OPD 4 Ortho"; the primary tape manifest keys that room under bench/opd-4-ortho-...; nothing in the tape itself
states the room (no session), so --room-id is an assertion the scout prints for a human to confirm.
"""
import argparse
import array
import bisect
import datetime
import hashlib
import json
import math
import os
import subprocess
import sys

from . import room_windows as rw
from . import sarvam_lane as sl
from . import writer
from .from_hist import IST, SEALED_WINDOWS, load_heldout, window_held

TAPE_DIR = os.path.expanduser("~/eta-data/orphan-tapes/opd4/bs_vugdwkk9/seg_fa573ff6-6c96-41fe-b494-d75660be8b14")
ROOM_ID, ROOM_SLUG = "room_ux92qpws", "OPD 4 Ortho"
SR, BPS = 16000, 2
WINDOW_S = 900
KIND = "room_tape_orphan"
GAP_TOL_S = 2.0
OUT_SUB = "orphan-windows/opd4"
ROOM_ASSERTION = "room asserted from the tape directory name (opd4) + room-labels.json (room_ux92qpws = OPD 4 Ortho); the tape itself does not state the room (architect #11330 ruling 2)"


def load_index(tape_dir):
    return [json.loads(l) for l in open(os.path.join(tape_dir, "tape.idx")) if l.strip()]


def pieces_of(rows):
    """-> (pieces, gaps). A piece = (wall0_s, wall1_s, byte0, byte1): audio bytes laid on wall time. Consecutive rows with more wall time than audio (> GAP_TOL_S) put the audio at the END of
    the interval (the block was captured when its row was written); `gaps` = [(wall_start_s, gap_s, marked)] for every such stretch, marked = a device_lost / resumed row is involved."""
    pieces, gaps = [], []
    for a, b in zip(rows, rows[1:]):
        nb = b["byte_offset"] - a["byte_offset"]
        w0, w1 = a["wall_ns"] / 1e9, b["wall_ns"] / 1e9
        if nb <= 0:
            if w1 - w0 > GAP_TOL_S:
                gaps.append((w0, w1 - w0, True))
            continue
        ds = nb / (SR * BPS)
        if (w1 - w0) - ds > GAP_TOL_S:
            gaps.append((w0, (w1 - w0) - ds, "discontinuity" in b or "discontinuity" in a))
            w0 = w1 - ds
        elif ds - (w1 - w0) > GAP_TOL_S:
            w1 = w0 + ds
        pieces.append((w0, w1, a["byte_offset"], b["byte_offset"]))
    return pieces, gaps


def check_format(tape_dir, rows, probes=(1, 2, 500, 30000, 60000)):
    """The PCM is mono s16le: the rms of probe blocks read from tape.pcm must equal the index rms. -> (n_checked, n_equal)."""
    n = eq = 0
    with open(os.path.join(tape_dir, "tape.pcm"), "rb") as f:
        for i in probes:
            if i >= len(rows):
                continue
            a, b = rows[i - 1], rows[i]
            if "rms" not in b or b["byte_offset"] <= a["byte_offset"]:
                continue
            f.seek(a["byte_offset"])
            s = array.array("h")
            s.frombytes(f.read(b["byte_offset"] - a["byte_offset"]))
            rms = math.sqrt(sum(x * x for x in s) / len(s)) / 32768 if len(s) else 0.0
            n += 1
            eq += 1 if abs(rms - b["rms"]) < 1e-4 else 0
    return n, eq


def primary_overlap_h(tapes_manifest, room_id, w0, w1):
    """Hours of the room's primary tape chunks that overlap [w0, w1] (epoch seconds)."""
    tot = 0.0
    for l in open(tapes_manifest):
        if not l.strip():
            continue
        r = json.loads(l)
        if r.get("room_id") != room_id or r.get("source", "primary") != "primary":
            continue
        s = datetime.datetime.fromisoformat(r["started_at"].replace("Z", "+00:00")).timestamp()
        e = s + r["duration_ms"] / 1000
        tot += max(0.0, min(e, w1) - max(s, w0))
    return tot / 3600


def ist(ts):
    return datetime.datetime.fromtimestamp(ts, IST).strftime("%Y-%m-%d %H:%M:%S")


def scout(tape_dir=TAPE_DIR, room_id=ROOM_ID, tapes_manifest=os.path.join(sl.TAPES, "manifest.jsonl")):
    rows = load_index(tape_dir)
    pieces, gaps = pieces_of(rows)
    nblk = [(a, b) for a, b in zip(rows, rows[1:]) if b["byte_offset"] > a["byte_offset"]]
    silent = sum(1 for a, b in nblk if b.get("rms", 1) == 0)
    audio_s = sum((p[3] - p[2]) for p in pieces) / (SR * BPS)
    w0, w1 = pieces[0][0], pieces[-1][1]
    pcm_bytes = os.path.getsize(os.path.join(tape_dir, "tape.pcm"))
    n, eq = check_format(tape_dir, rows)
    marks = [(r["discontinuity"], ist(r["wall_ns"] / 1e9)) for r in rows if "discontinuity" in r]
    return {"tape_dir": os.path.basename(tape_dir), "files": sorted(os.listdir(tape_dir)), "idx_rows": len(rows), "pcm_bytes": pcm_bytes,
            "index_end_matches_pcm": rows[-1]["byte_offset"] == pcm_bytes, "format": "mono s16le 16000 Hz (decimated from 48 kHz capture)", "format_probe_blocks": n, "format_probe_rms_equal": eq,
            "device": rows[0].get("device"), "capture_input_rate": rows[0].get("input_sample_rate"),
            "audio_h": round(audio_s / 3600, 3), "wall_start_ist": ist(w0), "wall_end_ist": ist(w1), "wall_span_h": round((w1 - w0) / 3600, 3),
            "gaps_inside_span": [{"at_ist": ist(g[0]), "gap_s": round(g[1], 1), "marked": bool(g[2])} for g in gaps if g[0] < w1],
            "gap_inside_total_s": round(sum(g[1] for g in gaps if g[0] < w1), 1),
            "unrecorded_tail": [{"from_ist": ist(g[0]), "h": round(g[1] / 3600, 3)} for g in gaps if g[0] >= w1],
            "marks": marks, "blocks": len(nblk), "silent_block_share": round(silent / len(nblk), 4) if nblk else None,
            "room_id_asserted": room_id, "room_claim": "directory opd4 + room-labels.json (OPD 4 Ortho); not stated by the tape itself",
            "primary_tape_overlap_h": round(primary_overlap_h(tapes_manifest, room_id, w0, w1), 3) if os.path.exists(tapes_manifest) else None}


# ---------------------------------------------------------------- windows
def window_grid(first_s, last_s):
    """15-min windows aligned to the IST quarter hour covering [first_s, last_s] -> [(t0_s, t1_s)]."""
    t = int(first_s // WINDOW_S) * WINDOW_S
    out = []
    while t < last_s:
        out.append((t, t + WINDOW_S))
        t += WINDOW_S
    return out


def window_pcm(pcm_path, pieces, starts, t0, t1):
    """The window's s16le buffer on its own clock (silence where there is no recording) and the number of recorded samples."""
    n = (t1 - t0) * SR
    buf = bytearray(n * BPS)
    rec = 0
    i = max(0, bisect.bisect_right(starts, t0) - 1)
    with open(pcm_path, "rb") as f:
        while i < len(pieces) and pieces[i][0] < t1:
            p0, p1, b0, b1 = pieces[i]
            i += 1
            lo, hi = max(t0, p0), min(t1, p1)
            if hi <= lo:
                continue
            frac0, frac1 = (lo - p0) / (p1 - p0), (hi - p0) / (p1 - p0)
            s0 = (b0 + int(round(frac0 * (b1 - b0) / BPS)) * BPS)
            s1 = (b0 + int(round(frac1 * (b1 - b0) / BPS)) * BPS)
            if s1 <= s0:
                continue
            f.seek(s0)
            data = f.read(s1 - s0)
            off = int(round((lo - t0) * SR)) * BPS
            data = data[: len(buf) - off]
            buf[off:off + len(data)] = data
            rec += len(data) // BPS
    return buf, rec


def encode_flac(buf, out, runner=subprocess.run):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".part"
    r = runner(["ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0", "-c:a", "flac", "-f", "flac", tmp], input=bytes(buf), capture_output=True)
    if r.returncode != 0 or not os.path.exists(tmp):
        raise RuntimeError("ffmpeg flac encode failed")
    os.replace(tmp, out)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""):
            h.update(b)
    return h.hexdigest()


def make_windows(tape_dir=TAPE_DIR, root=None, data=sl.HOME_DATA, room_id=ROOM_ID, room_slug=ROOM_SLUG, write=False, is_held=None, runner=subprocess.run, min_recorded_s=1.0, tape_sha=None):
    """-> counters. Dry run (default): the plan only (nothing is read from the PCM, nothing written)."""
    root = root or sl.REB_ROOT
    is_held = is_held or load_heldout()   # fail closed
    rows = load_index(tape_dir)
    pieces, gaps = pieces_of(rows)
    starts = [p[0] for p in pieces]
    grid = window_grid(pieces[0][0], pieces[-1][1])
    pcm = os.path.join(tape_dir, "tape.pcm")
    cnt = {"windows": 0, "written": 0, "would_write": 0, "exists": 0, "no_audio": 0, "blind_refused": 0, "sealed": 0, "exists_overlap": 0, "full": 0, "partial": 0, "recorded_h": 0.0, "min_coverage": 1.0}
    tape_sha = tape_sha or (sha256_file(pcm) if write else None)
    spans = {}   # (ist_date, room) -> the spans of the windows already there (and of the ones made in this run)
    for t0, t1 in grid:
        cnt["windows"] += 1
        d = datetime.datetime.fromtimestamp(t0, IST)
        wid = f"o-{d.strftime('%Y-%m-%d')}_{room_id}_{d.strftime('%H%M')}"
        t0_ms, t1_ms = t0 * 1000, t1 * 1000
        rec_est = sum(max(0.0, min(t1, p[1]) - max(t0, p[0])) for p in pieces[max(0, bisect.bisect_right(starts, t0) - 1):] if p[0] < t1)
        if rec_est < min_recorded_s:
            cnt["no_audio"] += 1
            continue
        if wid in SEALED_WINDOWS:
            cnt["sealed"] += 1
            continue
        if is_held(d.strftime("%Y-%m-%d"), room_id) or window_held(is_held, room_id, t0_ms, t1_ms):
            cnt["blind_refused"] += 1
            continue
        wdir = writer._window_dir(root, d.strftime("%Y-%m-%d"), room_id, wid)
        if os.path.exists(os.path.join(wdir, "manifest.json")):
            cnt["exists"] += 1
            continue
        key = (d.strftime("%Y-%m-%d"), room_id)
        if key not in spans:
            spans[key] = rw.existing_spans(root, key[0], room_id)
        if any(a < t1_ms and b > t0_ms for a, b in spans[key]):
            cnt["exists_overlap"] += 1
            continue
        cov = rec_est / WINDOW_S
        cnt["full" if cov >= 0.99 else "partial"] += 1
        cnt["recorded_h"] += rec_est / 3600
        cnt["min_coverage"] = min(cnt["min_coverage"], round(cov, 4))
        if not write:
            cnt["would_write"] += 1
            continue
        buf, rec = window_pcm(pcm, pieces, starts, t0, t1)
        rel = f"{OUT_SUB}/{d.strftime('%Y-%m-%d')}/{wid}.flac"
        out = os.path.join(data, rel)
        encode_flac(buf, out, runner)
        stub = {"window_id": wid, "room_id": room_id, "room_slug": room_slug, "ist_date": d.strftime("%Y-%m-%d"), "t0_ms": t0_ms, "t1_ms": t1_ms, "clock": "tape_utc",
                "source_kind": KIND,
                "audio": {"r2_key": "local:" + rel, "sha256": sha256_file(out), "sample_rate": SR, "duration_ms": WINDOW_S * 1000,
                          "extras": {"covered_fraction": round(rec / (WINDOW_S * SR), 4), "recorded_s": round(rec / SR, 3), "gap_s": round(WINDOW_S - rec / SR, 3),
                                     "tape_dir": os.path.basename(tape_dir), "tape_pcm_sha256": tape_sha, "note": "orphan tape (no session); silence laid where the device was lost",
                                     "room_assertion": ROOM_ASSERTION}}}
        if writer.write_manifest(root, d.strftime("%Y-%m-%d"), room_id, wid, stub):
            cnt["written"] += 1
            spans[key].append((t0_ms, t1_ms))
        else:
            cnt["exists"] += 1
    cnt["recorded_h"] = round(cnt["recorded_h"], 3)
    return cnt


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scout", help="format, gaps, silence, room claim; counts only")
    w = sub.add_parser("window", help="plan (default) or write the 15-min REB windows")
    w.add_argument("--write", action="store_true")
    for p in (s, w):
        p.add_argument("--tape-dir", default=TAPE_DIR)
        p.add_argument("--room-id", default=ROOM_ID)
    w.add_argument("--root")
    a = ap.parse_args(argv)
    if a.cmd == "scout":
        print(json.dumps(scout(a.tape_dir, a.room_id), indent=1))
    else:
        print(json.dumps(make_windows(a.tape_dir, root=a.root, room_id=a.room_id, write=a.write)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
