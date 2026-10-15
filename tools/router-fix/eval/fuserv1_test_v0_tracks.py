#!/usr/bin/env python3
"""T-FUSER-2: write the TEST v0 baseline as REB fused tracks (Fable #6159, refuter-2 #5924 conditions 1-5).
One fused track per TEST consult per ETR arm (23 consults x 2 = 46), written by fuser/fuser_v0 through
reb's own writer. fuser_v0 is imported from FUSER_DIR (a clean worktree at c403e9b, so the code sha
recorded in every track's config is that 40-char sha, not this repo's HEAD).
usage: fuserv1_test_v0_tracks.py --windows IDS.txt --sravaani-hash HASH [--root REB] [--out LIST.json] [--write]
Default is a dry run: the full preflight runs and nothing is written. Preflight refuses (all or nothing) on:
  cond 1  fuser_v0 code sha != c403e9b (40 chars), dirty, or reb lib sha != a447dc36
  cond 2  a window not cw-*, not source_kind dev_clip, on the excluded list, or a count != --expect-n;
          a window whose SELECTED SraVaani track (the one fuse_window would read: latest ok) is not the
          pinned config hash, is not ok, or is empty
  cond 3  the TEST v1 run log already exists (v0 tracks must be written before v1 starts)
  cond 4  any fused track of this engine already on the window (new tracks only, no overwrite)
After --write, cond 5: every written track is re-read and compared with an in-memory fuse_window recompute
(segments, byte for byte) for all windows x both arms."""
import argparse, glob, hashlib, json, os, sys, time

FUSER_DIR = os.environ.get("FUSER_DIR", "/tmp/wt-rf-c403e9b/fuser")
sys.path.insert(0, FUSER_DIR)
import fuser_v0 as fv  # noqa: E402
reb_pkg = fv.reb_pkg

EXPECT_FUSER_SHA = "c403e9b6a8f1f2b35c9197fe11f8bd369020d89c"
EXPECT_REB_SHA = "a447dc367d6ba825c9fe63b78fee7a9652bb3988"
EXCLUDED = {"cw-vafxdW8k1Nt4tpyOzHQb"}
RUN_LOG = os.environ.get("TEST_V1_RUN_LOG", "/home/eta/oc/router-fix/eval-out/fuserv1-test-run.log")
ARMS = (("etr_on", True), ("etr_off", False))


class Refuse(Exception):
    pass


def _find_manifest(root, wid):
    hits = glob.glob(os.path.join(root, "*", "*", wid, "manifest.json"))
    if len(hits) != 1:
        raise Refuse(f"{wid}: expected exactly 1 manifest under {root}, found {len(hits)}")
    ist_date, room_id = hits[0].split(os.sep)[-4], hits[0].split(os.sep)[-3]
    with open(hits[0]) as f:
        return ist_date, room_id, json.load(f)


def preflight(ids, root, sravaani_hash, expect_n, expect_sha=EXPECT_FUSER_SHA, expect_reb=EXPECT_REB_SHA,
              run_log=RUN_LOG):
    """Returns [(wid, ist_date, room_id)] or raises Refuse listing every problem found."""
    bad = []
    if fv.FUSER_CODE_SHA != expect_sha or len(fv.FUSER_CODE_SHA or "") != 40:
        bad.append(f"fuser_v0 code sha {fv.FUSER_CODE_SHA!r} != {expect_sha}")
    if fv.FUSER_CODE_DIRTY:
        bad.append("fuser_v0 checkout dirty")
    if fv.REB_SHA != expect_reb:
        bad.append(f"reb lib sha {fv.REB_SHA!r} != {expect_reb}")
    if os.path.exists(run_log):
        bad.append(f"TEST v1 run log exists ({run_log}): v0 tracks must be written before v1 starts")
    if len(ids) != expect_n or len(set(ids)) != len(ids):
        bad.append(f"window count {len(ids)} (unique {len(set(ids))}) != expected {expect_n}")
    out = []
    for wid in ids:
        if not wid.startswith("cw-"):
            bad.append(f"{wid}: not a cw-* consult window"); continue
        if wid in EXCLUDED:
            bad.append(f"{wid}: excluded consult"); continue
        try:
            ist_date, room_id, man = _find_manifest(root, wid)
        except Refuse as e:
            bad.append(str(e)); continue
        if man.get("source_kind") != "dev_clip":
            bad.append(f"{wid}: source_kind {man.get('source_kind')!r} != 'dev_clip'"); continue
        w = reb_pkg.load_window(wid, ist_date=ist_date, room_id=room_id, root=root)
        sel = fv._one(w, "stt", "sravaani")
        if sel is None:
            bad.append(f"{wid}: no ok SraVaani track")
        elif sel.entry.get("config_hash") != sravaani_hash:
            bad.append(f"{wid}: selected SraVaani config {sel.entry.get('config_hash')} != pinned {sravaani_hash}")
        elif not fv._track_spans(sel):
            bad.append(f"{wid}: pinned SraVaani track has no text")
        if w.tracks(layer="fused", engine=fv.FUSER_ENGINE, latest_ok=False):
            bad.append(f"{wid}: a fused {fv.FUSER_ENGINE} track already exists (new tracks only)")
        out.append((wid, ist_date, room_id))
    if bad:
        raise Refuse("REFUSING, nothing written:\n  " + "\n  ".join(bad))
    return out


def _sha256_file(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def run(ids, root, sravaani_hash, expect_n, write, out_path=None, **pf):
    wins = preflight(ids, root, sravaani_hash, expect_n, **pf)
    # dry run of the compute itself, both arms, before any write
    planned = {(wid, arm): fv.fuse_window(wid, ist_date=d, room_id=r, etr_enabled=flag, root=root)
               for wid, d, r in wins for arm, flag in ARMS}
    for (wid, arm), t in planned.items():
        assert t["config"]["etr_enabled"] == dict(ARMS)[arm]
    print(f"preflight OK: {len(wins)} windows, {len(planned)} tracks planned, fuser {fv.FUSER_CODE_SHA}, "
          f"reb {fv.REB_SHA}, sravaani pin {sravaani_hash}")
    if not write:
        print("dry run: nothing written")
        return []
    listing = []
    for wid, d, r in wins:
        for arm, flag in ARMS:
            t = planned[(wid, arm)]
            path = reb_pkg.write_track(root, d, r, wid, t)
            listing.append({"window_id": wid, "arm": arm, "config_hash": t["config_hash"], "path": path,
                            "sha256": _sha256_file(path), "mtime": os.path.getmtime(path),
                            "n_segments": len(t["segments"])})
    # cond 5: recompute in memory, compare with the file on disk
    mism = []
    for row, (wid, d, r) in zip(listing, [(w, d, r) for w, d, r in wins for _ in ARMS]):
        flag = dict(ARMS)[row["arm"]]
        again = fv.fuse_window(wid, ist_date=d, room_id=r, etr_enabled=flag, root=root)
        on_disk = json.load(open(row["path"]))
        a = json.dumps(again["segments"], ensure_ascii=False, sort_keys=True)
        b = json.dumps(on_disk["segments"], ensure_ascii=False, sort_keys=True)
        ta = " ".join(s["text"] for s in sorted(again["segments"], key=lambda s: s["t0_ms"]) if s["text"])
        tb = " ".join(s["text"] for s in sorted(on_disk["segments"], key=lambda s: s["t0_ms"]) if s["text"])
        row["determinism_ok"] = (a == b and ta.encode() == tb.encode())
        if not row["determinism_ok"]:
            mism.append((wid, row["arm"]))
    print(f"wrote {len(listing)} tracks; determinism recompute mismatches: {len(mism)} {mism}")
    if out_path:
        json.dump({"fuser_code_sha": fv.FUSER_CODE_SHA, "reb_sha": fv.REB_SHA, "sravaani_hash": sravaani_hash,
                   "written_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "tracks": listing},
                  open(out_path, "w"), indent=1)
    for row in listing:
        print(f"{row['window_id']}  {row['arm']:7s} {row['config_hash']}  {row['sha256']}  segs={row['n_segments']}")
    if mism:
        raise SystemExit(1)
    return listing


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--windows", required=True, help="text file, one cw-* window_id per line")
    ap.add_argument("--sravaani-hash", required=True)
    ap.add_argument("--root", default=reb_pkg.reb.DEFAULT_ROOT)
    ap.add_argument("--expect-n", type=int, default=23)
    ap.add_argument("--out")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args(argv)
    ids = [l.strip() for l in open(a.windows) if l.strip() and not l.startswith("#")]
    try:
        run(ids, a.root, a.sravaani_hash, a.expect_n, a.write, a.out)
    except Refuse as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
