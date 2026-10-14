#!/usr/bin/env python3
"""PARITY-389 Mini-vs-HF comparison, points (a) router output and (c) raw whisper, exactly as PARITY-389.md.
Reads <io>/{mini,hf}/{router,whisper}/ and <io>/.window-audio/manifest.json. Prints/writes COUNTS, decisions, timings,
probability differences and edit rates ONLY: no text is ever printed or written (Levenshtein runs in memory).
The post-guard leg (b) is NOT here: it needs the reviewed a92ebae TS harness. No threshold is invented: the plan's are
+-0.5 s boundaries, identical counts/decisions/language/engine, edit rate listed above 5%, no_speech_prob within 0.02 of a
drop threshold (THRESH below is a parameter, default None = not computed)."""
import argparse, hashlib, json, os, sys

BOUND_S = 0.5; EDIT_LIST = 0.05

def lev(a, b):
    if a == b: return 0
    if not a: return len(b)
    if not b: return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]

MISSING = object()

def need(d, k):
    """KEY ABSENCE, never a diff by itself (herdr-kit #4829a, correcting refuter-2 B1's overreach):
    a field 100% concordantly absent on BOTH sides across every engine (checked on real data: 'refused'
    is absent from every router segment, every engine, both sides, always) is the stacks' real identical
    shape, not hidden information. present_or_missing() below reports which side has the key; callers
    flag a diff only when PRESENCE DIFFERS or a present value differs, never on concordant absence.
    audio_sha256/probe_audio_sha256/probe_language keep the old strict rule (main(), unchanged): those
    are provenance fields the run always populates in practice, so 'absent' there means a real capture
    defect, not a schema shape - herdr-kit's ruling leaves that path as-is."""
    return d.get(k, MISSING) if isinstance(d, dict) else MISSING

def present_or_missing(a, b, f):
    """Returns ('both', va, vb) | ('mismatch', which side has it) | ('neither', None, None)."""
    pa, pb = need(a, f) is not MISSING, need(b, f) is not MISSING
    if pa and pb: return "both", a.get(f), b.get(f)
    if pa != pb: return "mismatch", ("mini" if pa else "hf")
    return "neither", None, None

def load(p):
    return json.load(open(p)) if os.path.exists(p) else None

def rep_metrics(segs):
    """top identical-segment count, longest consecutive identical run, longest in-segment 1-3 word phrase repeat (numbers only)"""
    texts = [(s.get("text") or "").strip().lower() for s in segs]
    top = max((texts.count(t) for t in set(texts) if t), default=0)
    run = best = 0; last = None
    for t in texts:
        run = run + 1 if (t and t == last) else 1
        best = max(best, run) if t else best; last = t
    phrase = 0
    for t in texts:
        w = t.split()
        for n in (1, 2, 3):
            grams = {}
            for i in range(len(w) - n + 1):
                g = tuple(w[i:i + n]); grams[g] = grams.get(g, 0) + 1
            phrase = max(phrase, max(grams.values(), default=0))
    return [top, best, phrase]

def router_cmp(m, h):
    r = {"diff": []}
    rm, rh = (m or {}).get("result"), (h or {}).get("result")
    if not isinstance(rm, dict) or not isinstance(rh, dict) or need(rm, "status") is MISSING or need(rh, "status") is MISSING or not isinstance(rm.get("segments"), list) or not isinstance(rh.get("segments"), list):
        r["diff"].append("missing_field"); r.update(boundary_misses=None, edit_rate=None, n_seg=None); return r
    if rm["status"] != rh["status"]: r["diff"].append("status")
    sm, sh = rm["segments"], rh["segments"]
    if len(sm) != len(sh): r["diff"].append("segment_count")
    n = min(len(sm), len(sh)); miss = 0
    for i in range(n):
        a, b = sm[i], sh[i]
        # start_s/end_s are always-required timing fields: a presence MISMATCH here (one side lacks a
        # timestamp the other has) is treated the same as any other field mismatch below, never silently
        # skipped - but concordant absence (neither side has it, which does not occur in real data but
        # would be a genuine "can't compare" case) is reported once, not per-field-per-segment noise.
        pres_bad = False
        for f in ("start_s", "end_s"):
            kind, *_ = present_or_missing(a, b, f)
            if kind != "both":
                pres_bad = True
                if "missing_field" not in r["diff"]: r["diff"].append("missing_field")
        if pres_bad: continue
        if abs(a["start_s"] - b["start_s"]) > BOUND_S or abs(a["end_s"] - b["end_s"]) > BOUND_S: miss += 1
        for f, name in (("refused", "refused_flag"), ("refused_reason", "refused_reason"), ("lang", "lang"), ("engine", "engine")):
            kind = present_or_missing(a, b, f)[0]
            if kind == "mismatch" and name not in r["diff"]: r["diff"].append(name + "_presence")
            elif kind == "both" and a.get(f) != b.get(f) and name not in r["diff"]: r["diff"].append(name)
            # kind == "neither" (concordant absence, e.g. 'refused' on every real segment): not a diff.
    r["boundary_misses"] = miss
    if miss: r["diff"].append("boundary")
    if rep_metrics(sm) != rep_metrics(sh): r["diff"].append("repetition_metrics")
    tm = "\n".join((s.get("text") or "") for s in sm); th = "\n".join((s.get("text") or "") for s in sh)
    r["edit_rate"] = (1.0 if th else 0.0) if not tm else (0.0 if tm == th else lev(tm, th) / len(tm))
    r["n_seg"] = [len(sm), len(sh)]
    return r

def pct(v, p):
    v = sorted(v)
    return None if not v else v[min(len(v) - 1, int(round(p * (len(v) - 1))))]

def align_by_start(sm, sh, bound):
    """Greedy nearest-start alignment with a drift guard (herdr-kit #4829b): a raw index zip past even a
    1-segment count mismatch misaligns every later pair and reports near-100% 'boundary miss' on windows
    that are actually near-identical (measured: a 343-vs-342 window showed 342/342 'miss' while its
    nsp_diff on the true aligned prefix was ~1e-8, i.e. float noise). Walks both lists by start_s order
    (already sorted, real data); a pair within `bound` seconds is matched and both advance; otherwise the
    earlier-starting side is assumed to hold an extra segment and only it advances (a real split/merge,
    not a mismatch of every later pair). Returns (matched pairs, unmatched_mini count, unmatched_hf count)."""
    i = j = 0; matched = []
    while i < len(sm) and j < len(sh):
        da, db = sm[i].get("start", 0.0), sh[j].get("start", 0.0)
        if abs(da - db) <= bound: matched.append((i, j)); i += 1; j += 1
        elif da < db: i += 1  # sm holds a segment sh doesn't (a split); it never joins `matched`
        else: j += 1          # sh holds a segment sm doesn't
    # unmatched = every segment not part of a matched pair, wherever the skip happened (not just the tail)
    return matched, len(sm) - len(matched), len(sh) - len(matched)

def whisper_cmp(m, h, kind, thresh):
    if m is None or h is None: return {"diff": ["missing"]}
    r = {"diff": []}
    if not isinstance(m.get("segments"), list) or not isinstance(h.get("segments"), list) or need(m, "language") is MISSING or need(h, "language") is MISSING:
        return {"diff": ["missing_field"]}
    sm, sh = m["segments"], h["segments"]
    if len(sm) != len(sh): r["diff"].append("segment_count")
    if m["language"] != h["language"]: r["diff"].append("language")
    matched, unmatched_mini, unmatched_hf = align_by_start(sm, sh, BOUND_S)
    miss = 0; dp = []; near = 0; absent = False
    for i, j in matched:
        a, b = sm[i], sh[j]
        if any(need(x, f) is MISSING for x in (a, b) for f in ("start", "end", "no_speech_prob")): absent = True; continue
        if abs(a["start"] - b["start"]) > BOUND_S or abs(a["end"] - b["end"]) > BOUND_S: miss += 1
        dp.append(abs(a["no_speech_prob"] - b["no_speech_prob"]))
        if thresh is not None and (abs(a["no_speech_prob"] - thresh) <= 0.02 or abs(b["no_speech_prob"] - thresh) <= 0.02): near += 1
    if absent: r["diff"].append("missing_field")
    if miss: r["diff"].append("boundary")
    if unmatched_mini or unmatched_hf: r["diff"].append("unaligned_segments")
    r.update(boundary_misses=miss, aligned_pairs=len(matched), unmatched_mini=unmatched_mini, unmatched_hf=unmatched_hf,
              nsp_diff_max=max(dp, default=None), nsp_diff_p95=pct(dp, 0.95), near_threshold=near, n_seg=[len(sm), len(sh)])
    return r

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--io", required=True); ap.add_argument("--golden", required=True); ap.add_argument("--manifest", required=True)
    ap.add_argument("--ship-manifest-sha16", default="3f4a9ac7aa9b0b3d")
    ap.add_argument("--golden-sha", default="d7964897189dba9d6dc78390a2c9e26269ad75e560173ef05b49f26710b408d1")
    ap.add_argument("--manifest-sha", default="c85d1e6ec0a3ab5caa3f9f1e5abb2bf7242ea399d5819257bdd02bf80bb79bf0"); ap.add_argument("--nsp-threshold", type=float, default=None)
    ap.add_argument("--out", default=None)
    a = ap.parse_args(argv)
    ship = os.path.join(a.io, ".window-audio", "manifest.json")
    if hashlib.sha256(open(ship, "rb").read()).hexdigest()[:16] != a.ship_manifest_sha16:
        print("REFUSED: ship manifest sha mismatch"); return 2
    for path, want, name in ((a.golden, a.golden_sha, "golden"), (a.manifest, a.manifest_sha, "stt manifest")):
        if hashlib.sha256(open(path, "rb").read()).hexdigest() != want:
            print("REFUSED: %s sha mismatch" % name); return 2
    shipm = json.load(open(ship))
    g = json.load(open(a.golden)); strata = {w["window_id"]: s for s, ws in g["windows"].items() for w in ws}
    names = set(json.load(open(a.manifest))["router"]["eta_env_names_exact"]["live_process_names"])
    res, tally = {}, {}
    for wid, st in sorted(strata.items()):
        row = {"stratum": st, "diff": []}
        mm = load(f"{a.io}/mini/router/{wid}.meta.json"); hm = load(f"{a.io}/hf/router/{wid}.meta.json")
        if mm is None or hm is None: row["diff"].append("missing_capture")
        else:
            se = shipm.get(wid) or {}
            for f, sf in (("audio_sha256", "audio_sha256"), ("probe_audio_sha256", "probe_audio_sha256")):
                if not se.get(sf) or mm.get(f) != se.get(sf) or hm.get(f) != se.get(sf): row["diff"].append(f + "_VOID")
            pm, ph = mm.get("probe_language"), hm.get("probe_language")
            if not pm or not ph: row["diff"].append("probe_language_missing")
            elif pm != ph: row["diff"].append("probe_language")
            if set(hm.get("eta_env_names") or []) != names: row["diff"].append("hf_env_names")
            if set(mm.get("eta_env_names") or []) != names: row["diff"].append("mini_env_names")
            rr = router_cmp(load(f"{a.io}/mini/router/{wid}.json"), load(f"{a.io}/hf/router/{wid}.json"))
            row["router"] = rr; row["diff"] += ["router:" + d for d in rr["diff"]]
            for k in ("probe", "full"):
                wc = whisper_cmp(load(f"{a.io}/mini/whisper/{wid}.{k}.json"), load(f"{a.io}/hf/whisper/{wid}.{k}.json"), k, a.nsp_threshold)
                row["whisper_" + k] = wc; row["diff"] += [f"whisper_{k}:" + d for d in wc["diff"]]
        row["pass"] = not row["diff"]
        res[wid] = row; t = tally.setdefault(st, {"windows": 0, "equal": 0, "edit_gt_5pct": 0})
        t["windows"] += 1; t["equal"] += row["pass"]
        er = (row.get("router") or {}).get("edit_rate")
        if er is not None and er > EDIT_LIST: t["edit_gt_5pct"] += 1
    if any("missing_capture" in r["diff"] for r in res.values()): verdict = "NOT COMPUTABLE (capture missing on a side)"
    else: verdict = "MATCH" if all(r["pass"] for r in res.values()) and len(res) == 48 else "NO MATCH"
    out = {"verdict_router_and_whisper_only": verdict, "post_guard_leg": "NOT RUN (needs reviewed a92ebae harness)", "per_stratum": tally, "windows": res}
    if a.out: json.dump(out, open(a.out, "w"), indent=1); os.chmod(a.out, 0o600)
    print(json.dumps({"verdict_router_and_whisper_only": verdict, "post_guard_leg": out["post_guard_leg"], "per_stratum": tally}))
    return 0 if verdict == "MATCH" else 1

if __name__ == "__main__": sys.exit(main())
