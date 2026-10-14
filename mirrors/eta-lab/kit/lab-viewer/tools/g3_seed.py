#!/usr/bin/env python3
"""FUSER G3 blinded audit: stage a run's items + clips into the private eta-lab-ratings bucket (lid-debug builds the dir; the page only reads it).

  g3_seed.py load --run <run_id> --dir <dir> --sha <items.json sha256, full or >=12 hex prefix, as posted by lid-debug on the bus>

<dir> holds items.json and audio/<item_id>.m4a (and may also hold key.json, which is NEVER read, listed or uploaded by this tool: the A/B key stays
out of every path the viewer and this loader touch). Checks before any upload: items.json sha256 matches the posted sha; every item has exactly the
fields {item_id, consult_id, span, audio_key, A, B} (any other field, e.g. a side label, aborts); ids are [A-Za-z0-9_-]{1,64} and unique; A/B are
strings <=200 chars; every item has its clip and every clip belongs to an item. Uploads clips first, items.json LAST (the page only sees a run once items.json
exists), and refuses to replace an existing g3/<run>/items.json (a new itemset needs a new run id). Needs CLOUDFLARE_API_TOKEN in the environment (never printed)."""
import argparse, hashlib, json, re, subprocess, sys
from pathlib import Path

BUCKET = "eta-lab-ratings"
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
FIELDS = {"item_id", "consult_id", "span", "audio_key", "A", "B"}


def check(dirp, sha):
    d = Path(dirp)
    raw = (d / "items.json").read_bytes()
    got = hashlib.sha256(raw).hexdigest()
    if len(sha) < 12 or not got.startswith(sha.lower()):
        sys.exit(f"items.json sha256 {got[:12]}... does not match the posted sha {sha}")
    data = json.loads(raw)
    items = data["items"] if isinstance(data, dict) else data
    if not isinstance(items, list) or not 1 <= len(items) <= 500:
        sys.exit("items.json: expected 1..500 items")
    ids = []
    for x in items:
        if not isinstance(x, dict) or not (FIELDS - {"audio_key", "span", "consult_id"}) <= set(x) <= FIELDS:
            sys.exit(f"item {x.get('item_id') if isinstance(x, dict) else x!r}: fields must be within {sorted(FIELDS)} (item_id, A, B required); no side labels or extras")
        if not isinstance(x["item_id"], str) or not ID.match(x["item_id"]):
            sys.exit(f"bad item_id {x['item_id']!r}")
        for s in ("A", "B"):
            if not isinstance(x[s], str) or len(x[s]) > 200:
                sys.exit(f"item {x['item_id']}: {s} must be a string <=200 chars")
        ids.append(x["item_id"])
    if len(set(ids)) != len(ids):
        sys.exit("item ids are not unique")
    clips = {p.name[:-4] for p in (d / "audio").glob("*.m4a")} if (d / "audio").is_dir() else set()
    if clips != set(ids):
        sys.exit(f"clips and items disagree: missing clips {sorted(set(ids) - clips)[:3]}, clips without an item {sorted(clips - set(ids))[:3]}")
    return raw, ids


def wrangler(*a):
    return subprocess.run(["npx", "wrangler", "r2", "object", *a, "--remote"], capture_output=True, text=True, cwd=Path(__file__).resolve().parents[1])


def absent(res):
    """True only for a definite not-found; any other failure (auth, network, quota) must NOT read as 'absent' (fail closed)."""
    return res.returncode != 0 and bool(re.search(r"does not exist|not found|NoSuchKey|10007", (res.stderr or "") + (res.stdout or ""), re.I))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["load"]); ap.add_argument("--run", required=True); ap.add_argument("--dir", required=True); ap.add_argument("--sha", required=True)
    a = ap.parse_args()
    if not ID.match(a.run):
        sys.exit("bad run id")
    d = Path(a.dir).expanduser()
    raw, ids = check(d, a.sha)
    tgt = f"{BUCKET}/g3/{a.run}/items.json"
    e = wrangler("get", tgt, "--pipe")
    if e.returncode == 0:
        sys.exit(f"{tgt} already exists: not replaced (marks are keyed to these ids; a new itemset needs a new run id)")
    if not absent(e):
        sys.exit("could not confirm items.json is absent (auth/network error?): refusing to upload; nothing written")
    for i in ids:
        r = wrangler("put", f"{BUCKET}/g3/{a.run}/audio/{i}.m4a", "--file", str(d / "audio" / f"{i}.m4a"), "--content-type", "audio/mp4")
        if r.returncode:
            sys.exit(f"clip upload failed for {i}; items.json NOT uploaded")
    r = wrangler("put", tgt, "--file", str(d / "items.json"), "--content-type", "application/json")
    print(json.dumps({"loaded": a.run, "items": len(ids), "ok": r.returncode == 0}))
    sys.exit(r.returncode)


if __name__ == "__main__":
    main()
