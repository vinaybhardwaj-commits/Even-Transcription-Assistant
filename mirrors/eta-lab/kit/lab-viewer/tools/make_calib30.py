#!/usr/bin/env python3
"""calib30 (ruling 414.3): build V's 30-item human-vs-Jev calibration gate from the FROZEN label200 and ba106 seeds.

  python3 make_calib30.py --out <dir> [--label200-seed ...] [--label200-key ...] [--ba-seed ...] [--ba-refs ...]
                          [--jev <file>] [--gloss <dir>] [--seed-no 414] [--push]

Draws 20 label200 lines (kind L) + 10 ba106 pairs (kind B), stratified by Jev label then language, with
>=3 Malayalam/Tamil items across the 30. Deterministic (random.Random(--seed-no) over id-sorted pools):
the same inputs always give the same 30. Refuses to push without --jev and --gloss (the ruling needs both).

Jev input: {id: {"label": ..., "conf": ...}} for every candidate id. Gloss input (herdr-kit 414.1) joins BY ROW
ID: <gloss>/label200.json = {L###: str}; <gloss>/ba106.json = {P###: {"A": str, "B": str}}.
ba106 seg refs (indic-mt): {"rows":[{id, window_id, seg_idx, start_s, end_s, lang}]} - no text.

Writes (0600, dir 0700, box only): seed_docs.json (rows with text+gloss -> bucket), clip.json
(id -> {k: "run_id/room/date/window", i, t0, t1} -> bucket, no text), jev_sidecar.json (id -> Jev label/conf;
NEVER leaves the box; Jev stays hidden from V). --push sends ONLY seed_docs.json -> rate-seed/calib30.json and
clip.json -> rate-seed/calib30.clip.json (CLOUDFLARE_* env like rate_seed.py; refuses if either key exists:
the 30 are frozen once loaded; a redraw needs a ruling). Prints counts, shas, lang/label spread only.
"""
import argparse, hashlib, json, os, random, re, subprocess, sys
from pathlib import Path

HOME = Path.home()
ROOTS = [HOME / "eta-data/hist", HOME / "eta-data/hist-mining", HOME / "eta-data/lab-vault/staged"]
PREF = {"ml", "ta"}
AP = argparse.ArgumentParser()
AP.add_argument("--out", required=True)
AP.add_argument("--label200-seed", default=str(HOME / "eta-data/readability/r1/label-page-seed/seed_docs.json"))
AP.add_argument("--label200-key", default=str(HOME / "eta-data/readability/r1/label-page-seed/key.json"))
AP.add_argument("--ba-seed", default=str(HOME / "eta-data/pair-label/ba106/seed_docs.json"))
AP.add_argument("--ba-refs", default=str(HOME / "eta-data/readable-rerun/r1/ba_v1/seg_refs.json"))
AP.add_argument("--jev")
AP.add_argument("--gloss")
AP.add_argument("--flags", help="JSON list (or {ids:[...]}) of the ba106 rows that are flag_full (stock string or near-silence) per indic-mt; eta-refuter #2838(b): the 10-pair draw MUST hold >=4 of these")
AP.add_argument("--topup-from", help="r417b: directory of the frozen calib30 draw (draw1); continues the SAME generator stream at wants 27/13, drops the 30 already drawn, keeps the next 7 L + 3 P as calib30b (draw only; never pushed by this tool)")
AP.add_argument("--seed-no", type=int, default=414)
AP.add_argument("--push", action="store_true")
a = AP.parse_args()

def load(p):
    return json.load(open(os.path.expanduser(p), encoding="utf-8"))

def find_window(win_id):
    for root in ROOTS:
        hit = next(iter(sorted(root.glob(f"runs/*/*/*/{win_id}.json"))), None)
        if hit:
            return root, hit
    return None, None

def clip_from_rec(win, idx):
    root, path = find_window(win)
    if not path:
        return None
    rec = load(path)
    segs = rec.get("segments") or []
    if idx >= len(segs):
        return None
    t0, t1 = segs[idx].get("start_s"), segs[idx].get("end_s")
    if not (isinstance(t0, (int, float)) and isinstance(t1, (int, float)) and t1 > t0):
        return None
    rel = path.relative_to(root)   # runs/<run_id>/<room>/<date>/<window>.json -> key = the 4 segments WITHOUT the .json suffix (the Worker's windowKey rebuilds the rest)
    return {"k": "/".join(list(rel.parts[1:4]) + [rel.parts[4][:-5]]), "i": idx, "t0": float(t0), "t1": float(t1)}

lrows = load(a.label200_seed)["rows"]
lkey = load(a.label200_key)
brows = load(a.ba_seed)["rows"]
refs = load(a.ba_refs)
refs = refs["rows"] if isinstance(refs, dict) and "rows" in refs else refs
if len(lrows) != 200 or len(lkey) != 200 or len(brows) != 106 or len(refs) != 106:
    sys.exit(f"input count drift: label200 {len(lrows)}/{len(lkey)} ba106 {len(brows)}/{len(refs)} (expected 200/200/106/106)")
ref_by_id = {r["id"]: r for r in refs}
if set(ref_by_id) != {r["id"] for r in brows}:
    sys.exit("ba106 seed ids and seg_refs ids do not match")
jev = load(a.jev) if a.jev else {}
gl_l, gl_b = {}, {}
if a.gloss:
    p, q = os.path.join(os.path.expanduser(a.gloss), "label200.json"), os.path.join(os.path.expanduser(a.gloss), "ba106.json")
    if not (os.path.exists(p) and os.path.exists(q)):
        sys.exit(f"gloss dir must hold label200.json + ba106.json: {a.gloss}")
    def norm(raw, kind):
        # accepts {id: str} / {id: {A,B}} (preferred) AND gtranslate row arrays [{id, gloss}] (id L###, or P###A / P###B for pairs)
        if isinstance(raw, dict):
            return raw
        out = {}
        for row in raw:
            rid, g = str(row.get("id", "")), row.get("gloss")
            if not isinstance(g, str):
                continue
            if kind == "l":
                out[rid] = g
            else:
                m = re.fullmatch(r"(P\d{3})(A|B)", rid)
                if m:
                    out.setdefault(m.group(1), {})[m.group(2)] = g
        return out
    gl_l, gl_b = norm(load(p), "l"), norm(load(q), "b")
    if not all(isinstance(v, str) and v.strip() for v in gl_l.values()):
        sys.exit("gloss label200 values must be non-empty strings")
    if not all(isinstance(v, dict) and set(v) == {"A", "B"} and all(isinstance(x, str) and x.strip() for x in v.values()) for v in gl_b.values()):
        sys.exit("gloss ba106 values must be {A:str,B:str} (rows with only one side are refused)")

cands = []
for r in lrows:
    kl = lkey.get(r["id"])
    m = kl and re.fullmatch(r"(.*?)#(\d+)", kl)
    if not m:
        sys.exit(f"{r['id']}: key.json value is not <window>#<idx>")
    clip = clip_from_rec(m.group(1), int(m.group(2)))
    if not clip:
        sys.exit(f"{r['id']}: segment not resolvable in the vault roots")
    cands.append({"id": r["id"], "kind": "L", "lang": r.get("lang") or "und", "dur_s": r.get("dur_s"), "clip": clip,
                  "jev": (jev.get(r["id"]) or {}).get("label")})
bcands = []
for r in brows:
    s = ref_by_id[r["id"]]
    clip = clip_from_rec(s["window_id"], int(s["seg_idx"])) if "start_s" not in s else {"k": None, "i": int(s["seg_idx"]), "t0": float(s["start_s"]), "t1": float(s["end_s"])}
    if clip["k"] is None:
        root, path = find_window(s["window_id"])
        if not path:
            sys.exit(f"{r['id']}: window {s['window_id']} not in the vault roots")
        rel = path.relative_to(root)
        clip["k"] = "/".join(list(rel.parts[1:4]) + [rel.parts[4][:-5]])
    if clip["t1"] <= clip["t0"]:
        sys.exit(f"{r['id']}: end_s <= start_s in seg_refs")
    bcands.append({"id": r["id"], "kind": "B", "lang": r.get("lang") or "und", "dur_s": None, "clip": clip,
                   "jev": (jev.get(r["id"]) or {}).get("label")})
flags, identical = set(), set()
if a.flags:
    f = load(a.flags)
    if isinstance(f, dict) and "rows" in f:   # indic-mt flag_refs.json: {rows:[{id, flag_full, identical, ...}]} - no text, no direction
        flags = {r["id"] for r in f["rows"] if r.get("flag_full") and not r.get("identical")}
        identical = {r["id"] for r in f["rows"] if r.get("identical")}
    else:
        flags = set(f["ids"] if isinstance(f, dict) and "ids" in f else f)
    if not flags <= {c["id"] for c in bcands} or not identical <= {c["id"] for c in bcands}:
        sys.exit("flags file names ids that are not ba106 rows")
    for c in bcands:
        c["flag"] = c["id"] in flags
    bcands[:] = [c for c in bcands if c["id"] not in identical]   # the 10 identical-A/B controls: V would hear one clip twice (indic-mt; A/B preference is meaningless)
    print(f"ba106 pool: {len(bcands)} rows ({len(identical)} identical controls excluded), {len([c for c in bcands if c['flag']])} flag_full available", file=sys.stderr)
else:
    for c in bcands:
        c["flag"] = False
if a.push and not a.flags:
    sys.exit("--push needs --flags (indic-mt flag_refs.json; eta-refuter #2838(b): >=4 flagged pairs in the 10)")
if a.push and (not a.jev or not a.gloss):
    sys.exit("--push needs --jev and --gloss (ruling 414.3)")
missing = [c["id"] for c in cands + bcands if not c["jev"]]
if a.jev and missing:
    sys.exit(f"jev file missing labels for {len(missing)} candidate ids")

def pick(pool, want, rng, min_pref=0, min_flag=0):
    strata = {}
    for c in sorted(pool, key=lambda x: x["id"]):
        strata.setdefault(c["jev"] or "?", []).append(c)
    order = sorted(strata)
    out, i = [], 0
    while len(out) < want and any(strata.values()):
        take = strata[order[i % len(order)]]
        if take:
            rng.shuffle(take)
            out.append(take.pop(0))
        i += 1
    have = sum(1 for x in out if x["lang"] in PREF)
    if have < min_pref:
        swaps = [c for c in sorted(pool, key=lambda x: x["id"]) if c["lang"] in PREF and c not in out]
        rng.shuffle(swaps)
        for c in list(out):
            if have >= min_pref:
                break
            if c["lang"] not in PREF and swaps:
                out[out.index(c)] = swaps.pop(0)
                have += 1
    if min_flag:   # eta-refuter #2838(b) via r415b: the 10 ba106 pairs hold >=4 flag_full rows (V tests Jev where the fluency bias bites)
        have = sum(1 for x in out if x.get("flag"))
        swaps = [c for c in sorted(pool, key=lambda x: x["id"]) if c.get("flag") and c not in out]
        rng.shuffle(swaps)
        for c in list(out):
            if have >= min_flag:
                break
            if not c.get("flag") and swaps:
                out[out.index(c)] = swaps.pop(0)
                have += 1
        if have < min_flag:
            sys.exit(f"cannot seat {min_flag} flag_full pairs in the draw (flag pool={have + len(swaps)})")
    return sorted(out, key=lambda x: x["id"])

def stream_pops(pool, count, rng):   # r417b: the raw draw stream = strata round-robin pops (the pick() pop phase, no floor swaps)
    strata = {}
    for c in sorted(pool, key=lambda x: x["id"]):
        strata.setdefault(c["jev"] or "?", []).append(c)
    order = sorted(strata)
    out, i = [], 0
    while len(out) < count and any(strata.values()):
        take = strata[order[i % len(order)]]
        if take:
            rng.shuffle(take)
            out.append(take.pop(0))
        i += 1
    return out

rng = random.Random(a.seed_no)
if a.topup_from:   # r417b(1): same seed + generator, continuing the stream: take the next items in draw order, skipping the 30 already drawn, until 7 L + 3 P. eta-refuter #2977: the continuation must sit on the rng state AFTER the base's full L pick (pops + its swap shuffles) AND B pick (pops + swaps) - so replay the base exactly, then pop on the SAME rng.
    drawn = {r["id"] for r in json.load(open(os.path.join(os.path.expanduser(a.topup_from), "seed_docs.json")))["rows"]}
    if len(drawn) != 30:
        sys.exit("--topup-from dir does not hold a 30-row draw1")
    base_l = pick(cands, 20, rng, 2)                                   # consumes the rng EXACTLY as the calib30 draw did
    base_b = pick(bcands, 10, rng, 1, 4 if a.flags else 0)
    if {c["id"] for c in base_l + base_b} != drawn:
        sys.exit("top-up replay does not reproduce the drawn 30 - the base is not reproducible with these inputs; STOP, needs refuter-2/Fable")
    extra_l = [c for c in stream_pops(cands, 60, rng) if c["id"] not in drawn][:7]
    extra_b = [c for c in stream_pops(bcands, 40, rng) if c["id"] not in drawn][:3]
    if len(extra_l) != 7 or len(extra_b) != 3:
        sys.exit(f"top-up stream gave {len(extra_l)} L + {len(extra_b)} P (need 7+3): pools too small - needs Fable")
    sel_l, sel_b = sorted(extra_l, key=lambda x: x["id"]), sorted(extra_b, key=lambda x: x["id"])
    out_dir = Path(os.path.expanduser(a.out))
    if out_dir.exists():
        sys.exit(f"{a.out}: refuse to overwrite; a top-up dir is written once")
    if a.push:
        sys.exit("--push is for calib30 only; r417b(3) loads calib30b solely on a later Fable ruling")
else:
    sel_l = pick(cands, 20, rng, 2)
    sel_b = pick(bcands, 10, rng, 1, 4 if a.flags else 0)
sel = sel_l + sel_b
if not a.topup_from and sum(1 for c in sel if c["lang"] in PREF) < 3:   # the >=3 ml/ta floor is the 30-item ruling (414); r417b top-up is just 7 L + 3 P in stream order
    sys.exit(f"draw has only {sum(1 for c in sel if c['lang'] in PREF)} ml/ta (<3): pool cannot satisfy the strata; needs a ruling")
l_by, b_by = {r["id"]: r for r in lrows}, {r["id"]: r for r in brows}
rows, clips, side = [], {}, {}
for j, c in enumerate(sel, 1):
    g = {"id": c["id"], "n": j, "kind": c["kind"], "lang": c["lang"]}
    if c["kind"] == "B":
        src = b_by[c["id"]]
        g["text_A"], g["text_B"] = src["text_A"], src["text_B"]
        if set(gl_b.get(c["id"], {})) == {"A", "B"}:
            g["gloss_A"], g["gloss_B"] = gl_b[c["id"]]["A"], gl_b[c["id"]]["B"]
    else:
        src = l_by[c["id"]]
        g["text"] = src["text"]
        g["dur_s"] = c["dur_s"]
        if isinstance(gl_l.get(c["id"]), str):
            g["gloss"] = gl_l[c["id"]]
    if not c["jev"]:
        g["lang"] = c["lang"]
    rows.append(g)
    ck = {k: v for k, v in c["clip"].items() if k != "lang"}
    seg = ck["k"].split("/")   # the exact contract of the Worker clip route, checked before the map is ever written
    if len(seg) != 4 or any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", s) for s in seg):   # the EXACT Worker clip-route alphabet (refuter-2: one regex, no dots)
        sys.exit(f"{c['id']}: clip window key invalid for the Worker route: {ck['k']}")
    clips[c["id"]] = ck
    side[c["id"]] = {"jev": c["jev"], "conf": (jev.get(c["id"]) or {}).get("conf"), "flag": bool(c.get("flag"))}
out_dir = Path(os.path.expanduser(a.out))
out_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
def w(name, obj):
    data = json.dumps(obj, ensure_ascii=False, sort_keys=True).encode()
    p = out_dir / name
    p.write_bytes(data)
    p.chmod(0o600)
    return data
d_seed = w("seed_docs.json", {"rows": rows})
d_clip = w("clip.json", clips)
d_side = w("jev_sidecar.json", side)
d_ids = w("ids.json", sorted(side))
from collections import Counter
print(json.dumps({"rows": len(rows), "L": len(sel_l), "B": len(sel_b), "ml_ta": sum(1 for c in sel if c["lang"] in PREF),
                  "langs": dict(Counter(c["lang"] for c in sel)), "jev_labels": dict(Counter(c["jev"] or "?" for c in sel)),
                  "flag_full": sum(1 for c in sel if c.get("flag")),
                  "glossed": sum(1 for r in rows if "gloss" in r or "gloss_A" in r),
                  "sha_seed": hashlib.sha256(d_seed).hexdigest(), "sha_clip": hashlib.sha256(d_clip).hexdigest(),
                  "sha_ids": hashlib.sha256(d_ids).hexdigest(), "sha_sidecar": hashlib.sha256(d_side).hexdigest()}, sort_keys=True))
if a.push:
    if not all("gloss" in r or "gloss_A" in r for r in rows):
        sys.exit("--push refuses: some rows have no gloss (herdr-kit 414.1 incomplete?)")
    import re as _re
    cenv = dict(os.environ)
    if not cenv.get("CLOUDFLARE_API_TOKEN"):
        cenv["CLOUDFLARE_API_TOKEN"] = (HOME / ".claude" / "secrets" / "cloudflare_api_token").read_text().strip()
    if not cenv.get("CLOUDFLARE_ACCOUNT_ID"):
        w = subprocess.run(["npx", "wrangler", "whoami"], capture_output=True, text=True, env=cenv, cwd=str(Path(__file__).resolve().parents[1]))
        m = _re.search(r"([0-9a-f]{32})", w.stdout)
        if not m:
            sys.exit("no account id from whoami")
        cenv["CLOUDFLARE_ACCOUNT_ID"] = m.group(1)
    for src, key in (("seed_docs.json", "rate-seed/calib30.json"), ("clip.json", "rate-seed/calib30.clip.json")):
        g = subprocess.run(["npx", "wrangler", "r2", "object", "get", f"eta-lab-ratings/{key}", "--pipe", "--remote"],
                           capture_output=True, text=True, env=cenv, cwd=str(Path(__file__).resolve().parents[1]))
        if g.returncode == 0:
            sys.exit(f"{key} already exists: the 30 are frozen; a redraw needs a ruling")
        if "does not exist" not in (g.stderr or "") + (g.stdout or ""):   # ANY other failure (auth, network, 5xx) = unknown state: fail CLOSED, never fall through to put
            sys.exit(f"pre-push get of {key} failed without an explicit not-found; refusing to put (state unknown)")
    for src, key in (("seed_docs.json", "rate-seed/calib30.json"), ("clip.json", "rate-seed/calib30.clip.json")):
        r = subprocess.run(["npx", "wrangler", "r2", "object", "put", f"eta-lab-ratings/{key}", "--file", str(out_dir / src),
                            "--content-type", "application/json", "--remote"], capture_output=True, text=True, env=cenv, cwd=str(Path(__file__).resolve().parents[1]))
        if r.returncode != 0:
            sys.exit(f"push {key} failed rc={r.returncode}")
    print(json.dumps({"pushed": ["rate-seed/calib30.json", "rate-seed/calib30.clip.json"]}))
