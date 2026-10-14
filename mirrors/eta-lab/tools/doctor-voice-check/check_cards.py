#!/usr/bin/env python3
"""Check a card folder for the Doctor Voice Check page BEFORE it is written to the db.

  python3 check_cards.py <dir> [--expect N]

<dir> holds links/<id>.json (one doc per card, doc id = the id) and audio/... (the files the cards name).
A link card holds ONLY: id, kind:"link", room, date, doctor, evidence[], clips[3 x {src,duration_s}], contrast{src,duration_s}.
A pair card holds ONLY: id, kind:"pair", a{src,duration_s}, b{src,duration_s}.
Anything else (confidence tier, scores, cluster id, the true doctor, ...) would be readable in the db by anyone with
devtools and would bias the rating, so it is an ERROR here. Keep the tier and the key off the page.
Doctor clips are 4-8 s (spec); exit code 1 if any ERROR."""
import glob, json, os, re, shutil, subprocess, sys

LINK = {"id", "kind", "room", "date", "doctor", "evidence", "clips", "contrast"}
PAIR = {"id", "kind", "a", "b"}
d = sys.argv[1]
expect = int(sys.argv[sys.argv.index("--expect") + 1]) if "--expect" in sys.argv else None
errs, warns, ids = [], [], set()
ff = shutil.which("ffprobe") is not None
if not ff:
    warns.append("ffprobe not found: clip durations not checked")

def check_clip(where, label, c, lo=None, hi=None):
    if not isinstance(c, dict) or set(c) - {"src", "duration_s"} or not c.get("src"):
        errs.append(f"{where}: {label} must be exactly {{src, duration_s}}")
        return
    p = os.path.join(d, c["src"])
    if not os.path.isfile(p):
        errs.append(f"{where}: {label} audio {c['src']} is missing")
    elif ff:
        try:
            got = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
                                       capture_output=True, text=True, check=True).stdout.strip())
            if abs(got - float(c.get("duration_s", -9))) > 0.3:
                errs.append(f"{where}: {label} duration_s {c.get('duration_s')} but the audio is {got:.2f} s")
            if lo is not None and not (lo - 0.3 <= got <= hi + 0.3):
                warns.append(f"{where}: {label} is {got:.1f} s (spec: {lo}-{hi} s)")
        except Exception as e:
            warns.append(f"{where}: ffprobe failed for {label} ({e})")

files = sorted(glob.glob(os.path.join(d, "links", "*.json")))
used, n_link, n_pair = set(), 0, 0
for f in files:
    c = json.load(open(f))
    where = os.path.basename(f)
    kind = c.get("kind")
    allowed = LINK if kind == "link" else PAIR if kind == "pair" else None
    if allowed is None:
        errs.append(f"{where}: kind must be 'link' or 'pair'")
        continue
    extra = sorted(set(c) - allowed)
    if extra:
        errs.append(f"{where}: fields that must not be in the doc: {extra}")
    missing = sorted(allowed - set(c))
    if missing:
        errs.append(f"{where}: missing fields {missing}")
        continue
    cid = c["id"]
    if not isinstance(cid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{4,}", cid) or os.path.splitext(where)[0] != cid:
        errs.append(f"{where}: id must be opaque letters/digits/_/- and equal the file name")
    if cid in ids:
        errs.append(f"{where}: duplicate id")
    ids.add(cid)
    if kind == "link":
        n_link += 1
        if not (isinstance(c["clips"], list) and len(c["clips"]) == 3):
            errs.append(f"{where}: a link card needs exactly 3 doctor clips")
        else:
            for i, cl in enumerate(c["clips"]):
                check_clip(where, f"clip {i+1}", cl, 4, 8)
        check_clip(where, "contrast clip", c["contrast"], 4, 8)
        if not (isinstance(c["evidence"], list) and c["evidence"] and all(isinstance(x, str) and x.strip() for x in c["evidence"])):
            errs.append(f"{where}: evidence must be a non-empty list of plain-words strings")
        if not str(c["doctor"]).strip() or not str(c["room"]).strip():
            errs.append(f"{where}: doctor and room are required")
        srcs = [x.get("src") for x in c["clips"] if isinstance(x, dict)] + [c["contrast"].get("src") if isinstance(c["contrast"], dict) else None]
        if len(set(srcs)) != len(srcs):
            errs.append(f"{where}: the same audio file is used twice on one card")
        used.update(s for s in srcs if s)
    else:
        n_pair += 1
        check_clip(where, "clip A", c["a"])
        check_clip(where, "clip B", c["b"])
        if isinstance(c["a"], dict) and isinstance(c["b"], dict) and c["a"].get("src") == c["b"].get("src"):
            errs.append(f"{where}: clips A and B are the same file")
        used.update(x.get("src") for x in (c["a"], c["b"]) if isinstance(x, dict))
orph = sorted(set(os.path.relpath(p, d) for p in glob.glob(os.path.join(d, "audio", "**", "*"), recursive=True) if os.path.isfile(p)) - used)
if orph:
    warns.append(f"{len(orph)} audio files no card refers to (do not upload them): {orph[:5]}")
if expect is not None and len(files) != expect:
    errs.append(f"expected {expect} cards, found {len(files)}")
print(f"{len(files)} cards checked ({n_link} link, {n_pair} same-person)")
for w in warns:
    print("WARN ", w)
for e in errs:
    print("ERROR", e)
print("RESULT:", "FAIL" if errs else "OK")
sys.exit(1 if errs else 0)
