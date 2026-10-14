"""sample_draw.py: the 200-segment STRATIFIED sample for human labelling (ruling 337c). Frozen design, written once (O_EXCL). Reads features.jsonl (no text) from score_all.py.

STRATA = (engine/language cell) x (flagged at 0.60 / unflagged). Allocation of 200 (fixed here, before any label exists):
  sravaani/und   flagged 40 | unflagged 6      whisper/en  flagged 30 | unflagged 30
  sravaani/kn    flagged 12 | unflagged 20      sravaani/hi flagged 10 | unflagged 14
  sravaani/ta+ml+te+bn+gu+other  flagged 10 | unflagged 12      indicconformer (all)  flagged 4 | unflagged 12
Selection inside a stratum: ids sorted, partial Fisher-Yates over random.Random(SEED).random() (SEED 20260935), chosen sorted; a stratum with fewer rows than its allocation gives all of them.
ESTIMATOR (frozen): per cell c, precision_c = share of the drawn FLAGGED rows labelled garbled; miss_c = share of the drawn UNFLAGGED rows labelled garbled. Overall (weights = the cell's segment count):
  precision = sum_c F_c * precision_c / sum_c F_c ; recall = sum_c F_c*precision_c / (sum_c F_c*precision_c + sum_c U_c*miss_c), with F_c, U_c the flagged/unflagged counts of the cell.
  'unsure' labels are reported as a count and excluded from the ratios (with the ratios also given counting unsure as garbled and as readable: the two bounds).
LABEL SET (one per row): readable | garbled | wrong_language | unsure. readable = a fluent speaker can follow it (ANY script, including romanised); garbled = the words do not make sense; wrong_language = the text is in a
language other than the one spoken (listen to the clip if needed).
OUTPUT: sample200_ids.json (ids, strata, features, no text; safe to commit) and, on the box only, sample200_sheet.tsv (adds the text, 0600). Nothing here hides any segment."""
import argparse, json, os, random

SEED = 20260935
ALLOC = {("sravaani/und", True): 40, ("sravaani/und", False): 6, ("whisper/en", True): 30, ("whisper/en", False): 30, ("sravaani/kn", True): 12, ("sravaani/kn", False): 20,
         ("sravaani/hi", True): 10, ("sravaani/hi", False): 14, ("sravaani/other-indic", True): 10, ("sravaani/other-indic", False): 12,
         ("indicconformer/all", True): 4, ("indicconformer/all", False): 12}
HOME = os.path.expanduser("~/eta-data")


def cell_of(r):
    if r["engine"] == "indicconformer":
        return "indicconformer/all"
    lang = r["lang"]
    if r["engine"] == "sravaani":
        return "sravaani/" + (lang if lang in ("und", "kn", "hi") else "other-indic")
    return "whisper/en"


def pick(sorted_ids, n, seed):
    rng = random.Random(seed)
    pool = list(sorted_ids)
    n = min(n, len(pool))
    for j in range(n):
        k = j + int(rng.random() * (len(pool) - j))
        pool[j], pool[k] = pool[k], pool[j]
    return sorted(pool[:n])


def draw(rows):
    by = {}
    for r in rows:
        by.setdefault((cell_of(r), bool(r["flagged"])), {})[r["id"]] = r
    out, sizes = [], {}
    for key in sorted(ALLOC):
        pool = by.get(key, {})
        sizes[f"{key[0]}|{'flagged' if key[1] else 'unflagged'}"] = len(pool)
        for i in pick(sorted(pool), ALLOC[key], SEED):
            r = pool[i]
            out.append(dict(id=i, window_id=r["window_id"], room_id=r["room_id"], ist_date=r["ist_date"], engine=r["engine"], lang=r["lang"], start_s=r["start_s"], end_s=r["end_s"],
                            cell=key[0], flagged=key[1], score=r["score"], reasons=r["reasons"], dominant_script=r["dominant_script"], non_word_rate=r["non_word_rate"],
                            repeat_ratio=r["repeat_ratio"], n_tokens=r["n_tokens"]))
    return out, sizes


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--features", required=True)
    ap.add_argument("--out-dir", required=True)
    a = ap.parse_args()
    with open(a.features) as f:
        rows = [json.loads(l) for l in f if l.strip()]
    sample, sizes = draw(rows)
    doc = dict(seed=SEED, n=len(sample), allocation={f"{k[0]}|{'flagged' if k[1] else 'unflagged'}": v for k, v in ALLOC.items()}, stratum_sizes=sizes, rows=sample)
    write_private(os.path.join(a.out_dir, "sample200_ids.json"), json.dumps(doc, indent=1) + "\n")
    # the box-only sheet with text
    want = {r["id"] for r in sample}
    texts = {}
    import score_all
    for wid, (p, d) in score_all.latest_records().items():
        for i, s in enumerate(d["segments"]):
            if f"{wid}#{i}" in want:
                texts[f"{wid}#{i}"] = " ".join((s.get("text") or "").split())
    lines = ["id\tengine\tlang\tstart_s\tend_s\ttext\tlabel"]
    for r in sample:
        lines.append("\t".join([r["id"], r["engine"], str(r["lang"]), str(r["start_s"]), str(r["end_s"]), texts.get(r["id"], ""), ""]))
    write_private(os.path.join(a.out_dir, "sample200_sheet.tsv"), "\n".join(lines) + "\n")
    print("sample rows", len(sample), "| stratum sizes", sizes)
