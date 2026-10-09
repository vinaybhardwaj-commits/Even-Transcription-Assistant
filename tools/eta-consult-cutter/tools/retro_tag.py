"""m3-08: tag the existing OPD 4 / OPD 5 clips (consult_zero_ratio, voice_isolated, gating_source). Default is a DRY run: it reads each clip's consult.flac, prints the tags and writes nothing.
--apply rewrites timeline.json atomically (0600, other content kept) and appends ONE updated row per clip through store.append_index (the index stays append-only; no hand edits).
m3-09 (refuter C1): --apply takes the cutter RUN LOCK (the one the hourly run uses) for the whole apply and exits 2 without touching anything when it is held; it re-reads the index under the lock; rows that already carry voice_isolated / gating_source (cut after m3-08, or tagged by an earlier apply) are skipped, so a re-run appends nothing."""
import argparse, json, os, sys, time, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from cutter import config as C, gating as G, store as SO, tape as T, run as R

def vi_for_row(row, by, workdir):
    """vi_frame_share of an existing clip: its consult.flac is loudnorm'ed (the gain breaks the peak test), so the span is re-cut from the tape mirror (CPU, the temp audio is deleted at once). -> (share, speech share, frames) or (None, None, 0)."""
    a, b = G.parse_ist(row["span_start"]), G.parse_ist(row["span_end"])
    pieces, cov = T.plan(by, row["room_id"], a, b)
    if not pieces: return None, None, 0
    work = f"{workdir}/{row['consult_uid']}.vi.m4a"
    try: T.cut(pieces, work, workdir); return G.vi_frame_share(work, None, cov)
    finally:
        if os.path.exists(work): os.remove(work)

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--apply", action="store_true"); a = ap.parse_args(argv)
    lock = None
    if a.apply:
        lock = R.acquire_run_lock()                                                                                  # held (referenced) until main returns
        if lock is None: print(json.dumps({"locked": True, "applied": False, "why": "the cutter run lock is held (hourly run or backfill): nothing changed, retry later"})); return 2
    rows = [r for r in SO.read_index().values() if r.get("status") == "cut" and G.is_macos26_room(r.get("room_slug"))]         # read AFTER the lock: no stale row can overwrite a fresh cut
    already = [r["consult_uid"] for r in rows if "voice_isolated" in r or "gating_source" in r]
    rows = [r for r in rows if r["consult_uid"] not in set(already)]
    out = []; by = T.load_manifest(); workdir = f"{C.E}/consult/cutter-work"; os.makedirs(workdir, mode=0o700, exist_ok=True)
    for r in sorted(rows, key=lambda r: r["span_start"]):
        d = f"{C.CLIPS}/{r['path']}"; f = f"{d}/consult.flac"
        if not os.path.exists(f): out.append((r["consult_uid"], "missing consult.flac")); continue
        t = G.tag(r["room_slug"], G.parse_ist(r["span_start"]), G.zero_ratio(f), vi_for_row(r, by, workdir)[0]); out.append((r["consult_uid"], r["room_slug"][:5], r["ist_date"], t))
        if a.apply:
            tl = json.load(open(f"{d}/timeline.json"))
            if "voice_isolated" in tl: continue                                                                      # the timeline already carries tags (a cut that landed between the index row and now)
            tl.update(t)
            fd = os.open(f"{d}/timeline.json.tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh: json.dump(tl, fh, indent=1)
            os.replace(f"{d}/timeline.json.tmp", f"{d}/timeline.json")
            SO.append_index(dict(r, **t, tagged_at=time.strftime("%Y-%m-%dT%H:%M:%S%z")))
    ok = [o for o in out if len(o) == 4]
    print(json.dumps(dict(apply=a.apply, already_tagged_skipped=len(already), clips=len(out), tagged=len(ok), voice_isolated=sum(o[3]["voice_isolated"] for o in ok), vi_frame_share_ge_min=sum((o[3]["vi_frame_share"] or 0) >= G.VI_SHARE_MIN for o in ok), missing=[o[0] for o in out if len(o) == 2],
                          zero_ratio_min=min((o[3]["consult_zero_ratio"] for o in ok if o[3]["consult_zero_ratio"] is not None), default=None), zero_ratio_max=max((o[3]["consult_zero_ratio"] for o in ok if o[3]["consult_zero_ratio"] is not None), default=None))))
    for o in ok: print(*o[:3], o[3])
    return 0

if __name__ == "__main__": raise SystemExit(main())
