"""calibrate_nemo.py: READ-ONLY calibration of the 7A "90 s" rule on Nemotron turns against pyannote turns (ORDERS-PALIMPSEST-13B).

Population: the 26-27 Sep windows that have a live pyannote-local-twin track (ok or empty) AND a live diar.nemotron track (ok or empty) (the second was run by window_lanes on the same windows).
Both turn sources go through the SAME 7A code (classify_windows.diar_features / longest_turn_taking / label_of, no visit overlap, so label == label_turn_only); Nemotron's segments are on TAPE time, so the
window t0 is subtracted, pyannote's are already window-relative. Nothing is written to the store; the outputs (0600) are counts and numbers only: no window text is read except the
cue score classify_windows.run already computes in memory from the whisper-auto text of the full-stack windows (the same score 7A used).

What it reports (JSON + md):
  confusion      pyannote@90 x nemotron@90 label counts (CONSULT-LIKE / STAFF/OTHER / QUIET)
  consult_like   count and hours under each source at 90 s, and `hot` (Nemotron's count above pyannote's by more than HOT_MARGIN)
  distributions  longest turn-taking (n/min/p10/median/p90/max), speech fraction, speakers (n_speakers and n_speakers_10s: summary, mean, histogram) under each source
  cues           the whisper-cue catch rate (cue >= 1.0 and >= 2.0 per minute) and the no-cue share under each source, on the windows that have a cue score (7A's full-stack population)
  thresholds     for T in 90..300 step 15 on Nemotron turns: CONSULT-LIKE count and hours, catch rates, no-cue share, and the agreement with pyannote@90 (both / only Nemotron / only pyannote,
                 precision, recall, F1, kappa); `best_T` = the T with the highest F1 against pyannote@90, `count_match_T` = the T whose count is closest to pyannote@90's, `catch_match_T` = the T whose
                 catch rate at cue 1.0 is closest to pyannote@90's.
A box-only rows file (window_id, both labels, the features, the cue score) lets a reviewer recompute everything.
"""
import argparse
import collections
import json
import os
import sys

from . import classify_windows as cw
from . import reb
from .from_hist import load_heldout, window_held

OUT = "/home/eta/oc/palimpsest/out"
DATES = cw.DATES
LABELS = ("CONSULT-LIKE", "STAFF/OTHER", "QUIET")
THRESHOLDS = tuple(range(90, 301, 15))
HOT_MARGIN = 0.10
PY, NEM = "pyannote-local-twin", "nemotron"


def engine_turns(w, engine):
    """-> turns [(t0_s, t1_s, speaker)] in WINDOW-relative seconds from the latest live ok track of `engine` (an empty live track = [] = a measured zero), or None when there is neither."""
    tr = [t for t in w.tracks(layer="diar", engine=engine) if t.status != "quarantined"]
    ok = sorted([t for t in tr if t.status == "ok"], key=lambda t: t.entry.get("finished_at") or t.entry.get("created_at") or "")
    if ok:
        off = w.t0_ms if engine == NEM else 0   # nemotron segments are on tape time
        return [((s["t0_ms"] - off) / 1000.0, (s["t1_ms"] - off) / 1000.0, str(s.get("speaker"))) for s in ok[-1].segments]
    return [] if any(t.status == "empty" for t in tr) else None


def label(f, t=cw.TT_MIN_S):
    return cw.label_of(f["speech_frac"], f["longest_turn_taking_s"] or 0, None, tt_min=t)


def collect(root, ids, is_held, scores=None):
    """-> (rows, counters). One row per window with both sources; ids with a missing source are counted, not guessed."""
    rows, c = [], collections.Counter()
    for wid in ids:
        c["ids"] += 1
        try:
            w = reb.load_window(wid, root=root)
        except Exception:  # noqa: BLE001 - an unreadable id is counted
            c["not_found"] += 1
            continue
        if window_held(is_held, w.room_id, w.t0_ms, w.t1_ms):
            c["blind"] += 1
            continue
        py, nem = engine_turns(w, PY), engine_turns(w, NEM)
        if py is None:
            c["missing_pyannote"] += 1
        if nem is None:
            c["missing_nemotron"] += 1
        if py is None or nem is None:
            continue
        a = (w.t1_ms - w.t0_ms) / 1000.0
        fp, fn = cw.diar_features(py, a), cw.diar_features(nem, a)
        rows.append({"window_id": wid, "audio_s": a, "py": fp, "nem": fn, "clinical_score": (scores or {}).get(wid)})
        c["both"] += 1
    return rows, dict(c)


def hours(rows, pick):
    return round(sum(r["audio_s"] for r in rows if pick(r)) / 3600.0, 2)


def stats(vals):
    v = [x for x in vals if x is not None]
    return {**cw.summ(v), "mean": round(sum(v) / len(v), 3) if v else None}


def histogram(vals, top=5):
    h = collections.Counter(min(int(x), top) for x in vals if x is not None)
    return {(str(k) if k < top else f"{top}+"): h.get(k, 0) for k in range(top + 1)}


def kappa(tp, fp, fn, tn):
    n = tp + fp + fn + tn
    if not n:
        return None
    po = (tp + tn) / n
    pe = ((tp + fp) * (tp + fn) + (fn + tn) * (fp + tn)) / (n * n)
    return round((po - pe) / (1 - pe), 4) if pe != 1 else None


def agree(rows, t):
    """Nemotron@t against pyannote@90 as binary CONSULT-LIKE."""
    tp = fp = fn = tn = 0
    for r in rows:
        p, q = label(r["py"]) == "CONSULT-LIKE", label(r["nem"], t) == "CONSULT-LIKE"
        tp, fp, fn, tn = tp + (p and q), fp + (q and not p), fn + (p and not q), tn + (not p and not q)
    prec, rec = (tp / (tp + fp) if tp + fp else None), (tp / (tp + fn) if tp + fn else None)
    f1 = 2 * prec * rec / (prec + rec) if prec and rec else (0.0 if prec is not None and rec is not None else None)
    r4 = lambda x: None if x is None else round(x, 4)
    return {"both": tp, "only_nemotron": fp, "only_pyannote": fn, "neither": tn, "precision": r4(prec), "recall": r4(rec), "f1": r4(f1), "kappa": kappa(tp, fp, fn, tn)}


def cue_pop(rows):
    return [{"window_id": r["window_id"], "clinical_score": r["clinical_score"]} for r in rows if r["clinical_score"] is not None]


def cue_numbers(rows, which, t):
    labs = {r["window_id"]: label(r[which], t) for r in rows}
    pop = cue_pop(rows)
    m = cw.agreement_metrics(pop, labs)
    return {"cue_windows_1.0": m["catch_rate"][">=1.0"]["cue_windows"], "catch_1.0": m["catch_rate"][">=1.0"]["share"], "catch_2.0": m["catch_rate"][">=2.0"]["share"],
            "cue_windows_2.0": m["catch_rate"][">=2.0"]["cue_windows"], "no_cue_share": m["no_cue"]["share"], "scored_windows": len(pop)}


def calibrate(rows, counters=None):
    cl = lambda which, t=cw.TT_MIN_S: (lambda r: label(r[which], t) == "CONSULT-LIKE")
    conf = {p: {n: 0 for n in LABELS} for p in LABELS}
    for r in rows:
        conf[label(r["py"])][label(r["nem"])] += 1
    n_py, n_nem = sum(1 for r in rows if cl("py")(r)), sum(1 for r in rows if cl("nem")(r))
    out = {"windows": len(rows), "counters": counters or {}, "audio_h": round(sum(r["audio_s"] for r in rows) / 3600.0, 2),
           "confusion_pyannote90_x_nemotron90": conf,
           "consult_like_at_90": {"pyannote": {"count": n_py, "hours": hours(rows, cl("py"))}, "nemotron": {"count": n_nem, "hours": hours(rows, cl("nem"))},
                                  "nemotron_over_pyannote": round(n_nem / n_py, 3) if n_py else None},
           "hot": bool(n_py and n_nem > n_py * (1 + HOT_MARGIN)), "hot_margin": HOT_MARGIN,
           "distributions": {src: {"longest_turn_taking_s": stats([r[k]["longest_turn_taking_s"] for r in rows]), "speech_frac": stats([r[k]["speech_frac"] for r in rows]),
                                   "n_speakers": {**stats([r[k]["n_speakers"] for r in rows]), "histogram": histogram([r[k]["n_speakers"] for r in rows])},
                                   "n_speakers_10s": {**stats([r[k]["n_speakers_10s"] for r in rows]), "histogram": histogram([r[k]["n_speakers_10s"] for r in rows])}}
                             for src, k in (("pyannote", "py"), ("nemotron", "nem"))},
           "cues": {"pyannote@90": cue_numbers(rows, "py", cw.TT_MIN_S), "nemotron@90": cue_numbers(rows, "nem", cw.TT_MIN_S)}}
    table = []
    for t in THRESHOLDS:
        n = sum(1 for r in rows if cl("nem", t)(r))
        table.append({"T": t, "consult_like": n, "hours": hours(rows, cl("nem", t)), **cue_numbers(rows, "nem", t), "vs_pyannote90": agree(rows, t)})
    out["thresholds_nemotron"] = table
    ref = out["cues"]["pyannote@90"]["catch_1.0"]
    if table and rows:
        out["best_T"] = max(table, key=lambda x: (x["vs_pyannote90"]["f1"] or 0, -x["T"]))["T"]
        out["count_match_T"] = min(table, key=lambda x: (abs(x["consult_like"] - n_py), x["T"]))["T"]
        out["catch_match_T"] = min((x for x in table if x["catch_1.0"] is not None), key=lambda x: (abs(x["catch_1.0"] - ref), x["T"]))["T"] if ref is not None else None
    return out


def md(res):
    c, ct = res["consult_like_at_90"], res["confusion_pyannote90_x_nemotron90"]
    L = ["# Nemotron vs pyannote: the 90 s rule on 26-27 Sep windows (counts only)", "",
         f"windows with both sources: {res['windows']} ({res['audio_h']} h); counters: {res['counters']}", "",
         "## CONSULT-LIKE at 90 s", "", f"pyannote {c['pyannote']['count']} windows / {c['pyannote']['hours']} h; nemotron {c['nemotron']['count']} / {c['nemotron']['hours']} h; ratio {c['nemotron_over_pyannote']}; **hot: {res['hot']}** (margin {res['hot_margin']})", "",
         "## Confusion (rows pyannote@90, columns nemotron@90)", "", "| | " + " | ".join(LABELS) + " |", "|---|---|---|---|"]
    L += [f"| {p} | " + " | ".join(str(ct[p][n]) for n in LABELS) + " |" for p in LABELS]
    L += ["", "## Distributions", "", "```", json.dumps(res["distributions"], indent=1), "```", "", "## Cues (whisper cue per minute; 7A full-stack windows with a score)", "", "```", json.dumps(res["cues"], indent=1), "```", "",
          "## Nemotron thresholds vs pyannote@90", "", "| T | CONSULT-LIKE | h | catch>=1.0 | catch>=2.0 | no-cue | both | only nemo | only pyan | precision | recall | F1 | kappa |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for x in res["thresholds_nemotron"]:
        a = x["vs_pyannote90"]
        L.append(f"| {x['T']} | {x['consult_like']} | {x['hours']} | {x['catch_1.0']} | {x['catch_2.0']} | {x['no_cue_share']} | {a['both']} | {a['only_nemotron']} | {a['only_pyannote']} | {a['precision']} | {a['recall']} | {a['f1']} | {a['kappa']} |")
    L += ["", f"best_T (F1 vs pyannote@90): {res.get('best_T')}; count_match_T: {res.get('count_match_T')}; catch_match_T: {res.get('catch_match_T')}"]
    return "\n".join(L) + "\n"


def write_private(path, body):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(body)
    os.chmod(path, 0o600)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ids", required=True, help="JSON list of window ids (the pyannote-evidence windows)")
    ap.add_argument("--root", default=reb.DEFAULT_ROOT)
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args(argv)
    is_held = load_heldout()   # fail closed
    ids = json.load(open(a.ids))
    pop, _ = cw.run(a.root, DATES, is_held=is_held, with_text=True)   # 7A's cue score, computed in memory from whisper-auto text; no text is kept or printed
    scores = {r["window_id"]: r.get("clinical_score") for r in pop}
    rows, counters = collect(a.root, ids, is_held, scores)
    res = calibrate(rows, counters)
    os.makedirs(a.out, exist_ok=True)
    write_private(os.path.join(a.out, "CALIBRATE-NEMO-90S.json"), json.dumps(res, indent=1))
    write_private(os.path.join(a.out, "CALIBRATE-NEMO-90S.md"), md(res))
    write_private(os.path.join(a.out, "CALIBRATE-NEMO-90S-ROWS.jsonl"), "\n".join(json.dumps({"window_id": r["window_id"], "py_label": label(r["py"]), "nem_label": label(r["nem"]),
                  "py": {k: r["py"][k] for k in ("speech_s", "speech_frac", "n_speakers", "n_speakers_10s", "longest_turn_taking_s")},
                  "nem": {k: r["nem"][k] for k in ("speech_s", "speech_frac", "n_speakers", "n_speakers_10s", "longest_turn_taking_s")}, "clinical_score": r["clinical_score"]}) for r in rows) + "\n")
    print(json.dumps({"windows": res["windows"], "consult_like_at_90": res["consult_like_at_90"], "hot": res["hot"], "best_T": res.get("best_T"), "counters": counters}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
