#!/usr/bin/env python3
"""A-REB: per-window acoustics layer (level, noise floor, SNR estimate, clipping, exact-zero
spans / mute signature) for real room days 2026-09-26 and 2026-09-27, written as REB layer=acoustics
tracks (kit/reb, origin/main 06cc655f).

Reuses the W34.2 room-profile DSP (studies/2026-09-27-room-acoustics/chunk_metrics.py: decode(),
db(), get_vad()) rather than re-deriving it, so numbers here are directly comparable to the existing
per-chunk profiles at ~/eta-data/acoustics/2026-09-{26,27}/room_*.json and
~/eta-data/acoustics/work/chunk_metrics.jsonl (used for the 20-window spot-check).

Two modes:
  --dry-run (default)  compute + validate (kit/reb/validate.py) tracks locally, write JSONL to
                        --out; never touches the live REB root. Safe to run before REB windows for
                        these dates exist.
  --write               call kit/reb/writer.write_track for real, once real window_ids/manifest
                        stubs exist for 26/27 Sep (post-[BACKFILL]). Requires --window-map.

CPU only. Caps torch to 2 threads and runs single-process (box CPU already loaded; T4 is W52's/
shared, unused here) per the A-REB order.
"""
import argparse
import hashlib
import json
import os
import socket
import sys
import time

import numpy as np
from scipy import signal

ROOM_ACOUSTICS_DIR = os.path.join(os.path.dirname(__file__), "..", "2026-09-27-room-acoustics")
sys.path.insert(0, os.path.abspath(ROOM_ACOUSTICS_DIR))
import chunk_metrics as cm  # noqa: E402  (reused room-profile DSP: decode/db/get_vad/SR)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, REPO_ROOT)
from kit.reb import validate as reb_validate  # noqa: E402
from kit.reb import writer as reb_writer  # noqa: E402
from kit.reb.schema import SCHEMA_VERSION  # noqa: E402

TAPES = os.path.expanduser("~/eta-data/tapes")
LAYER = "acoustics"
ENGINE = "room_profile_acoustics"
MODEL = "dsp+silero_vad"  # DSP-only (level/clip/mute); silero_vad backs the quiet/speech split for
                          # noise_floor/SNR. Required non-empty field even though this isn't an ML layer.
VERSION = "v1"
CONFIG = {"sr": cm.SR, "mute_min_ms": 200, "clip_thresh": 0.999, "quiet_frame_s": 1}
MACHINE = socket.gethostname()


def config_hash():
    return reb_writer.config_hash(CONFIG)


def find_mute_spans(x, sr, min_ms=200):
    """Contiguous exact-zero-sample runs >= min_ms, as (t0_ms, t1_ms). This is the mute-signature
    check: real recorders drop to a hard 0.0, not just very quiet audio, when a stream mutes."""
    z = (x == 0)
    if not z.any():
        return []
    d = np.diff(z.astype(np.int8))
    starts = np.where(d == 1)[0] + 1
    ends = np.where(d == -1)[0] + 1
    if z[0]:
        starts = np.r_[0, starts]
    if z[-1]:
        ends = np.r_[ends, len(z)]
    out = []
    for s, e in zip(starts, ends):
        dur_ms = (e - s) / sr * 1000
        if dur_ms >= min_ms:
            out.append((int(round(s / sr * 1000)), int(round(e / sr * 1000))))
    return out


def compute_acoustics(rec):
    """One tape chunk -> acoustics metrics. Mirrors chunk_metrics.process()'s quiet/speech VAD split
    (so noise_floor/SNR are directly comparable to the existing profiles) but skips PSD/rt60/hist,
    which this layer doesn't need, and adds mute-span detection which chunk_metrics.py doesn't do."""
    path = os.path.join(TAPES, rec["path"])
    out = {"id": rec["id"], "room_id": rec["room_id"], "started_at": rec["started_at"]}
    try:
        x = cm.decode(path)
    except Exception as ex:
        out["status"] = "failed"
        out["reason"] = f"decode error: {str(ex)[:150]}"
        return out
    n = len(x)
    if n < cm.SR * 5:
        out["status"] = "failed"
        out["reason"] = "short_clip"
        return out
    dur_ms = int(round(n / cm.SR * 1000))
    out["dur_ms"] = dur_ms
    out["level_dbfs"] = round(float(cm.db((x.astype(np.float64) ** 2).mean())), 2)
    out["clip_share"] = float((np.abs(x) >= CONFIG["clip_thresh"]).mean())
    out["mute_spans"] = find_mute_spans(x, cm.SR, CONFIG["mute_min_ms"])
    out["zero_sample_share"] = float((x == 0).mean())

    nf = n // cm.SR
    if nf >= 5:
        fr = x[: nf * cm.SR].reshape(nf, cm.SR).astype(np.float64)
        rdb = cm.db((fr ** 2).mean(1))
        x16 = signal.resample_poly(x, 1, 3).astype(np.float32)
        import torch
        from silero_vad import get_speech_timestamps
        ts = get_speech_timestamps(torch.from_numpy(x16), cm.get_vad(), sampling_rate=16000,
                                    return_seconds=False)
        segs = [(t["start"], t["end"]) for t in ts]
        mask = np.zeros(nf * 100 + 100, bool)
        for s, e in segs:
            mask[s // 160: e // 160 + 1] = True
        dil = np.convolve(mask.astype(float), np.ones(61), "same") > 0
        d1 = dil[: nf * 100].reshape(nf, 100)
        quiet_fr = ~d1.any(1)
        speech_fr = mask[: nf * 100].reshape(nf, 100).mean(1) >= 0.5
        if quiet_fr.sum() >= 5:
            out["noise_floor_dbfs"] = round(float(np.percentile(rdb[quiet_fr], 10)), 2)
        if speech_fr.sum() >= 3:
            sm = np.repeat(mask[: nf * 100], cm.SR // 100)
            xs = x[: nf * cm.SR]
            out["speech_level_dbfs"] = round(float(cm.db((xs[sm].astype(np.float64) ** 2).mean())), 2)
    if "noise_floor_dbfs" in out:
        ref = out.get("speech_level_dbfs", out["level_dbfs"])
        out["snr_db"] = round(ref - out["noise_floor_dbfs"], 2)
    out["status"] = "ok"
    return out


def to_track(m, window_id):
    """m -> a kit/reb track dict, layer=acoustics. Segments use the schema's documented
    'scalar frame-stat -> value instead of text' convention; whole-window scalars span (0, dur_ms),
    mute spans carry their own real (t0_ms, t1_ms)."""
    base = {
        "schema": SCHEMA_VERSION, "window_id": window_id, "layer": LAYER, "engine": ENGINE,
        "model": MODEL, "version": VERSION, "config": CONFIG, "config_hash": config_hash(),
        "machine": MACHINE,
    }
    if m["status"] == "failed":
        return {**base, "status": "failed", "reason": m["reason"]}
    dur = m["dur_ms"]
    segs = [
        {"t0_ms": 0, "t1_ms": dur, "value": m["level_dbfs"], "extras": {"metric": "level_dbfs"}},
        {"t0_ms": 0, "t1_ms": dur, "value": m["clip_share"], "extras": {"metric": "clip_share",
                                                                          "threshold": CONFIG["clip_thresh"]}},
    ]
    if "noise_floor_dbfs" in m:
        segs.append({"t0_ms": 0, "t1_ms": dur, "value": m["noise_floor_dbfs"],
                     "extras": {"metric": "noise_floor_dbfs", "basis": "quiet_frame_p10"}})
    if "snr_db" in m:
        segs.append({"t0_ms": 0, "t1_ms": dur, "value": m["snr_db"], "extras": {"metric": "snr_db"}})
    for s, e in m["mute_spans"]:
        segs.append({"t0_ms": s, "t1_ms": e, "value": round((e - s) / 1000.0, 3),
                     "extras": {"metric": "mute_span"}})
    return {**base, "status": "ok", "segments": segs}


def load_recs(dates):
    out = []
    with open(os.path.join(TAPES, "manifest.jsonl")) as f:
        for line in f:
            r = json.loads(line)
            parts = r["path"].split("/")
            if len(parts) >= 2 and parts[1] in dates:
                out.append(r)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dates", default="2026-09-26,2026-09-27")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default=os.path.expanduser(
        "~/eta-data/acoustics/work/reb_acoustics_dryrun.jsonl"))
    ap.add_argument("--write", action="store_true", help="call reb.writer.write_track for real")
    a = ap.parse_args()

    import torch
    torch.set_num_threads(2)

    dates = a.dates.split(",")
    recs = load_recs(dates)
    if a.limit:
        recs = recs[: a.limit]
    print(f"start: {len(recs)} chunks across {dates}, dry_run={not a.write}", flush=True)

    n_ok = n_failed = n_track_invalid = 0
    with open(a.out, "w") as fo:
        for i, rec in enumerate(recs):
            m = compute_acoustics(rec)
            window_id = rec["id"]  # placeholder key until real REB window_ids land (post-[BACKFILL])
            track = to_track(m, window_id)
            errs = reb_validate.validate_track(track, raise_on_error=False)
            if errs:
                n_track_invalid += 1
                track["_validate_errors"] = errs
            if m["status"] == "ok":
                n_ok += 1
            else:
                n_failed += 1
            fo.write(json.dumps({"rec_id": rec["id"], "room_id": rec["room_id"],
                                  "path": rec["path"], "track": track}) + "\n")
            if i % 200 == 0:
                print(i, flush=True)
    os.chmod(a.out, 0o640)
    print(f"DONE dry-run: {len(recs)} chunks, ok={n_ok} failed={n_failed} "
          f"validate_failed={n_track_invalid}, out={a.out}", flush=True)
    if a.write:
        print("REFUSED: --write requires real window_ids from reb's [BACKFILL] "
              "(none wired in yet) — placeholder rec['id'] keys are not REB window_ids.",
              file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
