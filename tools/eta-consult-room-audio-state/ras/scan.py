"""Scan manifest chunks -> per-chunk zero-run features (cached JSONL). Blind room-days are never opened."""
import json, sys, os
from multiprocessing import Pool
from . import zeros
from .blind import blind_room_days
from .classify import parse_ts, ist_day

TAPES = os.path.expanduser("~/eta-data/tapes")
CACHE = os.path.expanduser("~/eta-data/consult/audio-state/cache/feat.jsonl")
VI_CACHE = os.path.expanduser("~/eta-data/consult/audio-state/cache/vi.jsonl")
VI_SINCE = "2026-10-01"      # voice-isolation frame counts are computed from this IST day (macOS 26 Voice Isolation, audio-13)


def is_blind(r, blind):
    return (r["room_id"], ist_day(parse_ts(r["started_at"]))) in blind


def one(job):
    """job = (manifest row, need_feat, need_vi). One decode serves both caches. -> (feat | None, vi | None)."""
    r, need_feat, need_vi = job
    try:
        a = zeros.decode(os.path.join(TAPES, r["path"]))
    except Exception as e:  # keep going; record the failure
        err = {"id": r["id"], "error": str(e)[:200]}
        return (err if need_feat else None), (err if need_vi else None)
    feat = vi = None
    if need_feat:
        feat = zeros.analyse(a, eps=1, min_run_s=1.0)
        feat["id"] = r["id"]
        feat["decoded_ms"] = round(feat.pop("n") / zeros.SR * 1000)
    if need_vi:
        g, sp, n = zeros.vi_bins(a)
        vi = {"id": r["id"], "g": g, "s": sp, "n": n}
    return feat, vi


def purge_blind(cache, rows, blind):
    """Drop cached features of blind room-days. Returns number removed."""
    if not os.path.exists(cache):
        return 0
    bad = {r["id"] for r in rows if is_blind(r, blind)}
    keep, n = [], 0
    for l in open(cache):
        if json.loads(l)["id"] in bad:
            n += 1
        else:
            keep.append(l)
    with open(cache + ".tmp", "w") as f:
        f.writelines(keep)
    os.chmod(cache + ".tmp", 0o600)
    os.replace(cache + ".tmp", cache)
    return n


def todo_vi(rows, done, blind, since=VI_SINCE):
    return [r for r in rows if r["started_at"][:10] >= since and r["id"] not in done and not is_blind(r, blind)]


def todo(rows, done, blind, since="2026-09-18"):
    return [r for r in rows if r["started_at"][:10] >= since and r["id"] not in done and not is_blind(r, blind)]


def _ids(path):
    if not os.path.exists(path):
        return set()
    return {json.loads(l)["id"] for l in open(path)}


def main(out=CACHE, blind=None, vi_out=VI_CACHE):
    blind = blind_room_days() if blind is None else blind
    rows = [json.loads(l) for l in open(os.path.join(TAPES, "manifest.jsonl"))]
    os.makedirs(os.path.dirname(out), mode=0o700, exist_ok=True)
    os.chmod(os.path.dirname(out), 0o700)
    purge_blind(out, rows, blind)
    purge_blind(vi_out, rows, blind)
    need_f = {r["id"] for r in todo(rows, _ids(out), blind)}      # resumable caches
    need_v = {r["id"] for r in todo_vi(rows, _ids(vi_out), blind)}
    jobs = [(r, r["id"] in need_f, r["id"] in need_v) for r in rows if r["id"] in need_f or r["id"] in need_v]
    with Pool(max(1, os.cpu_count() - 2)) as p, open(out, "a") as f, open(vi_out, "a") as v:
        for feat, vi in p.imap_unordered(one, jobs, chunksize=16):
            if feat is not None:
                f.write(json.dumps(feat) + "\n")
            if vi is not None:
                v.write(json.dumps(vi) + "\n")
    os.chmod(out, 0o600)
    os.chmod(vi_out, 0o600)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else CACHE)
