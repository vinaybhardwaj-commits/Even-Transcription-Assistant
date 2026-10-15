#!/usr/bin/env python3
"""RUN 3 (and RUN 1/2) report table. usage: fuserv1_run3_hit_table.py RUN.jsonl BASELINE.json [OUT.json]
Same code and same v0 baseline (eval/fuserv1_v0_baseline.py, computed in memory) for every run.
Three V7 columns, each computed by REPLAY over the stored record with validator.v7_replay:
  noV7  = the pre-V7 result (val["pre_v7"] when V7 forced a fallback, else val itself)
  built = V7 clinical as built (a dropped clause -> slice falls back)
  8a    = ADDENDUM-8a (a dropped clause = English omission, no fallback)
Rows per column: native RAW (fallback slice = EMPTY, as run), native COMPOSITE (fallback slice = v0 text),
English clauses raw. Plus v0 alone (ETR on / ETR off). Hit = S1 scorer drug+dose (ta/ml drug only).
Windows whose v0 ERRORED are "no baseline" (excluded, listed); computed-empty v0 ("") is scored.
DEV windows are one 30 s slice each so window v0 = slice v0 (asserted).
Also printed: outcome counts, replay(built)==live over ALL records (outcome + dropped-clause identities),
V7 drops per language/reason, collateral non-dose numbers, condition A (8a per-slice share of clauses
dropped, slices losing >=50%), condition B (clauses kept ONLY by 8a Change 2, per language, ta separate),
condition C (short-generic list, skipped short words), 'soap' drops, pre-pass number-parse features per
norm/copy item, and the lid-debug drug-candidate row.
FUSERV1 env var = the fuserv1 dir to import (default /tmp/wt-rf-8a/fuserv1)."""
import collections, json, os, re, subprocess, sys
FUSERV1 = os.environ.get("FUSERV1", "/tmp/wt-rf-8a/fuserv1")
sys.path.insert(0, "/tmp/wt-reb-a447dc36/kit"); sys.path.insert(0, "/tmp/wt-rf-s1-m6/kit/diag-rig")
sys.path.insert(0, FUSERV1)
import reb as reb_pkg, score, wavio, lexicon, number_parse as npm, prepass, validator as V
SUITE = "/home/eta/eta-data/diag-rig/stimuli/clinical1"
LEXP = "/home/eta/eta-data/cap2/rx_history.jsonl"
lex = lexicon.load_lexicon(LEXP); ridx = npm.build_reverse_index(2000)
# v2 (print-only): V2_OUT = fuserv2_dev_run.py JSONL; adds rows v2_D-any / v2_D-two (text incl. insert block)
V2 = {}
if os.environ.get("V2_OUT"):
    for _l in open(os.environ["V2_OUT"]):
        _r = json.loads(_l)
        if not _r.get("header"): V2.setdefault(_r["variant"], {})[_r["window_id"]] = _r["text"]
git = lambda d, *a: subprocess.check_output(["git", "-C", d, *a], text=True).strip()
print("scorer blob sha:", git("/tmp/wt-rf-s1-m6", "hash-object", "kit/diag-rig/score.py"), "worktree HEAD:", git("/tmp/wt-rf-s1-m6", "rev-parse", "HEAD"))
_dirty = git(FUSERV1, "status", "--porcelain").splitlines()
print("fuserv1 dir:", FUSERV1, "HEAD:", git(FUSERV1, "rev-parse", "HEAD"), "dirty lines:", len(_dirty))
if _dirty: sys.exit("REFUSING: fuserv1 checkout is dirty")
_d = git(FUSERV1, "diff", "--stat", "f9b6706e", "HEAD", "--", "fuserv1")
print("fuserv1/ diff vs witnessed f9b6706e:", repr(_d) if _d else "empty")
rows = [json.loads(l) for l in open(sys.argv[1])]
base = json.load(open(sys.argv[2]))
print("v0 baseline: fuser_v0 code", base["fuser_v0_code_sha"], "etr", base["etr_enabled"], "reb", base["reb_sha"], "windows", base["n_windows"],
      "nonempty", base["n_with_v0"], "empty(scored, 0 hits)", base["n_empty"], base["empty_windows"], "error(no baseline)", base["n_error"])
POL = ("noV7", "built", "8a")
def lang_of(wid):
    m = re.match(r"clin_([a-z]+(?:-en)?)_", wid)
    return m.group(1) if m else ("real" if wid.startswith("L") else "other")
def mat_text(pre):
    mat = pre.get("materialized") or {}
    return " ".join(mat[k] for k in sorted(mat, key=int))
def cl_text(clauses): return " ".join(c["text"] for c in clauses)
def counts(truth, truth_lang, text):
    it = score.clinical_items_score(truth["clinical_items"], text, truth_lang)
    if truth_lang in ("ta", "ml"):
        return it["drug"][0], it["drug"][1]
    return it["drug"][0] + it["dose"][0], it["drug"][1] + it["dose"][1]
tab = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0]))
outc = {p: collections.Counter() for p in POL}
replay_eq = replay_tot = 0; replay_bad = []
drops = collections.defaultdict(collections.Counter)      # per language: reason counts (built)
collateral = collections.Counter(); soap = 0
A_shares = []; A_lost50 = 0; A_n = 0; A_lang = collections.defaultdict(lambda: [0, 0])
B = collections.Counter(); skipped_short = 0
etr_diff = []; parse = collections.Counter(); dc_row = collections.Counter(); no_base = []; errored = []; n_scored = 0
EXCL = set(filter(None, os.environ.get("EXCLUDE_WINDOWS", "").split(",")))
print("EXCLUDE_WINDOWS (held-out, skipped before any content access):", sorted(EXCL) or "none")
for r in rows:
    if r["window_id"] in EXCL: continue
    if not r.get("ok"):
        errored.append(r["window_id"]); continue
    wid = r["window_id"]; L = lang_of(wid)
    sls = r["result"]["slices"]
    b = base["windows"].get(wid)
    scored = r["room_id"] == "suite-clinical1"
    if scored:
        assert len(sls) == 1, wid
        if b is None or b["v0_text"] is None: no_base.append(wid); scored = False
    if scored:
        n_scored += 1
        truth = wavio.jload(f"{SUITE}/{wid}.truth.json")
        langs = sorted({e["lang"] for e in truth["events"] if "lang" in e}); tl = langs[0] if len(langs) == 1 else "+".join(langs)
        cond = "clean" if truth["kind"] == "dialogue" else ("fan10" if truth.get("bed") == "fan" else "babble5")
    texts = collections.defaultdict(list)
    w = None
    for sl in sls:
        val = sl["validated"]; pre = val.get("pre_v7") or val
        rps = {"built": V.v7_replay(val, lex, ridx, "built"), "8a": V.v7_replay(val, lex, ridx, "8a")}
        # replay(built) == live: outcome AND dropped clause identities
        live_drop = [d["clause"]["text"] for d in val.get("v7_dropped_clauses", [])]
        rep_drop = [d["clause"]["text"] for d in rps["built"]["v7_dropped_clauses"]]
        replay_tot += 1
        if rps["built"]["outcome"] == val["outcome"] and live_drop == rep_drop: replay_eq += 1
        else: replay_bad.append(wid)
        oc = {"noV7": pre["outcome"], "built": rps["built"]["outcome"], "8a": rps["8a"]["outcome"]}
        for p in POL: outc[p][oc[p]] += 1
        for d in rps["built"]["v7_dropped_clauses"]:
            drops[L][d["reason"]] += 1
            if d["collateral_non_dose"]: collateral[L] += 1
        n_pre = rps["8a"]["n_clauses_pre"]; nd = len(rps["8a"]["v7_dropped_clauses"])
        for d in rps["8a"]["v7_dropped_clauses"]:
            if "soap" in d["unsupported_drugs"]: soap += 1
        if n_pre:
            A_n += 1; A_shares.append(nd / n_pre); A_lost50 += nd / n_pre >= 0.5; A_lang[L][0] += 1; A_lang[L][1] += nd / n_pre >= 0.5
        for o in rps["8a"]["only_indic"]: B[L] += 1
        skipped_short += rps["8a"]["skipped_short"]
        if scored:
            v0 = b["v0_text"]
            texts["v0"].append(v0); texts["v0_noetr"].append(b["v0_text_noetr"])
            for _v, _m in V2.items(): texts[f"v2_{_v}"].append(_m[wid])
            if v0 != b["v0_text_noetr"]:
                etr_diff.append((wid, tl, counts(truth, tl, v0), counts(truth, tl, b["v0_text_noetr"])))
            for p in POL:
                if oc[p] == "fallback":
                    raw, en = "", ""
                else:
                    raw = mat_text(pre)
                    en = cl_text(pre.get("en_clauses", []) if p == "noV7" else (rps["built"] if p == "built" else rps["8a"])["en_clauses"])
                texts[f"raw_{p}"].append(raw); texts[f"comp_{p}"].append(raw if oc[p] != "fallback" else v0)
                texts[f"en_{p}"].append(en)
        # pre-pass features (needs REB window)
        if w is None: w = reb_pkg.load_window(wid, ist_date=r["ist_date"], room_id=r["room_id"])
        pp = prepass.build_slice_prepass(w, sl["slice"], lex, ridx)
        tokid = {t["id"]: t["text"] for toks in pp["tokens"].values() for t in toks}
        idx_dropped = {d["index"] for d in pre["dropped_items"] if d.get("index") is not None}
        kept_idx = [i for i in range(len(pre.get("native_items", [])) + len(idx_dropped)) if i not in idx_dropped] if "native_items" in pre else []
        for it in pre.get("native_items", []):
            if it["kind"] not in ("copy", "norm"): continue
            txt = " ".join(tokid.get(x, "") for x in it["refs"])
            vals = {p["value"] for p in npm.parse_numbers(txt, ridx) if p["role"] == "value"} if txt.strip() else set()
            if it["kind"] == "copy":
                parse["copy_with_parsed_value" if vals else "copy_no_parse"] += 1
            else:
                wd = re.sub(r"[^\d]", "", it.get("w") or "")
                key = "norm_parse_confirms_w" if wd and int(wd) in vals else ("norm_parse_differs" if vals else "norm_no_parse")
                parse[key] += 1
        # lid-debug row: Indic-detected whisper-auto Latin token matched the lexicon >=0.9 but no forced-en token did
        auto = [t for t in pp["tokens"]["whisper-auto"] if t.get("lid_detected") not in (None, "en") and t["citable"]]
        fen = [t for t in pp["tokens"]["whisper-forced-en"] if t["citable"]]
        aset = V.v7_drug_names(" ".join(t["text"] for t in auto), lex); fset = V.v7_drug_names(" ".join(t["text"] for t in fen), lex)
        if aset - fset:
            dc_row["slices_with_auto_only_drug"] += 1
            dc_row["of_which_slice_had_items_dropped"] += bool(pre["dropped_items"])
    if scored:
        for name, ts in texts.items():
            f, t = counts(truth, tl, " ".join(ts))
            for key in ((tl, cond), (tl, "all"), ("all", cond), ("all", "all")):
                tab[key][name][0] += f; tab[key][name][1] += t
print(f"\nrecords in file: {len(rows)}; errored (excluded from every column): {len(errored)} {errored}; scored clinical1 windows: {n_scored}")
print("no-baseline (v0 error) windows excluded:", no_base)
print("outcomes per V7 column (all records, all slices):", {p: dict(outc[p]) for p in POL})
print(f"replay(built)==live (outcome + dropped-clause identities): {replay_eq}/{replay_tot}; mismatches: {replay_bad}")
print("V7 drops per language x reason (built):", {k: dict(v) for k, v in drops.items()}, "\ncollateral non-dose (built) per language:", dict(collateral))
print(f"A: slices with >=1 pre-V7 clause {A_n}; mean share dropped under 8a {sum(A_shares)/len(A_shares) if A_shares else None}; slices losing >=50%: {A_lost50}")
print("A per language [slices with clauses, slices losing >=50%]:", {k: v for k, v in sorted(A_lang.items())})
print("B: clauses kept ONLY by 8a Change 2, per language (ta separate):", dict(B))
print(f"C: short-generic list {sorted(V.V7_SHORT_GENERICS)}; skipped short Latin words (8a): {skipped_short}; 'soap' drops (8a): {soap}; lexicon sha256[:16] cd012faed4bc597a")
print("pre-pass number-parse features:", dict(parse))
print("lid-debug drug-candidate row:", dict(dc_row))
names = ["v0", "v0_noetr"] + [f"{k}_{p}" for p in POL for k in ("raw", "comp", "en")] + [f"v2_{v}" for v in sorted(V2)]
print(f"\n{'group':16s} {'n':>4s} " + " ".join(f"{n:>11s}" for n in names) + "   (hit %)")
out = {}
for key in sorted(tab):
    d = tab[key]; t = d["v0"][1]
    out["/".join(key)] = {n: d[n] for n in d}
    print(f"{'/'.join(key):16s} {t:4d} " + " ".join(f"{(round(100*d[n][0]/t,1) if t else None)!s:>11s}" for n in names))
ex = {n: [0, 0] for n in names}
for key in tab:
    if key[1] == "all" and key[0] not in ("all", "en"):
        for n in names: ex[n][0] += tab[key][n][0]; ex[n][1] += tab[key][n][1]
print(f"{'all-except-en':16s} {ex['v0'][1]:4d} " + " ".join(f"{(round(100*ex[n][0]/ex[n][1],1) if ex[n][1] else None)!s:>11s}" for n in names))
print(f"\nETR on vs off: windows with differing v0 text (scored): {len(etr_diff)}; windows where hits differ: {sum(1 for e in etr_diff if e[2] != e[3])}")
for wid, tl, on, off in etr_diff: print(f"  {wid:28s} {tl:8s} hits/total ETR-on {on[0]}/{on[1]}  ETR-off {off[0]}/{off[1]}")
if len(sys.argv) > 3:
    json.dump({"table": out, "outcomes": {p: dict(outc[p]) for p in POL}, "replay": [replay_eq, replay_tot, replay_bad],
               "drops": {k: dict(v) for k, v in drops.items()}, "B": dict(B), "parse": dict(parse), "dc_row": dict(dc_row),
               "A": [A_n, A_lost50], "skipped_short": skipped_short, "soap": soap}, open(sys.argv[3], "w"), indent=1)
