"""link3_coverage_s2.py: the FOUND_ELSEWHERE reading of the coverage pass, exactly as fixed in P1-PREREG-v7.14 S2 (nothing new is decided here).

S2 says the decoy scoring "is added to the pass when a sub-window first reaches 0.50". The first score stage (link3_coverage.py score) keeps only each room's best sub-window and no decoys, so for every item whose
best is at least 0.50 this file re-scores EVERY sub-window (same enumeration, same question LINK_QUESTION_V2, same floor), scores the top sub-window against the same-day decoy prescriptions of the main run
(run/deid/<item>_rxdNN.json: same doctor, same IST day, not the own Rx), and applies S2 literally:
  FOUND_ELSEWHERE = top sub-window own score >= 0.50 AND >= 0.15 above the best score of ANY other sub-window of that item AND >= 0.15 above the best decoy on that same sub-window; else NOT_FOUND_IN_TEXT.
It also prints, labelled as a diagnostic and not a rule, the runner-up excluding sub-windows that overlap the top one in the same room (overlap is by construction: 10-minute windows, 5-minute step).
Diagnostic only; cannot change any item's primary verdict. Text stays in ~/eta-data/surgical-chain/p1/cov/ (0700); stdout carries ids, scores and offsets only.
  python3 link3_coverage_s2.py [item ...]      (default: every item with a stored best >= 0.50)
"""
import json, os, sys
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
COV = os.path.expanduser("~/eta-data/surgical-chain/p1/cov/"); RUN = os.path.expanduser("~/eta-data/surgical-chain/p1/run/")
SUB, STEP, MIN_TURNS, MIN_CHARS = timedelta(minutes=10), timedelta(minutes=5), 3, 60          # identical to link3_coverage.py
FLOOR, MARGIN = 0.50, 0.15


def iso(s): return datetime.fromisoformat(s.replace("Z", "+00:00"))


def jl(path):
    with open(path) as f:
        return json.load(f)


def sub_windows(turns, lo, hi):
    """[(t0, text)] for every 10-minute sub-window (step 5) with at least 3 English turns and 60 characters: the enumeration of link3_coverage.stage_score."""
    tu = [t for t in turns if (t.get("en") or "").strip()]; times = [iso(t["at"]) for t in tu]; out = []; t0 = lo
    while t0 + SUB <= hi:
        seg = [t for t, ta in zip(tu, times) if t0 <= ta < t0 + SUB]
        txt = "\n".join(f"[{t['i']}] {t['en']}" for t in seg)
        if len(seg) >= MIN_TURNS and len(txt) >= MIN_CHARS:
            out.append((t0, txt))
        t0 += STEP
    return out


def s2_verdict(rows, decoy_best):
    """rows: [dict(score, doc, source, t0, offset_min)] over ALL sub-windows of the item. Returns the S2 reading, literally."""
    top = max(rows, key=lambda r: r["score"]); rest = [r["score"] for r in rows if r is not top]
    other = max(rest, default=None)
    over_other = None if other is None else round(top["score"] - other, 3)
    over_decoy = None if decoy_best is None else round(top["score"] - decoy_best, 3)
    ok = top["score"] >= FLOOR and (other is None or top["score"] - other >= MARGIN - 1e-9) and (decoy_best is None or top["score"] - decoy_best >= MARGIN - 1e-9)
    return dict(verdict="FOUND_ELSEWHERE" if ok else "NOT_FOUND_IN_TEXT", top=top, over_other_subwindow=over_other, over_best_decoy=over_decoy)


def diagnostic_runner_up(rows):
    """NOT the rule: the best other sub-window that does not overlap the top one in the same room (different room, or 10 or more minutes apart)."""
    top = max(rows, key=lambda r: r["score"])
    far = [r["score"] for r in rows if r is not top and (r["doc"] != top["doc"] or abs((r["t0"] - top["t0"]).total_seconds()) >= SUB.total_seconds())]
    return max(far, default=None)


def run_item(it, man, ask=None, cov=COV, run=RUN):
    import link3_judge as lj
    sc = lambda a, b: lj.score(a, b, ask, lj.LINK_QUESTION_V2)
    m = man[it]; lo, hi, rx_ts = iso(m["lo"]), iso(m["hi"]), iso(m["rx_ts"])
    rx_own = "\n".join(t.get("en") or "" for t in jl(cov + f"deid/{it}_rxown.json")["turns"]); rows = []; calls = 0
    for did, dm in m["docs"].items():
        for t0, txt in sub_windows(jl(cov + f"deid/{did}.json")["turns"], lo, hi):
            rows.append(dict(score=sc(txt, rx_own), doc=did, source=dm["source"], t0=t0, text=txt, offset_min=round(((t0 + SUB / 2) - rx_ts).total_seconds() / 60, 1))); calls += 1
    if not rows:
        return dict(verdict="NOT_FOUND_IN_TEXT", calls=0, note="no sub-window with enough English text")
    top = max(rows, key=lambda r: r["score"]); decoys = []
    if top["score"] >= FLOOR:
        n = 0
        while os.path.exists(run + f"deid/{it}_rxd{n:02d}.json"):
            decoys.append(sc(top["text"], "\n".join(t.get("en") or "" for t in jl(run + f"deid/{it}_rxd{n:02d}.json")["turns"]))); calls += 1; n += 1
    res = s2_verdict(rows, max(decoys) if decoys else None)
    res["top"] = {k: (v.isoformat() if k == "t0" else v) for k, v in res["top"].items() if k != "text"}
    res.update(calls=calls, n_sub_windows=len(rows), n_decoys=len(decoys), diagnostic_runner_up_excluding_overlap=diagnostic_runner_up(rows),
               sub_windows_at_or_above_floor=sum(r["score"] >= FLOOR for r in rows))
    return res


def main(argv, ask=None):
    man = jl(COV + "manifest.json"); prev = jl(COV + "coverage_results.json")
    todo = argv or sorted(it for it, v in prev.items() if v["best"]["score"] >= FLOOR)
    out = {}
    for it in todo:
        r = run_item(it, man, ask, COV, RUN); out[it] = r; t = r.get("top", {})
        print(f"{it}: {r['verdict']} | top {t.get('score')} at offset {t.get('offset_min')} min, {t.get('source')}, room {t.get('doc')} | over next sub-window (any) {r.get('over_other_subwindow')} "
              f"| over best decoy {r.get('over_best_decoy')} (n decoys {r.get('n_decoys')}) | diagnostic runner-up excluding overlap {r.get('diagnostic_runner_up_excluding_overlap')} "
              f"| sub-windows >= floor {r.get('sub_windows_at_or_above_floor')} of {r.get('n_sub_windows')} | calls {r['calls']}")
    fd = os.open(COV + "coverage_s2.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)          # never overwritten
    with os.fdopen(fd, "w") as f:
        json.dump(out, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
