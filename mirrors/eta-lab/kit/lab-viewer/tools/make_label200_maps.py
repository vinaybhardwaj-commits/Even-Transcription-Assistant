#!/usr/bin/env python3
"""label200 audio + gloss maps (Fable 421a/421c): side files for the FROZEN label200 seed - the seed bytes never change.

  python3 make_label200_maps.py --out <dir> [--push]

Reads the frozen seed + its private key.json (L### -> window#segIdx, split-speaker's builder output) + the run records
under the vault roots, and herdr-kit's gloss (414.1). Writes (0600): label200.clip.json {L###:{k,i,t0,t1}} and
label200.gloss.json {L###: str}. Every clip key is checked against the Worker clip route (4 segments, the ingest SEG
alphabet, t1>t0, <=4 h) and the record's segment times must match the seed's dur_s within 0.5 s (a drift refuses).
--push puts both to eta-lab-ratings rate-seed/ with the fail-closed existence check (absent ONLY on an explicit
not-found; refuter-2 #2963 rule). Prints counts + shas only."""
import argparse, hashlib, json, os, re, subprocess, sys
from pathlib import Path

HOME = Path.home()
ROOTS = [HOME / "eta-data/hist", HOME / "eta-data/hist-mining", HOME / "eta-data/lab-vault/staged"]
SEG = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
AP = argparse.ArgumentParser()
AP.add_argument("--out", required=True)
AP.add_argument("--seed", default=str(HOME / "eta-data/readability/r1/label-page-seed/seed_docs.json"))
AP.add_argument("--key", default=str(HOME / "eta-data/readability/r1/label-page-seed/key.json"))
AP.add_argument("--gloss", default=str(HOME / "eta-data/readability/gloss/label200.json"))
AP.add_argument("--push", action="store_true")
a = AP.parse_args()

def load(p):
    return json.load(open(os.path.expanduser(p), encoding="utf-8"))

def find_window(win):
    for root in ROOTS:
        hit = next(iter(sorted(root.glob(f"runs/*/*/*/{win}.json"))), None)
        if hit:
            return root, hit
    return None, None

rows = load(a.seed)["rows"]
key = load(a.key)
gl = load(a.gloss)
if len(rows) != 200 or len(key) != 200:
    sys.exit(f"seed/key count drift: {len(rows)}/{len(key)}")
clips, gloss, fails = {}, {}, []
for r in rows:
    m = re.fullmatch(r"(.*?)#(\d+)", key[r["id"]] if isinstance(key.get(r["id"]), str) else "")
    if not m:
        fails.append(f"{r['id']}: key not <window>#<idx>")
        continue
    win, idx = m.group(1), int(m.group(2))
    root, path = find_window(win)
    if not path:
        fails.append(f"{r['id']}: window not in vault roots")
        continue
    rec = load(path)
    segs = rec.get("segments") or []
    if idx >= len(segs):
        fails.append(f"{r['id']}: segment index past end")
        continue
    s = segs[idx]
    t0, t1 = s.get("start_s"), s.get("end_s")
    if not (isinstance(t0, (int, float)) and isinstance(t1, (int, float)) and t1 > t0):
        fails.append(f"{r['id']}: segment times missing")
        continue
    if isinstance(r.get("dur_s"), (int, float)) and abs((t1 - t0) - r["dur_s"]) > 0.51:
        fails.append(f"{r['id']}: record duration {round(t1 - t0, 2)} != seed dur_s {r['dur_s']}")
        continue
    rel = path.relative_to(root)
    k = "/".join(list(rel.parts[1:4]) + [rel.parts[4][:-5]])
    segsok = k.split("/")
    if len(segsok) != 4 or any(not SEG.fullmatch(x) for x in segsok):
        fails.append(f"{r['id']}: key invalid for the clip route")
        continue
    if not (0 <= t0 and t1 <= 4 * 3600):
        fails.append(f"{r['id']}: times out of range")
        continue
    clips[r["id"]] = {"k": k, "i": idx, "t0": float(t0), "t1": float(t1)}
    g = gl.get(r["id"])
    if isinstance(g, str) and g.strip():
        gloss[r["id"]] = g
if fails:
    sys.exit("MAP BUILD REFUSED (" + str(len(fails)) + "):\n  " + "\n  ".join(fails[:10]))
if len(clips) != 200:
    sys.exit(f"only {len(clips)}/200 clips")
out = Path(os.path.expanduser(a.out))
out.mkdir(parents=True, exist_ok=True, mode=0o700)
def w(name, obj):
    data = json.dumps(obj, ensure_ascii=False, sort_keys=True).encode()
    p = out / name
    p.write_bytes(data)
    p.chmod(0o600)
    return hashlib.sha256(data).hexdigest()
sc = w("label200.clip.json", clips)
sg = w("label200.gloss.json", gloss)
print(json.dumps({"clips": len(clips), "glossed": len(gloss), "sha_clip": sc, "sha_gloss": sg}))
if a.push:
    import subprocess as sp
    cwd = str(Path(__file__).resolve().parents[1])
    tok = os.environ.get("CLOUDFLARE_API_TOKEN") or (HOME / ".claude" / "secrets" / "cloudflare_api_token").read_text().strip()
    e = {**os.environ, "CLOUDFLARE_API_TOKEN": tok}
    if not e.get("CLOUDFLARE_ACCOUNT_ID"):
        e["CLOUDFLARE_ACCOUNT_ID"] = re.search(r"([0-9a-f]{32})", sp.run(["npx", "wrangler", "whoami"], capture_output=True, text=True, env=e, cwd=cwd).stdout).group(1)
    for fn, bucket_key in (("label200.clip.json", "rate-seed/label200.clip.json"), ("label200.gloss.json", "rate-seed/label200.gloss.json")):
        g = sp.run(["npx", "wrangler", "r2", "object", "get", f"eta-lab-ratings/{bucket_key}", "--pipe", "--remote"], capture_output=True, text=True, env=e, cwd=cwd)
        if g.returncode == 0:
            sys.exit(f"{bucket_key} already exists: maps are frozen once pushed; a fix needs a ruling")
        if "does not exist" not in (g.stdout + g.stderr):
            sys.exit(f"existence check of {bucket_key} failed without an explicit not-found; refusing to put")
    for fn, bucket_key in (("label200.clip.json", "rate-seed/label200.clip.json"), ("label200.gloss.json", "rate-seed/label200.gloss.json")):
        r = sp.run(["npx", "wrangler", "r2", "object", "put", f"eta-lab-ratings/{bucket_key}", "--file", str(out / fn), "--content-type", "application/json", "--remote"], capture_output=True, text=True, env=e, cwd=cwd)
        if r.returncode != 0:
            sys.exit(f"push {bucket_key} failed rc={r.returncode}")
        b = sp.run(["npx", "wrangler", "r2", "object", "get", f"eta-lab-ratings/{bucket_key}", "--pipe", "--remote"], capture_output=True, env=e, cwd=cwd)
        print(json.dumps({"pushed": bucket_key, "readback_sha_match": hashlib.sha256(b.stdout).hexdigest() == (sc if "clip" in fn else sg)}))
