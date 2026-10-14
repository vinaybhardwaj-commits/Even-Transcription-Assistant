"""refset_engines.py: the 8A reference set re-scored with MedASR and Koyal text beside Sarvam (architect #10886).

Same 25 consults, same record terms, same matcher A (refset.py) and matcher B (refset_b.py, Jev per term, one request per consult per engine) as 8A, with one text source per engine:
  sarvam   : A on the Sarvam stt text OR its English translation (as in 8A "either"); B on the translation where present, else the original (as in 8A)
  medasr   : A and B on the MedASR transcript (google/medasr, English-medical model, greedy); the state is marked, no speakers
  koyal    : A and B on the Koyal transcript in its NATIVE script (marked in the state); only consults with a Koyal track (English consults are skipped by the lane)
Each engine's text is judged separately (the state is only that engine's text). Matcher A on native-script Koyal text can match only Latin-script or digit tokens of a term; that is a property of the
text, reported as is. Outputs hold ids, counts and numbers only; term names go to a separate 0600 file on the box. Heldout (day+room, then span) before any text is read.

Per engine: recall by category and language (A and B); per-term cross-table of each other engine against Sarvam (both / sarvam only / engine only / neither) for A and for B, by category.
"""
import argparse
import collections
import datetime
import json
import os
import sys
import time

from . import jev_client
from . import refset as rs
from . import refset_b as rb
from . import sarvam_lane as sl
from .from_hist import load_heldout, window_held

ENGINES = ("sarvam", "medasr", "koyal")
ENGINE_TRACK = {"medasr": "medasr", "koyal": "koyal"}
OUT = rb.OUT


def live_engine(root, row, engine):
    """Latest finished ok stt track of `engine` (medasr | koyal) for the consult whose clip signature is the cutter row's, or None."""
    from . import writer
    try:
        m = json.load(open(os.path.join(writer._window_dir(root, row["ist_date"], row["room_id"], "consult-" + row["consult_uid"]), "manifest.json")))
    except (OSError, ValueError):
        return None
    best = None
    for e in m.get("tracks", []):
        if e.get("layer") != "stt" or e.get("engine") != ENGINE_TRACK[engine] or e.get("status") != "ok":
            continue
        p = os.path.join(root, e["path"])
        if os.path.exists(p) and (best is None or (e.get("finished_at") or "") >= (best[0] or "")):
            best = (e.get("finished_at"), p)
    if not best:
        return None
    t = json.load(open(best[1]))
    return t if (t.get("config") or {}).get("clip_signature") == row["signature"] else None


def build_engine_state(track, engine):
    """State for an engine without speakers: a marked first line, then the segments in time order."""
    lang = (track.get("extras") or {}).get("sarvam_language_code") or (track.get("extras") or {}).get("language")
    label = {"medasr": "MedASR transcript (English-medical speech model; Indian-language speech is mostly lost)",
             "koyal": f"Koyal transcript in its native script{' (' + str(lang) + ')' if lang else ''}"}[engine]
    lines = [(sg.get("text") or "").strip() for sg in sorted(track["segments"], key=lambda x: (x["t0_ms"], x["t1_ms"]))]
    return f"Source: {label}\n" + "\n".join(l for l in lines if l)


def _a_found(term, idx):
    return bool(term.scorable and idx and rs.term_found(term, idx))


def run_engines(ids, records, jev, root=rs.REB, is_held=None, index_path=sl.CLIP_INDEX, clips_root=sl.CLIPS, synonyms=None):
    """-> (results dict, names dict {consult_uid: [{category, names, sarvam, medasr, koyal}]} for the box-only file)."""
    is_held = is_held or load_heldout()
    look, syn_sha = synonyms if synonyms is not None else rs.load_synonyms()
    rows = sl.latest_rows(index_path)
    per, counts, excluded, names = [], collections.Counter(), [], {}
    for uid in ids:
        counts["asked"] += 1
        r = rows.get(uid)
        if not r or r.get("status") != "cut":
            counts["not_a_cut_clip"] += 1
            continue
        if is_held(r["ist_date"], r["room_id"]):   # before any text is read
            counts["blind_refused"] += 1
            continue
        try:
            clip = sl.open_clip(r, clips_root)
        except sl.ClipRefused:
            counts["clip_mismatch"] += 1
            continue
        if window_held(is_held, r["room_id"], clip["span_start_ms"], clip["span_end_ms"]):
            counts["blind_refused"] += 1
            continue
        rec = records.get(uid)
        if not rec or not rec["terms"]:
            counts["no_terms"] += 1
            continue
        if len(rec["prescriptions"]) > 1 or rec["any_draft"]:
            counts["join_excluded"] += 1
            excluded.append({"consult_uid": uid})
            continue
        stt, tr = rs.live_ok(root, r, "stt"), rs.live_ok(root, r, "translate")
        if not stt:
            counts["no_live_track"] += 1
            continue
        terms = [t.with_synonyms(look) for t in rec["terms"]]
        tracks = {"medasr": live_engine(root, r, "medasr"), "koyal": live_engine(root, r, "koyal")}
        texts = {"sarvam_stt": rs.track_text(stt), "sarvam_translate": rs.track_text(tr) if tr else "",
                 "medasr": rs.track_text(tracks["medasr"]), "koyal": rs.track_text(tracks["koyal"])}
        idx = {k: rs.index_text(v) for k, v in texts.items()}
        states = {"sarvam": rb.build_state(stt, tr)[0]}
        for e in ("medasr", "koyal"):
            if tracks[e] and rs.norm_text(texts[e]):
                states[e] = build_engine_state(tracks[e], e)
        qs = {f"t{i}": (rb.QUESTION.format(term=rb.display_name(t)), rb.OPTIONS, rb.ESCAPE) for i, t in enumerate(terms)}
        ans, failed = {}, []
        for e, state in states.items():
            try:
                ans[e] = jev.choose_many(state, qs)
            except jev_client.JevError as ex:   # counted by reason code only
                counts["b_errors"] += 1
                counts["b_error_" + ex.reason] += 1
                failed.append(e)
        trows = []
        for i, t in enumerate(terms):
            row = {"idx": i, "category": t.category, "a_scorable": t.scorable,
                   "a": {"sarvam": _a_found(t, idx["sarvam_stt"]) or _a_found(t, idx["sarvam_translate"]), "medasr": _a_found(t, idx["medasr"]), "koyal": _a_found(t, idx["koyal"])},
                   "b": {}}
            for e in states:
                if e in ans:
                    p = ans[e].get(f"t{i}") or {}
                    row["b"][e] = rb.verdict(p)
            trows.append(row)
            if t.scorable:
                names.setdefault(uid, []).append({"category": t.category, "names": t.names, "a": row["a"], "b": row["b"]})
        lang = rs.language_heard(stt)
        per.append({"consult_uid": uid, "ist_date": r["ist_date"], "language_heard": lang, "english": rs.is_english(lang),
                    "engine_available": {"sarvam": True, "medasr": bool(tracks["medasr"]), "koyal": bool(tracks["koyal"])},
                    "engine_empty": {e: bool(tracks[e]) and not rs.norm_text(texts[e]) for e in ("medasr", "koyal")},
                    "b_failed": failed, "terms": trows})
        counts["scored"] += 1
    return {"schema": "refset.results.engines.v1", "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "synonyms_sha256": syn_sha,
            "thresholds": {"mentioned_p": rb.MENTIONED_P, "not_mentioned_p": rb.NOT_MENTIONED_P}, "judge": {"configured": getattr(jev, "model", None), "reported": getattr(jev, "model_id", None)},
            "counts": dict(counts), "join_excluded": excluded, "per_consult": per, "aggregates": aggregates(per)}, names


def _has(p, engine):
    return p["engine_available"][engine] and not p["engine_empty"].get(engine, False)


def _recall(rows, engine, matcher, cat):
    out = []
    for p in rows:
        if not _has(p, engine):
            continue
        ts = [t for t in p["terms"] if t["category"] == cat and t["a_scorable"]]
        if matcher == "b":
            ts = [t for t in ts if engine in t["b"]]
        if ts:
            out.append(sum(1 for t in ts if (t["a"][engine] if matcher == "a" else t["b"][engine] == "mentioned")) / len(ts))
    return out


def _cross(per, engine, matcher):
    """Per category, sarvam vs `engine` on the A-scorable terms of consults where the engine has text (and, for B, both verdicts exist)."""
    res = {}
    for cat in rs.CATEGORIES:
        c = collections.Counter()
        for p in per:
            if not _has(p, engine):
                continue
            for t in p["terms"]:
                if t["category"] != cat or not t["a_scorable"]:
                    continue
                if matcher == "a":
                    s, e = t["a"]["sarvam"], t["a"][engine]
                else:
                    if "sarvam" not in t["b"] or engine not in t["b"]:
                        continue
                    if "cannot_tell" in (t["b"]["sarvam"], t["b"][engine]):
                        c["cannot_tell_either"] += 1
                        continue
                    s, e = t["b"]["sarvam"] == "mentioned", t["b"][engine] == "mentioned"
                c["both" if s and e else "sarvam_only" if s else "engine_only" if e else "neither"] += 1
        res[cat] = {"terms": sum(c.values()), **{k: c[k] for k in ("both", "sarvam_only", "engine_only", "neither")}, **({"cannot_tell_either": c["cannot_tell_either"]} if matcher == "b" else {})}
    return res


def aggregates(per):
    A = {"recall": {}, "cross_a": {}, "cross_b": {}, "consults_with_text": {e: sum(1 for p in per if _has(p, e)) for e in ENGINES}}
    for name, sel in (("all", lambda p: True), ("english", lambda p: p["english"]), ("indian_language", lambda p: not p["english"])):
        rows = [p for p in per if sel(p)]
        A["recall"][name] = {"consults": len(rows), **{e: {"consults_with_text": sum(1 for p in rows if _has(p, e)),
                                                          **{cat: {"matcher_a": rs.summ(_recall(rows, e, "a", cat)), "matcher_b_mentioned": rs.summ(_recall(rows, e, "b", cat))} for cat in rs.CATEGORIES}}
                                                       for e in ENGINES}}
    for e in ("medasr", "koyal"):
        A["cross_a"][e] = _cross(per, e, "a")
        A["cross_b"][e] = _cross(per, e, "b")
    return A


def table(R):
    A = R["aggregates"]
    L = ["# Reference set by engine: Sarvam vs MedASR vs Koyal (counts only)", "", f"counts {R['counts']}; judge {R['judge']}; thresholds {R['thresholds']}; consults with text {A['consults_with_text']}", ""]
    f = lambda s: f"{s['n']} / {s['median']} / {s['p10']} / {s['p90']}"
    for sp, v in A["recall"].items():
        L += [f"## recall, {sp} ({v['consults']} consults): n / median / p10 / p90", "", "| engine | consults with text | category | matcher A | matcher B mentioned |", "|---|---|---|---|---|"]
        for e in ENGINES:
            for cat in rs.CATEGORIES:
                L.append(f"| {e} | {v[e]['consults_with_text']} | {cat} | {f(v[e][cat]['matcher_a'])} | {f(v[e][cat]['matcher_b_mentioned'])} |")
        L.append("")
    for m, key in (("A", "cross_a"), ("B", "cross_b")):
        L += [f"## per-term cross-table, matcher {m}: Sarvam vs engine (A-scorable terms, consults where the engine has text)", ""]
        for e, v in A[key].items():
            L += [f"- {e}:"] + [f"  - {cat}: {x}" for cat, x in v.items()]
        L.append("")
    return "\n".join(L) + "\n"


def stability(b_run, engines_run):
    """Sarvam matcher-B verdicts of the first 8A B run vs this run (same text, a new Jev run), per category: same | flip (mentioned <-> not_mentioned) | to_cannot_tell | from_cannot_tell.
    Read-only on the two result dicts; terms are matched by (consult_uid, idx). Counts only."""
    first = {(p["consult_uid"], t["idx"]): (t["category"], t["b"]) for p in b_run["per_consult"] for t in p["terms"]}
    out = collections.defaultdict(collections.Counter)
    for p in engines_run["per_consult"]:
        for t in p["terms"]:
            k = (p["consult_uid"], t["idx"])
            if k not in first or "sarvam" not in t["b"]:
                out["_unmatched"]["terms"] += 1
                continue
            cat, v1 = first[k]
            v2 = t["b"]["sarvam"]
            kind = "same" if v1 == v2 else "to_cannot_tell" if v2 == "cannot_tell" else "from_cannot_tell" if v1 == "cannot_tell" else "flip"
            out[cat]["terms"] += 1
            out[cat][kind] += 1
    return {c: dict(v) for c, v in out.items()}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--record", help="the record-terms CSV (required unless --stability)")
    ap.add_argument("--results", default=os.path.join(OUT, "REFSET-RESULTS.json"))
    ap.add_argument("--out", default=os.path.join(OUT, "REFSET-ENGINES.json"))
    ap.add_argument("--names", default=os.path.join(OUT, "REFSET-ENGINES-NAMES.json"))
    ap.add_argument("--root", default=rs.REB)
    ap.add_argument("--synonyms", default=rs.SYNONYMS_FILE)
    ap.add_argument("--stability", nargs=2, metavar=("B_RUN_JSON", "ENGINES_JSON"), help="read-only: Sarvam matcher-B verdicts run 1 vs run 2, counts per category; no Jev call")
    a = ap.parse_args(argv)
    if a.stability:
        print(json.dumps(stability(json.load(open(a.stability[0])), json.load(open(a.stability[1]))), sort_keys=True))
        return 0
    if not a.record:
        ap.error("--record is required unless --stability is given")
    ids = json.load(open(a.results))["selection"]["consult_uids"]
    records = rs.load_record_terms(a.record)
    lp = os.path.join(OUT, "jev-calls-8A-engines-" + time.strftime("%Y%m%dT%H%M%S") + ".jsonl")
    logf = os.fdopen(os.open(lp, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "a")

    def log(meta):   # metadata only
        logf.write(json.dumps({"ts": time.strftime("%H:%M:%S"), "use": "8A-engines", **meta}, sort_keys=True) + "\n")
        logf.flush()
    client = jev_client.JevClient(log=log)
    try:
        client.warm_up()
        R, names = run_engines(ids, records, client, root=a.root, synonyms=rs.load_synonyms(a.synonyms))
    finally:
        logf.close()
    st = client.stats
    lat = sorted(st["latency_s"])
    R["jev"] = {"requests": st["calls"], "ok": st["ok"], "retries": st["retries"], "errors": st["errors"], "input_tokens": st["input_tokens"], "output_tokens": st["output_tokens"],
                "latency_median_s": lat[len(lat) // 2] if lat else None, "latency_max_s": lat[-1] if lat else None, "call_log": lp}
    R["judge"] = {"configured": client.model, "reported": client.model_id}
    rs.write_private(a.out, json.dumps(R, indent=1, sort_keys=True))
    rs.write_private(os.path.splitext(a.out)[0] + ".md", table(R))
    rs.write_private(a.names, json.dumps(names, indent=1, sort_keys=True))
    print(json.dumps({"out": a.out, "counts": R["counts"], "jev": R["jev"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
