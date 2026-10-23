"""FRX-V10 Fix3g 1: data/med_master_names.v1.json.gz, the exact full names of the Pulse medicine master (enabled, usage >= 1, not all rows disabled), normalised to lowercase a-z0-9 tokens.
Source: the Orchestrator's export pulse-med-master-23oct.csv (columns src,name,usage,rows_n,all_disabled); only the names are kept, with no usage figures. Run:
python -m tools.eta2freescript.v10._build.make_med_master /path/to/pulse-med-master-23oct.csv   (the source sha is recorded in the output; the sha of the list is in C7)."""
import csv
import gzip
import hashlib
import json
import re
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parents[2] / "data"


def build(src: Path) -> dict:
    raw = src.read_bytes()
    names = set()
    for r in csv.DictReader(raw.decode("utf-8-sig").splitlines()):
        try:
            usage = float(r["usage"] or 0)
        except ValueError:
            continue
        if usage < 1 or r["all_disabled"].strip().lower() == "true":
            continue
        toks = re.findall(r"[a-z0-9]+", r["name"].lower())
        if toks and sum(len(t) for t in toks) >= 3:
            names.add(" ".join(toks))
    return {"version": "med_master_names.v1", "source": "Pulse medicine master export pulse-med-master-23oct.csv (names only; enabled, usage >= 1)", "source_sha256": hashlib.sha256(raw).hexdigest(),
            "generator": "v10/_build/make_med_master.py", "count": len(names), "names": sorted(names)}


def main() -> None:
    d = build(Path(sys.argv[1]))
    (DATA / "med_master_names.v1.json.gz").write_bytes(gzip.compress((json.dumps(d, ensure_ascii=False, indent=0) + "\n").encode("utf-8"), 9, mtime=0))
    print(d["count"], "names from source sha", d["source_sha256"][:12])


if __name__ == "__main__":
    main()
