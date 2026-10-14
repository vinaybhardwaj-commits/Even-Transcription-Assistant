"""refset_b.py: Matcher B of the Sarvam reference set (ORDERS-PALIMPSEST-8A; architect #10829). Jev judges, per record term, whether the term is discussed.

Matcher A (refset.py) is strict by design: every content word must be spoken. Matcher B asks Jev, per consult and in ONE request (the consult's Sarvam text sent once):
"Is <term> (or a clear equivalent: brand/generic, abbreviation, a spelling variant, the same test without its qualifier) mentioned or discussed in this conversation?"
with options mentioned / not_mentioned and an escape cannot_tell. Thresholds live HERE: mentioned if P(mentioned) >= 0.80, not_mentioned if P(not_mentioned) >= 0.80,
otherwise cannot_tell. The state is the consult's Sarvam text, English translation where present, else the original-language transcript, marked as which, as
"[speaker] text" lines. Real Jev (V rulings O6/O7); the client is kit/reb/jev_client.py (key in-process, metadata-only call log).

Reported beside A (numbers and consult_uids only; record names stay in a separate 0600 file on the box): recall by category and language, A/B agreement per term
(both found / A only / B only / neither), and the revised "never said aloud" = terms B says not_mentioned. Heldout (day+room, then span) before any text is read; a consult with two
prescriptions or a draft is excluded and counted, as in matcher A.
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
from . import sarvam_lane as sl
from .from_hist import load_heldout, window_held

MENTIONED_P = 0.80
NOT_MENTIONED_P = 0.80
OPTIONS = ["mentioned", "not_mentioned"]
ESCAPE = "cannot_tell"
OUT = "/home/eta/oc/palimpsest/out"
QUESTION = ("Is {term} (or a clear equivalent: brand/generic, abbreviation, a spelling variant, the same test without its qualifier) "
            "mentioned or discussed in this conversation?")


def verdict(probs):
    """{'mentioned': p, 'not_mentioned': p, ...} -> mentioned | not_mentioned | cannot_tell, by the thresholds above."""
    if probs.get("mentioned", 0.0) >= MENTIONED_P:
        return "mentioned"
    if probs.get("not_mentioned", 0.0) >= NOT_MENTIONED_P:
        return "not_mentioned"
    return "cannot_tell"


def display_name(term):
    """The term as written in the record, with its other names: 'Paracetamol 650 Mg (also written as: DOLO 650MG TAB)'. Used only inside the Jev question."""
    names, seen = [], set()
    for n in term.names:
        k = rs.norm_text(n)
        if n and n.strip() and k not in seen:
            seen.add(k)
            names.append(n.strip())
    if not names:
        return ""
    return names[0] + (f" (also written as: {'; '.join(names[1:])})" if len(names) > 1 else "")


def build_state(stt, translate):
    """-> (state text, source). translate where present, else stt; the first line says which. Lines are '[speaker] text' in time order; no names, no times."""
    track, source = (translate, "English translation (Sarvam)") if translate else (stt, "original-language transcript (Sarvam)")
    lines = [f"[{sg.get('speaker')}] {(sg.get('text') or '').strip()}" for sg in sorted(track["segments"], key=lambda x: (x["t0_ms"], x["t1_ms"])) if (sg.get("text") or "").strip()]
    return f"Source: {source}\n" + "\n".join(lines), ("translate" if translate else "stt")


def term_detail(terms, texts):
    """Matcher A per term (same rule as refset.score_consult): [{scorable, found_stt, found_translate, found_router}]."""
    idx = {k: rs.index_text(v) for k, v in texts.items()}
    out = []
    for t in terms:
        if not t.scorable:
            out.append({"scorable": False, "found_stt": False, "found_translate": False, "found_router": False})
            continue
        out.append({"scorable": True, "found_stt": rs.term_found(t, idx["stt"]), "found_translate": rs.term_found(t, idx["translate"]),
                    "found_router": bool(texts.get("router")) and rs.term_found(t, idx["router"])})
    return out


def run_b(ids, records, jev, root=rs.REB, is_held=None, index_path=sl.CLIP_INDEX, clips_root=sl.CLIPS, synonyms=None):
    """-> (results dict without record text, disagreements dict {consult_uid: [...names...]} for the box-only file)."""
    is_held = is_held or load_heldout()
    look, syn_sha = synonyms if synonyms is not None else rs.load_synonyms()
    rows = sl.latest_rows(index_path)
    per, counts, excluded, disagree = [], collections.Counter(), [], {}
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
            excluded.append({"consult_uid": uid, "prescriptions": len(rec["prescriptions"]), "any_draft": rec["any_draft"]})
            continue
        stt, tr = rs.live_ok(root, r, "stt"), rs.live_ok(root, r, "translate")
        if not stt:
            counts["no_live_track"] += 1
            continue
        terms = [t.with_synonyms(look) for t in rec["terms"]]
        rt, _ = rs.router_text(root, r, clip)
        texts = {"stt": rs.track_text(stt), "translate": rs.track_text(tr) if tr else "", "router": rt}
        detail = term_detail(terms, texts)
        state, source = build_state(stt, tr)
        qs = {f"t{i}": (QUESTION.format(term=display_name(t)), OPTIONS, ESCAPE) for i, t in enumerate(terms)}
        try:
            ans = jev.choose_many(state, qs)
        except jev_client.JevError as e:   # counted by reason code only
            counts["b_errors"] += 1
            counts["b_error_" + e.reason] += 1
            continue
        lang = rs.language_heard(stt)
        trows = []
        for i, (t, d) in enumerate(zip(terms, detail)):
            p = ans.get(f"t{i}") or {}
            trows.append({"idx": i, "category": t.category, "a_scorable": d["scorable"], "a_stt": d["found_stt"], "a_translate": d["found_translate"], "a_router": d["found_router"],
                          "b": verdict(p), "p_mentioned": round(p.get("mentioned", 0.0), 4), "p_not_mentioned": round(p.get("not_mentioned", 0.0), 4)})
            a_found = d["found_stt"] or d["found_translate"]
            if d["scorable"] and (a_found != (trows[-1]["b"] == "mentioned")) and trows[-1]["b"] != "cannot_tell":
                disagree.setdefault(uid, []).append({"category": t.category, "names": t.names, "a_found": a_found, "b": trows[-1]["b"]})
        per.append({"consult_uid": uid, "ist_date": r["ist_date"], "language_heard": lang, "english": rs.is_english(lang), "text_source": source, "terms": trows})
        counts["scored"] += 1
    return {"schema": "refset.results.b.v1", "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "synonyms_sha256": syn_sha,
            "thresholds": {"mentioned_p": MENTIONED_P, "not_mentioned_p": NOT_MENTIONED_P}, "judge": {"configured": getattr(jev, "model", None), "reported": getattr(jev, "model_id", None)},
            "counts": dict(counts), "join_excluded": excluded, "per_consult": per, "aggregates": aggregates(per)}, disagree


def recall(rows, pick, cat):
    """Per-consult recall for one category: share of the consult's A-scorable terms for which pick(row) is true; consults without such terms are left out."""
    out = []
    for p in rows:
        ts = [t for t in p["terms"] if t["category"] == cat and t["a_scorable"]]
        if ts:
            out.append(sum(1 for t in ts if pick(t)) / len(ts))
    return out


def aggregates(per):
    A = {"recall": {}, "agreement_per_term": {}, "never_said_aloud": {}, "b_on_terms_a_cannot_score": {}}
    for name, sel in (("all", lambda p: True), ("english", lambda p: p["english"]), ("indian_language", lambda p: not p["english"])):
        rows = [p for p in per if sel(p)]
        A["recall"][name] = {"consults": len(rows), **{cat: {"matcher_a_either": rs.summ(recall(rows, lambda t: t["a_stt"] or t["a_translate"], cat)),
                                                              "matcher_b_mentioned": rs.summ(recall(rows, lambda t: t["b"] == "mentioned", cat)),
                                                              "matcher_b_not_cannot_tell_share": rs.summ(recall(rows, lambda t: t["b"] != "cannot_tell", cat))}
                                                       for cat in rs.CATEGORIES}}
    for cat in rs.CATEGORIES:
        ts = [t for p in per for t in p["terms"] if t["category"] == cat and t["a_scorable"]]
        c = collections.Counter()
        for t in ts:
            a = t["a_stt"] or t["a_translate"]
            c[("a" if a else "no_a") + "_" + t["b"]] += 1
        A["agreement_per_term"][cat] = {"terms": len(ts), "both_found": c["a_mentioned"], "a_only_b_not_mentioned": c["a_not_mentioned"], "a_only_b_cannot_tell": c["a_cannot_tell"],
                                        "b_only": c["no_a_mentioned"], "neither": c["no_a_not_mentioned"], "a_not_found_b_cannot_tell": c["no_a_cannot_tell"]}
        nm = sum(1 for t in ts if t["b"] == "not_mentioned")
        nm_a = sum(1 for t in ts if t["b"] == "not_mentioned" and not (t["a_stt"] or t["a_translate"] or t["a_router"]))
        A["never_said_aloud"][cat] = {"terms": len(ts), "b_not_mentioned": nm, "b_not_mentioned_and_a_not_found_anywhere": nm_a, "b_cannot_tell": sum(1 for t in ts if t["b"] == "cannot_tell"),
                                      "share_b_not_mentioned": round(nm / len(ts), 4) if ts else None,
                                      "share_both_say_absent": round(nm_a / len(ts), 4) if ts else None}
        un = [t for p in per for t in p["terms"] if t["category"] == cat and not t["a_scorable"]]
        A["b_on_terms_a_cannot_score"][cat] = {"terms": len(un), "b_mentioned": sum(1 for t in un if t["b"] == "mentioned"), "b_not_mentioned": sum(1 for t in un if t["b"] == "not_mentioned"),
                                               "b_cannot_tell": sum(1 for t in un if t["b"] == "cannot_tell")}
    return A


def table(R):
    A = R["aggregates"]
    L = ["# Reference set, matcher A vs matcher B (counts only)", "", f"counts {R['counts']}; judge {R['judge']}; thresholds {R['thresholds']}", ""]
    for sp, v in A["recall"].items():
        L += [f"## recall, {sp} ({v['consults']} consults): n / median / p10 / p90", "", "| category | A (either source) | B mentioned |", "|---|---|---|"]
        for cat in rs.CATEGORIES:
            f = lambda s: f"{s['n']} / {s['median']} / {s['p10']} / {s['p90']}"
            L.append(f"| {cat} | {f(v[cat]['matcher_a_either'])} | {f(v[cat]['matcher_b_mentioned'])} |")
        L.append("")
    L += ["## A/B agreement per term (A-scorable terms)", ""] + [f"- {c}: {v}" for c, v in A["agreement_per_term"].items()]
    L += ["", "## never said aloud, revised (B says not_mentioned)", ""] + [f"- {c}: {v}" for c, v in A["never_said_aloud"].items()]
    L += ["", "## B on terms matcher A cannot score", ""] + [f"- {c}: {v}" for c, v in A["b_on_terms_a_cannot_score"].items()]
    return "\n".join(L) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--record", required=True)
    ap.add_argument("--results", default=os.path.join(OUT, "REFSET-RESULTS.json"), help="matcher A's results: its selection.consult_uids are the consults to judge")
    ap.add_argument("--out", default=os.path.join(OUT, "REFSET-RESULTS-B.json"))
    ap.add_argument("--disagree", default=os.path.join(OUT, "REFSET-B-DISAGREE.json"))
    ap.add_argument("--root", default=rs.REB)
    ap.add_argument("--synonyms", default=rs.SYNONYMS_FILE)
    a = ap.parse_args(argv)
    ids = json.load(open(a.results))["selection"]["consult_uids"]
    records = rs.load_record_terms(a.record)
    lp = os.path.join(OUT, "jev-calls-8A-" + time.strftime("%Y%m%dT%H%M%S") + ".jsonl")
    logf = os.fdopen(os.open(lp, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "a")

    def log(meta):   # metadata only: status, latency, attempt, tokens. Never the state, the questions or the key.
        logf.write(json.dumps({"ts": time.strftime("%H:%M:%S"), "use": "8A-matcher-B", **meta}, sort_keys=True) + "\n")
        logf.flush()
    client = jev_client.JevClient(log=log)
    try:
        client.warm_up()
        R, dis = run_b(ids, records, client, root=a.root, synonyms=rs.load_synonyms(a.synonyms))
    finally:
        logf.close()
    st = client.stats
    lat = sorted(st["latency_s"])
    R["jev"] = {"requests": st["calls"], "ok": st["ok"], "retries": st["retries"], "errors": st["errors"], "input_tokens": st["input_tokens"], "output_tokens": st["output_tokens"],
                "latency_median_s": lat[len(lat) // 2] if lat else None, "latency_max_s": lat[-1] if lat else None, "call_log": lp}
    R["judge"] = {"configured": client.model, "reported": client.model_id}
    rs.write_private(a.out, json.dumps(R, indent=1, sort_keys=True))
    rs.write_private(os.path.splitext(a.out)[0] + ".md", table(R))
    rs.write_private(a.disagree, json.dumps(dis, indent=1, sort_keys=True))
    print(json.dumps({"out": a.out, "counts": R["counts"], "jev": R["jev"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
