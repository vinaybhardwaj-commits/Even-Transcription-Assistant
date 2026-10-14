#!/usr/bin/env python3
"""Build an annotations/<kind>/<room>/<date>/<stamp>-<producer>.json file bound to the source records' sha256 (ruling 341; SCHEMA.md).

  make_annotation.py correction --producer hist-bulk --status undetermined --reason "short-chunk-only window" --record <local run file> [--record ...]
  make_annotation.py correction --producer hist-bulk --spec items.json          # items.json = [{"record": <path>, "status": ..., "reason": ...}, ...]
  make_annotation.py translation --producer linker --spec items.json            # [{"record": <path>, "i": 3, "en": "..."}, ...]

`--record` is the LOCAL copy of a vault run file (.../runs/<run_id>/<room>/<date>/<window>.json); its sha256 is what the Worker compares to
the stored object. One output file per (room, date) found in the records. Writes under --out (default ~/eta-data/lab-vault/staged), never
overwrites (exit 3), prints the paths and counts only. Nothing is uploaded here: vault-push.py does that (HOLD-annotations gate applies).
"""
import argparse, hashlib, json, os, re, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

KINDS = ("translation", "readability", "retranscription", "correction", "speaker")   # selftest is not record-bound: built by its own tool
STATUSES = ("near_silence", "undetermined", "transcribed_unconfirmed")
LAYOUT = re.compile(r"(?:^|/)runs/((?:hist-bulk|hist-miner|vj|production-export|stt-parity)-(?:\d{8}T\d{4}-[0-9a-f]{7,40}|backfill-\d{8}))/([A-Za-z0-9][A-Za-z0-9._-]{0,127})/(\d{4}-\d{2}-\d{2})/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$")
IST = timezone(timedelta(hours=5, minutes=30))


def window_of(path):
    m = LAYOUT.search(Path(path).resolve().as_posix())
    if not m:
        sys.exit(f"not a vault-layout run file (…/runs/<run_id>/<room>/<date>/<window>.json): {path}")
    run, room, date, win = m.groups()
    return f"{run}/{room}/{date}/{win}", room, date


def build(kind, producer, items, out_root, stamp=None):
    """items: [{record, ...fields}] -> {(room, date): path}. Refuses to overwrite."""
    stamp = stamp or datetime.now(IST).strftime("%Y%m%d%H%M")
    groups = {}
    for it in items:
        k, room, date = window_of(it["record"])
        body = {a: b for a, b in it.items() if a != "record"}
        body["k"] = k
        if kind == "correction" and body.get("status") not in STATUSES:
            sys.exit(f"status must be one of {STATUSES}")
        g = groups.setdefault((room, date), {"sources": {}, "items": []})
        g["sources"][k] = hashlib.sha256(Path(it["record"]).read_bytes()).hexdigest()
        g["items"].append(body)
    written = {}
    for (room, date), g in sorted(groups.items()):
        if len(g["sources"]) > 400:
            sys.exit(f"{room} {date}: {len(g['sources'])} distinct windows, at most 400 per file: split the input")
        path = Path(out_root) / "annotations" / kind / room / date / f"{stamp}-{producer}.json"
        doc = {"schema": "eta-lab-annotation/1", "kind": kind, "provenance": {"producer": producer, "created_at": datetime.now(IST).isoformat(timespec="seconds")},
               "sources": g["sources"], "items": g["items"]}
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(path, "x") as f:
                json.dump(doc, f, sort_keys=True)
        except FileExistsError:
            print(f"exists, not overwritten (write-once; use a later --stamp): {path}", file=sys.stderr)
            sys.exit(3)
        written[(room, date)] = path
    return written


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("kind", choices=KINDS)
    ap.add_argument("--producer", required=True)
    ap.add_argument("--record", action="append", default=[])
    ap.add_argument("--status"); ap.add_argument("--reason")
    ap.add_argument("--spec", help="JSON list of items, each with a 'record' path")
    ap.add_argument("--out", default=os.path.expanduser("~/eta-data/lab-vault/staged"))
    ap.add_argument("--stamp", help="YYYYMMDDHHMM (default: now, IST)")
    a = ap.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,39}", a.producer):
        sys.exit("producer must match [a-z][a-z0-9-]{1,39}")
    items = json.load(open(a.spec)) if a.spec else []
    for r in a.record:
        items.append({"record": r, **({"status": a.status} if a.status else {}), **({"reason": a.reason} if a.reason else {})})
    if not items:
        sys.exit("nothing to write: give --record or --spec")
    w = build(a.kind, a.producer, items, a.out, a.stamp)
    print(json.dumps({"files": [str(p) for p in w.values()], "windows": len(items)}))


if __name__ == "__main__":
    main()
