"""score_all.py: score EVERY non-refused segment of the raw run records on this box with readability.py (ruling 337c). Output on the box only (0700 dir, 0600 files, never in git):
  vocab.json      the English vocabulary (words seen >= 10 times in >= 5 distinct windows in whisper segments) + its sha256
  features.jsonl  one row per segment: id, window_id, room_id, ist_date, engine, lang, start_s, end_s, features, score, reasons, flagged. NO TEXT.
  summary.json    counts only (safe to commit)
  python3 score_all.py --out-dir D
Population: one record per window_id (the lexicographically last path under hist/runs, hist/out, lab-vault/staged/runs); refused segments have no text and are skipped (counted)."""
import argparse, collections, hashlib, json, os, sys

import readability as Rd

HOME = os.path.expanduser("~/eta-data")
ROOTS = ("hist/runs", "hist/out", "lab-vault/staged/runs")
GROUP = {"kn": "kn", "hi": "hi", "mr": "hi", "ta": "ta", "ml": "ml", "bn": "bn", "gu": "gu", "te": "te", "pa": "other-indic", "en": "en", "und": "und"}


def latest_records():
    by = {}
    for r in ROOTS:
        for dp, _dn, fn in os.walk(os.path.join(HOME, r)):
            for f in fn:
                if f.endswith(".json"):
                    p = os.path.join(dp, f)
                    try:
                        with open(p) as fh:
                            head = fh.read(400)
                        if '"window_id"' not in head and '"segments"' not in head:
                            pass
                        d = json.load(open(p))
                    except (OSError, ValueError):
                        continue
                    if isinstance(d, dict) and isinstance(d.get("segments"), list) and "window_id" in d:
                        prev = by.get(d["window_id"])
                        if prev is None or p > prev[0]:
                            by[d["window_id"]] = (p, d)
    return by


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


def main(out_dir):
    recs = latest_records()
    # pass 1: the English vocabulary, from whisper English text only
    cnt, wins = collections.Counter(), collections.defaultdict(set)
    for wid, (_p, d) in recs.items():
        for s in d["segments"]:
            if s.get("refused") or s.get("engine") != "whisper":
                continue
            for t in Rd.tokens(s.get("text") or ""):
                w = t.lower().strip("'-")
                if w and w.isalpha() and w.isascii():
                    cnt[w] += 1
                    wins[w].add(wid)
    vocab = Rd.build_vocab({w: (cnt[w], len(wins[w])) for w in cnt})
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    vtxt = json.dumps(sorted(vocab))
    write_private(os.path.join(out_dir, "vocab.json"), vtxt)
    vsha = hashlib.sha256(vtxt.encode()).hexdigest()
    # pass 2: score
    rows = []
    n_ref = n_seg = 0
    for wid in sorted(recs):
        p, d = recs[wid]
        for i, s in enumerate(d["segments"]):
            n_seg += 1
            if s.get("refused"):
                n_ref += 1
                continue
            t = s.get("text") or ""
            r = Rd.readability(t, s.get("lang"), s.get("engine"), vocab)
            r.update(id=f"{wid}#{i}", window_id=wid, room_id=d.get("room_id"), ist_date=wid[:10], engine=s.get("engine"), lang=s.get("lang"),
                     start_s=s.get("start_s"), end_s=s.get("end_s"))
            rows.append(r)
    write_private(os.path.join(out_dir, "features.jsonl"), "\n".join(json.dumps(r, sort_keys=True) for r in rows) + "\n")
    C = collections.Counter
    def cell(r):
        return f"{r['engine']}/{GROUP.get(r['lang'], r['lang'])}"
    by = collections.defaultdict(lambda: dict(n=0, flagged=0, reasons=C()))
    for r in rows:
        c = by[cell(r)]
        c["n"] += 1
        c["flagged"] += r["flagged"]
        for w in r["reasons"]:
            c["reasons"][w] += 1
    summ = dict(windows=len(recs), segments=n_seg, refused=n_ref, scored=len(rows), vocab_words=len(vocab), vocab_sha256=vsha, flagged=sum(r["flagged"] for r in rows),
                flag_below=Rd.FLAG_BELOW, readability_py_sha256=hashlib.sha256(open(Rd.__file__, "rb").read()).hexdigest(),
                score_deciles=[round(q, 3) for q in __import__("statistics").quantiles([r["score"] for r in rows], n=10)],
                flagged_at_other_thresholds={str(t): sum(r["score"] < t for r in rows) for t in (0.3, 0.4, 0.5, 0.6, 0.7, 0.8)},
                by_cell={k: dict(n=v["n"], flagged=v["flagged"], share=round(v["flagged"] / v["n"], 3), reasons=dict(v["reasons"])) for k, v in sorted(by.items())},
                short_segments=sum(r["short"] for r in rows))
    write_private(os.path.join(out_dir, "summary.json"), json.dumps(summ, indent=1) + "\n")
    print(json.dumps({k: v for k, v in summ.items() if k != "by_cell"}, indent=1))
    for k, v in summ["by_cell"].items():
        print(f"{k:22} n {v['n']:6} flagged {v['flagged']:6} ({v['share']:.3f})  {v['reasons']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True)
    main(ap.parse_args().out_dir)
