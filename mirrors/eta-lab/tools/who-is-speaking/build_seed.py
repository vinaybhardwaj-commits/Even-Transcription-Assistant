#!/usr/bin/env python3
"""Build the seed for the Who Is Speaking page from vj-data's turn pool and selection.

  python3 build_seed.py --pool ~/eta-data/vj --selection selection.json --out ~/eta-data/who-is-speaking \
        [--exclude labelled.json] [--expect 150]

selection.json (vj-data): a list of turn identities [{"window_id": "...", "s": 12.3, "e": 15.1}, ...]
  (window_id, s, e as in the pool's turns.json; extra keys are ignored, and no label may be in it).
--exclude: same identity list for turns that already carry a usable V label; they are dropped (dedupe by turn).
--pool: folder with turns.json (per window: [{window_id, s, e, text, group, ...}]) and audio/<window_id>.wav.

Writes, under --out (mode 700, NEVER in git):
  seed/turns/<id>.json     the docs to write to the db (only id, audio, duration_s, turn_start_s, turn_end_s, text)
  seed/audio/<id>.mp3      3 s before + the turn + 3 s after, mono 32 kbps
  seed/FILES.txt           the list to upload: every path, size, sha256, and the totals
  key.json (mode 600)      id -> {window_id, s, e}: the scorer's key. Keep it off the page and away from the raters.
Ids are random and opaque; a re-run keeps the ids already in key.json. Then run check_seed.py on seed/."""
import argparse, hashlib, json, os, secrets, string, subprocess, sys

ap = argparse.ArgumentParser()
ap.add_argument("--pool", required=True)
ap.add_argument("--selection", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--exclude")
ap.add_argument("--expect", type=int)
ap.add_argument("--allow-profile", action="store_true", help="allow turns from the pool's 'profile' group (default: refuse)")
a = ap.parse_args()
CONTEXT, MIN_TURN = 3.0, 0.8
ident = lambda x: (str(x["window_id"]), round(float(x["s"]), 3), round(float(x["e"]), 3))
os.umask(0o077)

pool = json.load(open(os.path.join(a.pool, "turns.json")))
by_id = {}
for w, turns in pool.items():
    for t in turns:
        by_id[ident(t)] = t
sel = [ident(x) for x in json.load(open(a.selection))]
drop = set(ident(x) for x in json.load(open(a.exclude))) if a.exclude else set()
errors, keep, seen = [], [], set()
for k in sel:
    if k in drop:
        continue
    if k in seen:
        errors.append(f"duplicate turn in the selection: {k[0]} {k[1]}-{k[2]}")
        continue
    seen.add(k)
    t = by_id.get(k)
    if t is None:
        errors.append(f"turn not in the pool: {k[0]} {k[1]}-{k[2]}")
    elif t.get("group") != "test" and not a.allow_profile:
        errors.append(f"turn is in the '{t.get('group')}' group, not 'test': {k[0]} {k[1]}-{k[2]}")
    elif k[2] - k[1] < MIN_TURN:
        errors.append(f"turn under {MIN_TURN} s excluded: {k[0]} {k[1]}-{k[2]}")
    elif not os.path.isfile(os.path.join(a.pool, "audio", k[0] + ".wav")):
        errors.append(f"no window audio for {k[0]}")
    else:
        keep.append(k)
print(f"selection {len(sel)}, already labelled and dropped {len(drop & set(sel))}, usable {len(keep)}, problems {len(errors)}")
for e in errors[:20]:
    print("ERROR", e)
if errors:
    sys.exit(1)
if a.expect is not None and len(keep) != a.expect:
    print(f"ERROR expected {a.expect} usable turns, got {len(keep)}")
    sys.exit(1)

seed = os.path.join(a.out, "seed")
for d in ("turns", "audio"):
    os.makedirs(os.path.join(seed, d), exist_ok=True)
os.chmod(a.out, 0o700)
keyf = os.path.join(a.out, "key.json")
key = json.load(open(keyf)) if os.path.exists(keyf) else {}
rev = {(v["window_id"], round(v["s"], 3), round(v["e"], 3)): i for i, v in key.items()}
alphabet = string.ascii_letters + string.digits
def new_id():
    while True:
        i = "".join(secrets.choice(alphabet) for _ in range(8))
        if i not in key:
            return i

def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True, check=True)
    return float(r.stdout.strip())

for k in keep:
    tid = rev.get(k) or new_id()
    key[tid] = {"window_id": k[0], "s": k[1], "e": k[2]}
    rev[k] = tid
    wav = os.path.join(a.pool, "audio", k[0] + ".wav")
    wdur = probe(wav)
    c0 = max(0.0, k[1] - CONTEXT)
    c1 = min(wdur, k[2] + CONTEXT)
    mp3 = os.path.join(seed, "audio", tid + ".mp3")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{c0:.3f}", "-t", f"{c1 - c0:.3f}", "-i", wav,
                    "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", mp3], check=True)
    doc = {"id": tid, "audio": f"audio/{tid}.mp3", "duration_s": round(probe(mp3), 3),
           "turn_start_s": round(k[1] - c0, 3), "turn_end_s": round(k[2] - c0, 3), "text": by_id[k].get("text", "")}
    json.dump(doc, open(os.path.join(seed, "turns", tid + ".json"), "w"), ensure_ascii=False, indent=1)
json.dump(key, open(keyf, "w"), indent=1)
os.chmod(keyf, 0o600)

rows, tot = [], 0
for sub in ("turns", "audio"):
    for f in sorted(os.listdir(os.path.join(seed, sub))):
        p = os.path.join(seed, sub, f)
        h = hashlib.sha256(open(p, "rb").read()).hexdigest()
        rows.append(f"{sub}/{f}\t{os.path.getsize(p)}\t{h}")
        tot += os.path.getsize(p)
n_a = sum(1 for r in rows if r.startswith("audio/"))
open(os.path.join(seed, "FILES.txt"), "w").write(
    "# path\tbytes\tsha256\n" + "\n".join(rows) + f"\n# {len([r for r in rows if r.startswith('turns/')])} turn docs, {n_a} mp3 files, {tot/1e6:.1f} MB total\n")
print(f"wrote {len(keep)} turn docs and {n_a} clips ({tot/1e6:.1f} MB) to {seed}; key (keep private): {keyf}")
print("next: python3 check_seed.py", seed, "--expect", len(keep))
