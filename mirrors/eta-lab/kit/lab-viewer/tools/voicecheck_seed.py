#!/usr/bin/env python3
"""/voicecheck: stage one run's items + clips into the private eta-lab-ratings bucket (diar-lab's cutter builds the dir; the page only reads it).

  voicecheck_seed.py load --run <run_id> --dir <dir> --sha <items.json sha256, full or >=12 hex prefix, as posted on the bus> [--dry-run]

<dir> holds items.json and audio/<clip_id>.m4a. items.json must be exactly {"cards":[{"card_id","proposed","clips":[clip_id,...]}], "doctors":[names]}
(doctors optional). ANY other field at any level (is_decoy, kind, session, cluster, source, ...) aborts, so a card-kind cue can never be staged. Ids match
[A-Za-z0-9][A-Za-z0-9_-]{0,63} (no "."), are unique, 1..60 cards, EXACTLY 5 clips per card (A4 4.8: card length must not leak type); every clip has a file and every file belongs to a card. ffprobe is REQUIRED (no ffprobe = abort); an m4a with tags beyond the container brand/encoder aborts (metadata must be stripped at cut time). Uploads clips first, items.json LAST, and
refuses to replace an existing voicecheck/<run>/items.json (items are immutable per run; a new batch needs a new run id). The answer key is never read or
uploaded. Needs CLOUDFLARE_API_TOKEN in the environment (never printed). --dry-run does every check and writes nothing."""
import argparse, hashlib, json, re, shutil, subprocess, sys
from pathlib import Path

BUCKET = "eta-lab-ratings"
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
CLIPS = 5
OK_TAGS = {"major_brand", "minor_version", "compatible_brands", "encoder"}


def nm(x, n):
    return isinstance(x, str) and x.strip() != "" and len(x) <= n


def check(d, sha):
    raw = (d / "items.json").read_bytes()
    got = hashlib.sha256(raw).hexdigest()
    if len(sha) < 12 or not got.startswith(sha.lower()):
        sys.exit(f"items.json sha256 {got[:12]}... does not match the posted sha {sha}")
    data = json.loads(raw)
    if not isinstance(data, dict) or not set(data) <= {"cards", "doctors"} or "cards" not in data:
        sys.exit("items.json: top level must be exactly {cards, doctors?}")
    cards = data["cards"]
    if not isinstance(cards, list) or not 1 <= len(cards) <= 60:
        sys.exit("items.json: 1..60 cards")
    cids, clips = [], []
    for c in cards:
        if not isinstance(c, dict) or set(c) != {"card_id", "proposed", "clips"}:
            sys.exit(f"card fields must be exactly card_id, proposed, clips (got {sorted(c) if isinstance(c, dict) else c!r})")
        if not (isinstance(c["card_id"], str) and ID.match(c["card_id"])) or not nm(c["proposed"], 60):
            sys.exit(f"bad card_id/proposed on {c.get('card_id')!r}")
        if not isinstance(c["clips"], list) or len(c["clips"]) != CLIPS or not all(isinstance(x, str) and ID.match(x) for x in c["clips"]):
            sys.exit(f"card {c['card_id']}: clips must be exactly 5 plain opaque ids (strings)")
        cids.append(c["card_id"]); clips += c["clips"]
    if len(set(cids)) != len(cids) or len(set(clips)) != len(clips):
        sys.exit("card ids and clip ids must each be unique (clips across all cards)")
    docs = data.get("doctors", [])
    if not isinstance(docs, list) or len(docs) > 400 or not all(nm(x, 60) for x in docs):
        sys.exit("doctors: list of <=400 names <=60 chars")
    have = {p.name[:-4] for p in (d / "audio").glob("*.m4a")} if (d / "audio").is_dir() else set()
    if have != set(clips):
        sys.exit(f"clips and items disagree: missing files {sorted(set(clips) - have)[:3]}, files without a card {sorted(have - set(clips))[:3]}")
    if not shutil.which("ffprobe"):
        sys.exit("ffprobe not found: cannot verify m4a metadata is stripped; refusing (install ffmpeg/ffprobe)")
    if True:
        for i in clips:
            p = subprocess.run(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(d / "audio" / f"{i}.m4a")], capture_output=True, text=True)
            if p.returncode:
                sys.exit(f"ffprobe could not read {i}.m4a")
            j = json.loads(p.stdout)
            tags = set((j.get("format") or {}).get("tags") or {}) | {k for s in j.get("streams", []) for k in (s.get("tags") or {}) if k not in ("language", "handler_name", "vendor_id")}
            if tags - OK_TAGS:
                sys.exit(f"{i}.m4a carries metadata tags {sorted(tags - OK_TAGS)}: strip at cut time (ffmpeg -map_metadata -1 -map_chapters -1)")
    return clips


def wrangler(*a):
    return subprocess.run(["npx", "wrangler", "r2", "object", *a, "--remote"], capture_output=True, text=True, cwd=Path(__file__).resolve().parents[1])


def absent(res):
    return res.returncode != 0 and bool(re.search(r"does not exist|not found|NoSuchKey|10007", (res.stderr or "") + (res.stdout or ""), re.I))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["load"]); ap.add_argument("--run", required=True); ap.add_argument("--dir", required=True); ap.add_argument("--sha", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if not ID.match(a.run):
        sys.exit("bad run id")
    d = Path(a.dir).expanduser()
    clips = check(d, a.sha)
    if a.dry_run:
        print(json.dumps({"dry_run": True, "run": a.run, "clips": len(clips), "ok": True})); return
    tgt = f"{BUCKET}/voicecheck/{a.run}/items.json"
    e = wrangler("get", tgt, "--pipe")
    if e.returncode == 0:
        sys.exit(f"{tgt} already exists: not replaced (answers are keyed to this itemset; a new batch needs a new run id)")
    if not absent(e):
        sys.exit("could not confirm items.json is absent (auth/network error?): refusing to upload; nothing written")
    for i in clips:
        r = wrangler("put", f"{BUCKET}/voicecheck/{a.run}/audio/{i}.m4a", "--file", str(d / "audio" / f"{i}.m4a"), "--content-type", "audio/mp4")
        if r.returncode:
            sys.exit(f"clip upload failed for {i}; items.json NOT uploaded")
    r = wrangler("put", tgt, "--file", str(d / "items.json"), "--content-type", "application/json")
    print(json.dumps({"loaded": a.run, "clips": len(clips), "ok": r.returncode == 0}))
    sys.exit(r.returncode)


if __name__ == "__main__":
    main()
