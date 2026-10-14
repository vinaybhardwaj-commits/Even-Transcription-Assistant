#!/usr/bin/env python3
"""Check a chain folder for the Chain Check page BEFORE it is written to the db.

  python3 check_chains.py <dir> [--expect N]

<dir> holds chains/<id>.json (one doc per chain, doc id = the id) and the audio files the docs name (audio_full.src).
A chain doc may hold ONLY: id, date, rx{text,created_at,author}, facts[{label,value}], encounter{start_s,end_s},
audio_full{src,t0_s,duration_s}, turns[{i,start_s,end_s,speaker,lang,orig,en, and optionally outside,earlier,phase,window,speaker_basis}].
Anything else (the linker's verdict, a link score, the class, a tier, the Jev answers) would be readable in the db by
anyone with devtools and would bias the rating, so it is an ERROR. Exit code 1 if any ERROR."""
import glob, json, os, re, shutil, subprocess, sys

TOP = {"id", "date", "rx", "facts", "encounter", "audio_full", "turns"}
RX = {"text", "created_at", "author"}
TURN_REQ = {"i", "start_s", "end_s", "speaker", "en"}
TURN_OK = TURN_REQ | {"lang", "orig", "outside", "earlier", "phase", "window", "speaker_basis"}
d = sys.argv[1]
expect = int(sys.argv[sys.argv.index("--expect") + 1]) if "--expect" in sys.argv else None
errs, warns, ids = [], [], set()
ff = shutil.which("ffprobe") is not None
files = sorted(glob.glob(os.path.join(d, "chains", "*.json")))
for f in files:
    c = json.load(open(f))
    w = os.path.basename(f)
    extra = sorted(set(c) - TOP)
    if extra:
        errs.append(f"{w}: fields that must not be in the doc: {extra}")
    miss = sorted(TOP - set(c))
    if miss:
        errs.append(f"{w}: missing fields {miss}")
        continue
    cid = c["id"]
    if not isinstance(cid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{4,}", cid) or os.path.splitext(w)[0] != cid:
        errs.append(f"{w}: id must be opaque letters/digits/_/- and equal the file name")
    if cid in ids:
        errs.append(f"{w}: duplicate id")
    ids.add(cid)
    rx = c["rx"]
    if not isinstance(rx, dict) or set(rx) - RX or not str(rx.get("text", "")).strip():
        errs.append(f"{w}: rx must be {{text (non-empty), created_at, author}} only")
    facts = c["facts"]
    if not isinstance(facts, list) or any(not isinstance(x, dict) or set(x) != {"label", "value"} for x in facts):
        errs.append(f"{w}: facts must be a list of exactly {{label, value}}")
    elif not facts:
        warns.append(f"{w}: no facts (booking / OT note / discharge)")
    af = c["audio_full"]
    if not isinstance(af, dict) or not af.get("src") or set(af) - {"src", "t0_s", "duration_s"}:
        errs.append(f"{w}: audio_full must be {{src, t0_s, duration_s}}")
    else:
        p = os.path.join(d, af["src"].lstrip("/"))
        if not os.path.isfile(p):
            errs.append(f"{w}: audio {af['src']} is missing")
        elif ff:
            try:
                got = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
                                           capture_output=True, text=True, check=True).stdout.strip())
                if abs(got - float(af.get("duration_s", -9))) > 0.5:
                    errs.append(f"{w}: duration_s {af.get('duration_s')} but the audio is {got:.1f} s")
            except Exception as e:
                warns.append(f"{w}: ffprobe failed ({e})")
    turns = c["turns"]
    if not isinstance(turns, list) or not turns:
        errs.append(f"{w}: turns must be a non-empty list")
        continue
    seen = set()
    for t in turns:
        if not TURN_REQ <= set(t) or set(t) - TURN_OK:
            errs.append(f"{w}: turn {t.get('i')} has wrong fields (extra: {sorted(set(t) - TURN_OK)}, missing: {sorted(TURN_REQ - set(t))})")
            break
        if t["i"] in seen:
            errs.append(f"{w}: duplicate turn index {t['i']}")
            break
        seen.add(t["i"])
    starts = [t["start_s"] for t in turns if "start_s" in t]
    if starts != sorted(starts):
        errs.append(f"{w}: turns are not in time order")
    if isinstance(af, dict) and af.get("duration_s") and turns:
        t0 = float(af.get("t0_s", 0))
        inside = [t for t in turns if not t.get("outside") and not t.get("earlier") and not (t0 - 0.001 <= t["start_s"] <= t0 + float(af["duration_s"]) + 0.5)]
        if inside:
            warns.append(f"{w}: {len(inside)} in-consult turns start outside the audio clip")
if expect is not None and len(files) != expect:
    errs.append(f"expected {expect} chains, found {len(files)}")
print(f"{len(files)} chains checked")
for x in warns:
    print("WARN ", x)
for e in errs:
    print("ERROR", e)
print("RESULT:", "FAIL" if errs else "OK")
sys.exit(1 if errs else 0)
