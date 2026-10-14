#!/usr/bin/env python3
"""Build the seed for the Doctor Voice Check page from one or more card folders (batch 1b plus any anchor folder).

  python3 merge_seed.py --out ~/eta-data/doctor-voice-check/<name> --batch ~/eta-data/voice-linkage/batch1b [--batch <dir> ...] [--expect N]

Each --batch dir holds links/<id>.json and the audio the cards name (same layout as check_cards.py). The script refuses
card-id or clip-path collisions between the folders, runs the same field/clip rules as check_cards.py on every folder, and
writes under --out (mode 700, never in git): seed_docs.json (all cards, one array, mode 600) and FILES.txt (every clip with
size and sha256, and the folder each comes from). The key folders are never read."""
import argparse, glob, hashlib, json, os, re, subprocess, sys

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--batch", action="append", required=True)
ap.add_argument("--expect", type=int)
a = ap.parse_args()
here = os.path.dirname(os.path.abspath(__file__))
docs, owner, clip_owner, rows, tot, errs = [], {}, {}, [], 0, []
for b in a.batch:
    b = os.path.expanduser(b)
    r = subprocess.run([sys.executable, os.path.join(here, "check_cards.py"), b], capture_output=True, text=True)
    last = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else "no output"
    print(f"{b}: check_cards -> {last}")
    if r.returncode != 0:
        errs.append(f"{b} fails check_cards.py")
        print(r.stdout)
        continue
    for f in sorted(glob.glob(os.path.join(b, "links", "*.json"))):
        d = json.load(open(f))
        if d["id"] in owner:
            errs.append(f"card id {d['id']} is in both {owner[d['id']]} and {b}")
        owner[d["id"]] = b
        docs.append(d)
        srcs = [c["src"] for c in (d["clips"] + [d["contrast"]] if d["kind"] == "link" else [d["a"], d["b"]])]
        for s in srcs:
            if s in clip_owner and clip_owner[s] != b:
                errs.append(f"clip path {s} is in both {clip_owner[s]} and {b}")
            clip_owner[s] = b
            p = os.path.join(b, s)
            rows.append((s, os.path.getsize(p), hashlib.sha256(open(p, "rb").read()).hexdigest(), b))
if a.expect is not None and len(docs) != a.expect:
    errs.append(f"expected {a.expect} cards, found {len(docs)}")
tier = re.compile(r"\b(HIGH|MED|MEDIUM|LOW|tier|confidence)\b", re.I)
leak = sum(1 for d in docs if d["kind"] == "link" and any(tier.search(e) for e in d["evidence"]))
if leak:
    errs.append(f"{leak} cards have a tier or confidence word in the evidence")
if errs:
    for e in errs:
        print("ERROR", e)
    sys.exit(1)
out = os.path.expanduser(a.out)
os.makedirs(out, exist_ok=True)
os.chmod(os.path.dirname(out), 0o700)
os.chmod(out, 0o700)
docs.sort(key=lambda d: d["id"])
json.dump(docs, open(os.path.join(out, "seed_docs.json"), "w"), ensure_ascii=False)
os.chmod(os.path.join(out, "seed_docs.json"), 0o600)
rows = sorted(set(rows))
tot = sum(n for _, n, _, _ in rows)
with open(os.path.join(out, "FILES.txt"), "w") as f:
    f.write("# upload each file as a page file at exactly this relative path (source folder in the last column)\n# path\tbytes\tsha256\tsource\n")
    f.write("\n".join(f"{s}\t{n}\t{h}\t{b}" for s, n, h, b in rows))
    f.write(f"\n# {len(docs)} card docs, {len(rows)} mp3 files, {tot/1e6:.1f} MB total\n")
os.chmod(os.path.join(out, "FILES.txt"), 0o600)
print(f"wrote {len(docs)} card docs ({sum(1 for d in docs if d['kind']=='link')} link, {sum(1 for d in docs if d['kind']=='pair')} pair), {len(rows)} clips, {tot/1e6:.1f} MB -> {out}")
