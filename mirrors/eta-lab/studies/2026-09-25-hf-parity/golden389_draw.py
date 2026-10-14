"""refuter-2, ruling 389 part 3: draw the frozen guard-stress golden set (>= 40 windows) for Mini-vs-HF behavioural parity.
Reads the live view index and the run records; computes flags and repetition COUNTS only. Never prints or writes any segment text,
first_words or patient label. Output: window ids, record keys, audio keys, stratum, and the numeric reason each window qualifies."""
import collections, glob, hashlib, json, os, random, re, sys

H = os.path.expanduser("~/eta-data/")
IDX = H + "lab-vault/staged/index/" + sys.argv[3]          # pinned by name (eta-refuter #2325 fix 1): never "the latest"
IDX_SHA = sys.argv[4]
if hashlib.sha256(open(IDX, "rb").read()).hexdigest() != IDX_SHA:
    sys.exit("refused: index sha differs from the pinned one")
ROOTS = (H + "hist-mining/", H + "hist/", H + "lab-vault/staged/")
PLAN337D = sys.argv[1]  # plan_frozen.json of 337d (git show'd to a scratch file)
# usage: golden389_draw.py <337d plan_frozen.json> <out.json> view-202609251212.jsonl 9aaf462682ef...(full sha256)
OUT = sys.argv[2]
SEED = 389
INDIC = {"kn", "hi", "ta", "ml", "bn", "gu", "te", "mr"}


def resolve(key):
    for r in ROOTS:
        if os.path.exists(r + key):
            return r + key


def segs(rec):
    P = rec["payload"] if isinstance(rec.get("payload"), dict) else rec
    return P.get("segments") or []


def norm(t):
    return re.sub(r"\W+", " ", (t or "").lower()).strip()


def loop_stats(ss):
    """Segment-level repetition: the most frequent identical non-empty segment text (count) and the longest consecutive run of it,
    plus the longest run of one repeated 3-word phrase inside any segment. Counts only."""
    texts = [norm(s.get("text")) for s in ss if not s.get("refused")]
    texts = [t for t in texts if t]
    top = max(collections.Counter(texts).values()) if texts else 0
    run = best = 0; prev = None
    for t in texts:
        run = run + 1 if t == prev else 1; prev = t; best = max(best, run)
    ph = 0
    for t in texts:
        w = t.split()
        for n in (1, 2, 3):
            i = 0
            while i + n <= len(w):
                k = 1
                while i + (k + 1) * n <= len(w) and w[i + k * n:i + (k + 1) * n] == w[i:i + n]:
                    k += 1
                ph = max(ph, k if k > 1 else 0); i += 1
    return top, best, ph


rows = [json.loads(l) for l in open(IDX)]
by_wid = {r["window_id"]: r for r in rows}
plan = json.load(open(PLAN337D))
r333 = [w["window_id"] for w in plan["windows"] if w.get("group") in ("main", "refused", "draw", "main_draw")]
groups = collections.Counter(w.get("group") for w in plan["windows"])

cand = collections.defaultdict(list)
stats = collections.Counter()
for r in rows:
    if not r.get("has_audio") or not r.get("room_id") or r.get("producer") not in ("hist-bulk", "hist-miner"):
        continue
    p = resolve(r["key"])
    if not p:
        stats["unresolved"] += 1; continue
    rec = json.load(open(p)); ss = segs(rec)
    langs = collections.Counter(s.get("lang") for s in ss if not s.get("refused"))
    ak = (rec.get("provenance") or {}).get("source_audio_keys") or []
    base = dict(window_id=r["window_id"], key=r["key"], room_id=r["room_id"], ist_date=r["ist_date"], status=r["status"],
                n_lines=r.get("n_lines"), n_refused=r.get("n_refused"), record_sha256=hashlib.sha256(open(p, "rb").read()).hexdigest(),
                n_audio_keys=len(ak), audio_keys=ak)
    if not ak:
        stats["no_audio_keys"] += 1; continue
    if r["status"] == "refused":
        cand["refused"].append(dict(base, why=f"status refused (all transcribed lines refused by the guard; n_refused {r.get('n_refused')})", r333=r["window_id"] in r333))
    if r["status"] == "no_signal" or r.get("untested_kind") in ("near_silence", "transcribed_unconfirmed"):
        cand["silence"].append(dict(base, why=f"status {r['status']} untested_kind {r.get('untested_kind')}"))
    if r["status"] == "text":
        top, run, ph = loop_stats(ss)
        indic = sum(v for k, v in langs.items() if k in INDIC); en = langs.get("en", 0)
        if top >= 5 or run >= 3 or ph >= 8:
            cand["loop"].append(dict(base, why=f"top identical segment x{top}, longest run {run}, longest in-segment phrase repeat {ph}"))
        elif indic >= 3 and r.get("lang") in ("kn", "hi"):
            cand["indic"].append(dict(base, why=f"index lang {r['lang']}; indic segs {indic}, en segs {en}", mixed=en >= 2))
        elif indic >= 2 and en >= 2:
            cand["indic"].append(dict(base, why=f"code-mixed: indic segs {indic}, en segs {en}", mixed=True))
        elif r.get("lang") == "en" and indic == 0 and (r.get("n_refused") or 0) == 0 and top <= 2 and 20 <= (r.get("n_lines") or 0):
            cand["english"].append(dict(base, why=f"en, {r['n_lines']} lines, 0 refused, no repetition"))

rng = random.Random(SEED)


def draw(pool, n, prefer=None):
    """Stratified by room: round-robin over rooms in seeded order; `prefer` items first."""
    pool = sorted(pool, key=lambda x: x["window_id"]); rng.shuffle(pool)
    if prefer:
        pool.sort(key=lambda x: not prefer(x))
    byroom = collections.OrderedDict()
    for x in pool:
        byroom.setdefault(x["room_id"], []).append(x)
    out = []
    while len(out) < n and any(byroom.values()):
        for rm in list(byroom):
            if byroom[rm] and len(out) < n:
                out.append(byroom[rm].pop(0))
    return out


R = 3   # reserves per stratum: used IN ORDER only when a selected window's audio cannot be fetched on BOTH sides (reported, never silent)
sil_ns = [x for x in cand["silence"] if "status no_signal" in x["why"]]; sil_ns_ids = {x["window_id"] for x in sil_ns}
sil_un = [x for x in cand["silence"] if x["window_id"] not in sil_ns_ids]
raw = {"refused": draw(cand["refused"], 12 + R, prefer=lambda x: x["r333"]),
       "loop": draw(cand["loop"], 10 + R),
       "indic": draw([x for x in cand["indic"] if "lang hi" in x["why"]], 4 + 1) + draw([x for x in cand["indic"] if "lang kn" in x["why"]], 4 + 1) + draw([x for x in cand["indic"] if "code-mixed" in x["why"]], 4 + 1),
       "silence": draw(sil_ns, 4 + 2) + draw(sil_un, 2 + 1),
       "english": draw(cand["english"], 8 + R)}
n_main = {"refused": 12, "loop": 10, "silence": 6, "english": 8}
sel, reserve = {}, {}
for k, v in raw.items():
    if k == "indic":
        sel[k] = v[0:4] + v[5:9] + v[10:14]; reserve[k] = [v[4], v[9], v[14]]
    elif k == "silence":
        sel[k] = v[0:4] + v[6:8]; reserve[k] = v[4:6] + v[8:9]
    else:
        sel[k] = v[:n_main[k]]; reserve[k] = v[n_main[k]:]
ids = [x["window_id"] for v in list(sel.values()) + list(reserve.values()) for x in v]
assert len(ids) == len(set(ids)), "a window in two strata"
doc = dict(schema="eta-golden-389/1", producer="eta-refuter-2", ruling="389 part 3", index_file=os.path.basename(IDX), index_sha256=hashlib.sha256(open(IDX, "rb").read()).hexdigest(), seed=SEED,
           r333_source="studies/2026-09-25-discarded-speech/plan_frozen.json groups " + json.dumps(dict(groups)),
           strata={k: len(v) for k, v in sel.items()}, total=sum(len(v) for v in sel.values()), windows=sel, reserves=reserve,
           note="Selection flags come from the HIST twin records; the parity REFERENCE is the Mini production stack run on the same audio keys.")
json.dump(doc, open(OUT, "w"), indent=1)
print("index", os.path.basename(IDX), "| r333 plan groups", dict(groups), "| r333 ids", len(r333))
print("candidates", {k: len(v) for k, v in cand.items()}, "| skipped", dict(stats))
print("reserves", {k: len(v) for k, v in reserve.items()}, "| silence kinds", collections.Counter(x["why"].split(" untested")[0] for x in sel["silence"]))
print("selected", doc["strata"], "total", doc["total"], "| r333 in refused stratum", sum(1 for x in sel["refused"] if x["r333"]),
      "| rooms", len({x["room_id"] for v in sel.values() for x in v}), "| dates", len({x["ist_date"] for v in sel.values() for x in v}))
print("out sha256", hashlib.sha256(open(OUT, "rb").read()).hexdigest())
