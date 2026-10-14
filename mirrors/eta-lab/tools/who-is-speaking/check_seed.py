#!/usr/bin/env python3
"""Check a seed folder for the Who Is Speaking page BEFORE it is written to the db.

  python3 check_seed.py <seed_dir> [--expect 150]

<seed_dir> holds turns/<id>.json (one doc per turn, doc id = the id) and audio/<id>.mp3 (or the file named in "audio").
A doc may hold ONLY: id, audio, duration_s, turn_start_s, turn_end_s, text. Anything else (a machine label, doctor,
room, window, margin, doubtful flag ...) would be readable in the db by anyone with devtools, so it is an error here.
Exit code 1 if any ERROR."""
import json, os, re, shutil, subprocess, sys, glob

ALLOWED = {"id", "audio", "duration_s", "turn_start_s", "turn_end_s", "text"}
d = sys.argv[1]
expect = int(sys.argv[sys.argv.index("--expect") + 1]) if "--expect" in sys.argv else None
errs, warns, ids = [], [], set()
files = sorted(glob.glob(os.path.join(d, "turns", "*.json")))
have_ffprobe = shutil.which("ffprobe") is not None
if not have_ffprobe:
    warns.append("ffprobe not found: audio durations not checked")
for f in files:
    t = json.load(open(f))
    tid = t.get("id")
    where = os.path.basename(f)
    extra = sorted(set(t) - ALLOWED)
    if extra:
        errs.append(f"{where}: fields that must not be in the doc: {extra}")
    missing = sorted(ALLOWED - set(t))
    if missing:
        errs.append(f"{where}: missing fields {missing}")
        continue
    if not isinstance(tid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{4,}", tid):
        errs.append(f"{where}: id must be an opaque string of letters, digits, _ or -")
    elif os.path.splitext(where)[0] != tid:
        errs.append(f"{where}: file name must equal the id")
    if tid in ids:
        errs.append(f"{where}: duplicate id {tid}")
    ids.add(tid)
    ts, te, dur = t["turn_start_s"], t["turn_end_s"], t["duration_s"]
    if not (0 <= ts < te <= dur + 0.05):
        errs.append(f"{where}: need 0 <= turn_start_s < turn_end_s <= duration_s (got {ts}, {te}, {dur})")
    if te - ts < 0.8:
        errs.append(f"{where}: turn is {te - ts:.2f} s; turns under 0.8 s are excluded (ruling 165)")
    if ts > 3.05 or dur - te > 3.05:
        warns.append(f"{where}: more than 3 s of context on one side (start {ts}, tail {dur - te:.1f})")
    if not str(t["text"]).strip():
        warns.append(f"{where}: empty transcript line")
    a = os.path.join(d, t["audio"])
    if not os.path.isfile(a):
        errs.append(f"{where}: audio file {t['audio']} is missing")
    elif have_ffprobe:
        try:
            got = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", a],
                                       capture_output=True, text=True, check=True).stdout.strip())
            if abs(got - dur) > 0.3:
                errs.append(f"{where}: duration_s {dur} but the audio is {got:.2f} s")
        except Exception as e:
            warns.append(f"{where}: ffprobe failed ({e})")
audio_files = set(os.path.relpath(p, d) for p in glob.glob(os.path.join(d, "audio", "*")))
used = set()
for f in files:
    used.add(json.load(open(f)).get("audio"))
orph = sorted(audio_files - used)
if orph:
    warns.append(f"{len(orph)} audio files no doc refers to (do not upload them): {orph[:5]}")
if expect is not None and len(files) != expect:
    errs.append(f"expected {expect} turns, found {len(files)}")
print(f"{len(files)} turn docs checked")
for w in warns:
    print("WARN ", w)
for e in errs:
    print("ERROR", e)
print("RESULT:", "FAIL" if errs else "OK")
sys.exit(1 if errs else 0)
