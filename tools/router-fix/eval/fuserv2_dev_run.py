#!/usr/bin/env python3
"""FUSER v2-D single DEV run (192 clinical1 windows, both variants D-any / D-two, USD 0, no model call).
Gates (refuses, nothing computed): repo clean and HEAD == --freeze-sha; fuserv1/ and fuser/ byte-identical to
a3be8bcc2d87; the P inputs (s1-results/old/*.result.json) match the pinned sha256 list exactly; every window's
R3/W51 held-out status is checked from catalog metadata (ist_date, room_id) BEFORE any window content is read.
Prints only counts; results are not printed. Output file is created exclusively (no overwrite, no resume).
usage: fuserv2_dev_run.py --freeze-sha SHA --out OUT.jsonl [--catalog C.json] [--p-dir DIR] [--p-list LIST]"""
import argparse, hashlib, json, os, subprocess, sys

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, "/tmp/wt-reb-a447dc36/kit"); sys.path.insert(0, os.path.join(_REPO, "fuserv2"))
sys.path.insert(0, os.path.join(_REPO, "fuserv1")); sys.path.insert(0, os.path.expanduser("~/eta-data/drtpqma"))
import reb as reb_pkg  # noqa: E402
import heldout, lexicon  # noqa: E402
import fuserv2 as f2  # noqa: E402

RX_PATH = "/home/eta/eta-data/cap2/rx_history.jsonl"
V1_FREEZE = "a3be8bcc2d87"
EXCLUDED = {"L041", "L057", "L139", "L182", "cw-vafxdW8k1Nt4tpyOzHQb"}
P_DIR = "/home/eta/oc/router-fix/s1-results/old"
P_LIST = "/home/eta/oc/router-fix/eval-out/v2-p-inputs.sha256"
CATALOG = "/tmp/dev_ingest_catalog_fixed.json"


class Refuse(Exception):
    pass


def _git(*a):
    return subprocess.check_output(["git", "-C", _REPO, *a], text=True).strip()


def gate(freeze_sha, p_dir, p_list, catalog, union):
    bad = []
    if not _git("rev-parse", "HEAD").startswith(freeze_sha):
        bad.append("repo HEAD != freeze sha")
    if _git("status", "--porcelain"):
        bad.append("repo has uncommitted changes")
    if subprocess.call(["git", "-C", _REPO, "diff", "--quiet", V1_FREEZE, "HEAD", "--", "fuserv1", "fuser"]):
        bad.append(f"fuserv1/ or fuser/ differ from {V1_FREEZE}")
    pinned = {}
    for line in open(p_list):
        h, n = line.split(None, 1); pinned[n.strip()] = h
    on_disk = sorted(x for x in os.listdir(p_dir) if x.endswith(".result.json"))
    if sorted(pinned) != on_disk:
        bad.append("P input file set differs from the pinned list")
    for n in on_disk:
        if n in pinned and hashlib.sha256(open(os.path.join(p_dir, n), "rb").read()).hexdigest() != pinned[n]:
            bad.append(f"P input sha256 differs: {n}")
    ids = [n[:-len(".result.json")] for n in on_disk]
    by = {e["window_id"]: e for e in catalog}
    plan = []
    for wid in ids:
        e = by.get(wid)
        if e is None:
            bad.append(f"{wid}: not in catalog"); continue
        if wid in EXCLUDED or heldout.is_held_out(union, e["ist_date"], e["room_id"]):
            bad.append(f"{wid}: excluded / held-out room-day"); continue
        plan.append((wid, e["ist_date"], e["room_id"]))
    if bad:
        raise Refuse("REFUSING, nothing computed:\n  " + "\n  ".join(bad))
    return plan


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--freeze-sha", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--catalog", default=CATALOG); ap.add_argument("--p-dir", default=P_DIR)
    ap.add_argument("--p-list", default=P_LIST)
    a = ap.parse_args(argv)
    if len(a.freeze_sha) < 12 or any(c not in "0123456789abcdef" for c in a.freeze_sha):
        sys.exit("refusing: --freeze-sha must be >= 12 lowercase hex")
    if os.path.exists(a.out):
        sys.exit(f"refusing: {a.out} exists (single run, no overwrite)")
    union, union_sha = heldout.load_union()
    try:
        plan = gate(a.freeze_sha, a.p_dir, a.p_list, json.load(open(a.catalog)), union)
    except Refuse as e:
        sys.exit(str(e))
    lex = f2.Lex(lexicon.load_lexicon(RX_PATH))
    n = 0
    with open(a.out, "x") as out:
        out.write(json.dumps({"header": True, "code": _git("rev-parse", "HEAD"), "lexicon_entries": len(lex.names),
                              "union_sha16": union_sha, "n_windows": len(plan)}) + "\n")
        for wid, day, room in plan:
            def guard(day=day, room=room):
                if heldout.is_held_out(union, day, room):
                    raise Refuse("held-out room-day")
            guard()
            p = json.load(open(os.path.join(a.p_dir, wid + ".result.json")))
            w = reb_pkg.load_window(wid, ist_date=day, room_id=room)
            tr = {}
            for name in f2.TRACKS:
                ts = w.tracks(layer="stt", engine=name)
                if ts:
                    tr[name] = {"status": "ok", "segments": ts[0].segments}
            for variant in ("D-any", "D-two"):
                r = f2.fuse_window(p, tr, lex, variant, guard)
                out.write(json.dumps({"window_id": wid, **r}, ensure_ascii=False) + "\n")
            n += 1
    print(f"wrote {n} windows x 2 variants to {a.out}")


if __name__ == "__main__":
    main()
