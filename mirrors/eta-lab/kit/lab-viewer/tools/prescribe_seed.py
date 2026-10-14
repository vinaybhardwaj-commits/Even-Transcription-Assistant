#!/usr/bin/env python3
"""W27.4a: build / load the PRESCRIBE side data for the Consult view (one object per room-day, in the private eta-lab-ratings bucket).

  prescribe_seed.py build --scored ~/eta-data/cap/2026-09-25/scored/scored_items.jsonl --links ~/eta-data/cap/2026-09-25/links.jsonl --out ~/eta-data/cap/2026-09-25/prescribe
  prescribe_seed.py load  --dir ~/eta-data/cap/2026-09-25/prescribe        # puts prescribe/<room_id>/<ist_date>.json; refuses to replace an existing object

The objects hold PHI (Rx item text, matched transcript spans): they go ONLY to eta-lab-ratings, which the viewer reads behind Cloudflare Access.
Never print rows. Needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID for `load` (never printed). ist_date = the IST date of the consult span start."""
import argparse, hashlib, json, subprocess, sys
from pathlib import Path

BUCKET = "eta-lab-ratings"
CLASSES = {"CAPTURED", "MISHEARD", "LOST-IN-TRANSLATION", "ABSENT", "ABSENT-SPEECH-GAP"}


def build(scored_path, links_path, out):
    raw = Path(scored_path).read_bytes()
    rows = [json.loads(l) for l in raw.decode().splitlines() if l.strip()]
    spans = {}
    for l in (json.loads(x) for x in Path(links_path).read_text().splitlines() if x.strip()):
        if l.get("span") and len(l["span"]) == 2:
            spans[l["consult_id"]] = l["span"]
    by = {}
    for r in rows:
        if r["class"] not in CLASSES:
            sys.exit(f"unknown class {r['class']!r}")
        sp = spans.get(r["consult_id"])
        if not sp:
            sys.exit(f"consult {r['consult_id']}: no span in links.jsonl")
        date = sp[0][:10]   # the span carries the +05:30 offset: the first 10 chars are the IST date
        c = by.setdefault((r["room"], date), {}).setdefault(r["consult_id"], {"consult_id": r["consult_id"], "t0": sp[0], "t1": sp[1], "basis": r.get("basis", ""), "items": []})
        c["items"].append({"item_id": r["item_id"], "type": r["item_type"], "term": r["term"], "cls": r["class"], "score": r["score"],
                           "matched": r["matched"] or None, "translation_missing": bool(r.get("translation_missing"))})
    out = Path(out)
    src = hashlib.sha256(raw).hexdigest()
    n = 0
    for (room, date), cs in by.items():
        p = out / "prescribe" / room / f"{date}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"schema": 1, "room_id": room, "date": date, "source_sha256": src, "consults": sorted(cs.values(), key=lambda c: c["t0"])}, ensure_ascii=False))
        p.chmod(0o600)
        n += 1
    print(f"built {n} room-day objects, {len(rows)} items, {len({r['consult_id'] for r in rows})} consults; source sha256 {src[:16]}")


def load(d):
    root = Path(d) / "prescribe"
    cwd = Path(__file__).resolve().parents[1]
    for p in sorted(root.glob("*/*.json")):
        key = f"prescribe/{p.parent.name}/{p.name}"
        got = subprocess.run(["npx", "wrangler", "r2", "object", "get", f"{BUCKET}/{key}", "--remote", "--pipe"], capture_output=True, cwd=cwd)
        if got.returncode == 0 and got.stdout:
            sys.exit(f"{key} already exists: refusing to replace it (delete it first, by name, on Fable's word)")
        r = subprocess.run(["npx", "wrangler", "r2", "object", "put", f"{BUCKET}/{key}", "--file", str(p), "--content-type", "application/json", "--remote"], capture_output=True, text=True, cwd=cwd)
        print(("put " if r.returncode == 0 else "FAILED ") + key)
        if r.returncode:
            sys.exit(1)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build"); b.add_argument("--scored", required=True); b.add_argument("--links", required=True); b.add_argument("--out", required=True)
    l = sub.add_parser("load"); l.add_argument("--dir", required=True)
    a = ap.parse_args()
    build(a.scored, a.links, a.out) if a.cmd == "build" else load(a.dir)
