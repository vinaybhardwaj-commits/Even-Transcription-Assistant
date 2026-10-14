#!/usr/bin/env python3
"""337c(2) scoring of the blind before/after labels, exactly per PREREG-337c-rerun.md + addenda 1-3. Reads the PRIVATE key + counts and the rater label exports
({P###: label}); prints counts and shares only, never text.
  score_ba.py --key ba_v1/key.json --counts ba_v1/counts.json --labels vinay=labels_vinay.json [--labels sandhya=labels_sandhya.json] [--drop-flagged]
Order of the report: identical-pair position bias FIRST (per rater), then per cell: n, the five label counts mapped to old/re-run, D, N_ne, e, E, shares, Wilson 95% bounds, verdict.
Rules: D = old_better + rerun_better; E = round(N_ne * e / (1-e)) empties counted OLD better, N_ne = labelled non-empty rows except `unsure`; re-run share = R/(D+E),
old share = (O+E)/(D+E); RE-RUN PREFERRED needs re-run share >= 0.60 AND old share <= 0.20 AND Wilson lower bound of re-run share > 0.5 AND e <= 0.15 (else 'provisional, not preferred');
OLD PREFERRED = old share >= 0.40 (provisional if D+E < 20); a cell needs >= 10 decided rows else 'not enough labels'; neither_readable >= 40 % of a cell => 'audio-limited'.
--drop-flagged removes rows whose re-run is a recurring stock string (>= 3x) or text on near-silence (key flags) for the sensitivity report."""
import argparse, collections, glob, json, math, os, sys
ap = argparse.ArgumentParser(); ap.add_argument("--key", required=True); ap.add_argument("--counts", required=True)
ap.add_argument("--labels", action="append", required=True); ap.add_argument("--drop-flagged", action="store_true"); a = ap.parse_args()
key = json.load(open(a.key)); counts = json.load(open(a.counts))
LABELS = ("A_better", "B_better", "same", "neither_readable", "unsure")
ROWKEYS = {f"P{int(k):03d}": k for k in key}
# weights for the pooled line: each cell's share of the CUT segments (the 5,130 population), from the manifests (ids/counts only)
W = collections.Counter()
for f in glob.glob(os.path.join(os.path.dirname(os.path.abspath(a.key)), "..", "s?", "manifest.jsonl")):
    for l in open(f):
        fl = json.loads(l).get("force_lang"); W[fl if fl in ("kn", "hi", "bn", "ta", "ml") else ("other" if fl else "none")] += 1
def load_labels(rater, path):
    lab = json.load(open(path)); bad_keys = [k for k in lab if k not in ROWKEYS]; bad_vals = {k: v for k, v in lab.items() if v not in LABELS}
    print(f"=== rater {rater}: {len(lab)} labels; matched {len(lab) - len(bad_keys)}, UNMATCHED keys {len(bad_keys)}; unknown values {len(bad_vals)} (of {len(ROWKEYS)} rows)")
    if bad_keys or bad_vals:
        print(f"REFUSED: exported keys must be P001..P106 and values one of {LABELS}; unmatched sample {bad_keys[:3]}, unknown values {collections.Counter(bad_vals.values()).most_common(3)}"); sys.exit(2)
    return lab
def wilson(k, n, z=1.96):
    if n == 0: return (None, None)
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n); h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)
def cellname(v): return v["cell"].replace("identical:", "")
ALL = []
for spec in a.labels:
    rater, path = spec.split("=", 1); lab = load_labels(rater, path); ALL.append((rater, lab))
    if len(ALL) == 1:
        print(f"primary complete: {len(lab)}/{len(ROWKEYS)}")
        if len(lab) < len(ROWKEYS):
            print("REFUSED: the primary rater must have labelled all rows (addendum 4); no verdict is quoted from a partial primary."); sys.exit(3)
    # identical-pair position bias
    ident = [(k, lab[f"P{int(k):03d}"]) for k, v in key.items() if v["identical"] and f"P{int(k):03d}" in lab]
    biased = sum(1 for _, l in ident if l in ("A_better", "B_better"))
    print(f"identical controls: {len(ident)} labelled, chose A/B better on {biased} ({round(biased / len(ident), 2) if ident else None}); tolerance 0.20 -> {'POSITION-BIASED' if ident and biased / len(ident) > 0.20 else 'ok'}")
    cells = collections.defaultdict(collections.Counter)
    for k, v in key.items():
        if v["identical"]: continue
        l = lab.get(f"P{int(k):03d}")
        if l is None: continue
        if a.drop_flagged and ((v.get("recur") or 0) >= 3 or v.get("near_silence_text")): continue
        if l in ("A_better", "B_better"): l = "old_better" if (l == "A_better") == (v["old_side"] == "A") else "rerun_better"
        cells[cellname(v)][l] += 1
    pooled = {}
    for cell, c in sorted(cells.items()):
        n = sum(c.values()); R, O = c["rerun_better"], c["old_better"]; D = R + O
        emp = counts["rerun_empty_by_cell"].get(cell, {"empty": 0, "seen": 1}); e = emp["empty"] / max(1, emp["seen"])
        n_ne = n - c["unsure"]; E = round(n_ne * e / (1 - e)) if e < 1 else 0
        rs = R / (D + E) if D + E else None; os_ = (O + E) / (D + E) if D + E else None
        lo, hi = wilson(R, D + E)
        if D < 10: verdict = "not enough labels"
        elif c["neither_readable"] / n >= 0.40: verdict = "audio-limited"
        elif rs >= 0.60 and os_ <= 0.20 and lo > 0.5 and e <= 0.15: verdict = "RE-RUN PREFERRED"
        elif rs >= 0.60 and os_ <= 0.20: verdict = "provisional, not preferred (" + ("empty rate > 15%" if e > 0.15 else "Wilson lower bound <= 0.5") + ")"
        elif os_ >= 0.40: verdict = "OLD PREFERRED" + (" (provisional, D+E < 20)" if D + E < 20 else "")
        else: verdict = "annotate-only (side by side)"
        f = lambda x: None if x is None else round(x, 2)
        pooled[cell] = (rs, os_)
        print(f"{cell}: n {n} | rerun_better {R} old_better {O} same {c['same']} neither {c['neither_readable']} unsure {c['unsure']} | D {D} N_ne {n_ne} e {round(e, 2)} E {E} | rerun share {f(rs)} [Wilson {f(lo)}-{f(hi)}] old share {f(os_)} | {verdict}")

    # POOLED, after the cells (prereg): weighted by each cell's share of the cut segments; cells with no decided rows/E are left out and the weights renormalised
    ok = {c: v for c, v in pooled.items() if v[0] is not None and W[c]}
    if not W: print("POOLED: no manifests found (looked for <key dir>/../s?/manifest.jsonl); pooled line NOT computed")
    if ok:
        tw = sum(W[c] for c in ok)
        print("POOLED (weight = cell share of cut segments; cells used: " + ",".join(sorted(ok)) + f"): rerun share {round(sum(W[c] * v[0] for c, v in ok.items()) / tw, 2)} old share {round(sum(W[c] * v[1] for c, v in ok.items()) / tw, 2)}; descriptive, no verdict")
# TWO RATERS (addendum 4): the FIRST --labels rater is primary (the verdicts above for that rater are the ones quoted); every further rater is a check: raw agreement and Cohen's kappa on rows both labelled
if len(ALL) > 1:
    (r1, l1), (r2, l2) = ALL[0], ALL[1]; both = [k for k in l1 if k in l2]
    if both:
        po = sum(1 for k in both if l1[k] == l2[k]) / len(both)
        c1 = collections.Counter(l1[k] for k in both); c2 = collections.Counter(l2[k] for k in both)
        pe = sum(c1[x] * c2[x] for x in LABELS) / (len(both) ** 2); kappa = (po - pe) / (1 - pe) if pe < 1 else None
        print(f"AGREEMENT {r1} vs {r2}: rows both labelled {len(both)}, raw agreement {round(po, 2)}, Cohen kappa {None if kappa is None else round(kappa, 2)} (primary rater = {r1})")
