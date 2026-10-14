"""indic_controls.py: the POSITIVE controls with KNOWN INDIC SPEECH for the 337d test (addendum 1, after eta-refuter #1929: the first controls were guard-accepted ENGLISH windows forced to Indic, which cannot
validate a test for faint INDIC speech). Frozen selection, written once.
QUALIFYING SEGMENT: engine sravaani or indicconformer, language label kn or hi, dominant script = the language's own script, readability score >= 0.60 (all from features.jsonl; no text used here).
WINDOW: >= 60 s of qualifying segments. TIER 1 = >= 80 % of its qualifying segments follow the router's FIXED-WINDOW fallback plan (30 s spans, hop 29 s, restarted per 180 s sub-window): the low-SNR condition
where Silero heard nothing and the router recovered Indic speech anyway, i.e. the closest match to the refused windows' hypothesis. 215 such windows exist, 211 in the rooms of the 30.
SELECTION: rooms (the rooms of the 30 refused windows) ordered by tier-1 window count desc then id; the top 10 rooms; ONE tier-1 window per room drawn with random.Random(SEED + 5) partial Fisher-Yates over the sorted
window ids of that room. Measured span = the union of the window's qualifying segments, the first NOISY_S-style cap of 300 s of it; the window's OWN language (its most frequent qualifying label) is the single forced language.
  python3 indic_controls.py --features F --main-draw DRAW.json --out OUT.json"""
import argparse, collections, json, os, random, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "2026-09-25-refused-speech"))
import refused_logic as R
import segmentation_check as S

SEED = R.SEED + 5
N_CONTROLS, CAP_S, MIN_S, TIER1_SHARE = 10, 300.0, 60.0, 0.80
SCRIPT = {"kn": "KANNADA", "hi": "DEVANAGARI"}


def qualifying(rows):
    by = collections.defaultdict(list)
    for r in rows:
        if r["engine"] in ("sravaani", "indicconformer") and r["lang"] in SCRIPT and r.get("dominant_script") == SCRIPT[r["lang"]] and r["score"] >= 0.60 and r["start_s"] is not None:
            by[r["window_id"]].append(r)
    return by


def capped_span(segs, cap=CAP_S):
    iv = R.union([(x["start_s"], x["end_s"]) for x in segs])
    out, used = [], 0.0
    for a, b in iv:
        if used >= cap:
            break
        b2 = min(b, a + (cap - used))
        out.append([round(a, 2), round(b2, 2)])
        used += b2 - a
    return out


def select(rows, rooms, seed=SEED, n=N_CONTROLS):
    by = qualifying(rows)
    tier1 = collections.defaultdict(list)
    for w, segs in by.items():
        if sum(x["end_s"] - x["start_s"] for x in segs) < MIN_S or segs[0]["room_id"] not in rooms:
            continue
        share = sum(S.seg_fixed(x["start_s"], x["end_s"]) for x in segs) / len(segs)
        if share >= TIER1_SHARE:
            tier1[segs[0]["room_id"]].append(w)
    order = sorted(tier1, key=lambda r: (-len(tier1[r]), r))[:n]
    out = []
    for room in order:
        w = R.pick(sorted(tier1[room]), 1, seed)[0]
        segs = by[w]
        lang = collections.Counter(x["lang"] for x in segs).most_common(1)[0][0]
        segs = [x for x in segs if x["lang"] == lang]
        out.append(dict(window_id=w, room_id=room, lang=lang, span=capped_span(segs), n_qualifying_segments=len(segs), tier1_pool_in_room=len(tier1[room])))
    return out, {r: len(v) for r, v in tier1.items()}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--features", required=True); ap.add_argument("--main-draw", required=True); ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with open(a.features) as f:
        rows = [json.loads(l) for l in f if l.strip()]
    rooms = set(R.read_json(a.main_draw)["chosen"])
    sel, pools = select(rows, rooms)
    doc = dict(seed=SEED, features_sha256=R.sha256_file(a.features), tier1_pools_by_room=pools, controls=sel)
    fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(doc, indent=1) + "\n")
    print("selected", len(sel), "| rooms", [c["room_id"][5:] for c in sel], "| langs", dict(collections.Counter(c["lang"] for c in sel)), "| measured s", round(sum(b - a for c in sel for a, b in c["span"]), 1))
