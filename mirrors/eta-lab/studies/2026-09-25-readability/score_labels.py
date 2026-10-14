"""score_labels.py: precision and recall of the readability flag from HUMAN labels (ruling 337c; PREREG-337c.md + addendum 1 + addendum 2). Pure logic here; the CLI joins the label files to the frozen keys.

INPUTS: sample200_ids.json (strata sizes and rows), the box-only key sample200_key_v2.json (n -> id, cell, flagged), surg-page's key.json (L### -> the sheet's id), and one labels file per rater {L###: label}.
LABELS: readable | romanised_readable | garbled | wrong_language | unsure.
TRUE POSITIVE (a flagged row correctly flagged) = garbled or wrong_language. readable and romanised_readable are FALSE positives (the line would be hidden from a reader who could read it). unsure is excluded and bounded both ways.
UNFLAGGED rows: a MISS = garbled or wrong_language.
TWO RATERS (addendum 2): the PRIMARY label of a row is the rater's label when both agree; a disagreement becomes unsure (and is counted); each rater is also scored alone. Agreement is reported as raw share and Cohen's kappa over the five labels.
PER CELL (precision first): flagged rows labelled, TP, precision with the exact Clopper-Pearson interval, romanised_readable share, unsure count and the two bounds (unsure counted as TP / as false positive), miss rate among unflagged.
FLOOR (addendum 1, item 4): a cell may collapse lines by default only if it has >= 10 labelled non-unsure flagged rows, precision >= 0.80 AND romanised_readable <= 0.20 of them.
OVERALL (frozen estimator, cell sizes F_c flagged and U_c unflagged from stratum_sizes): precision = sum F_c*prec_c / sum F_c; recall = sum F_c*prec_c / (sum F_c*prec_c + sum U_c*miss_c). Counts and rates only; no text.
ADDENDUM 3 (after eta-refuter #2030; before any label): (1) the overall precision and recall are NEVER printed alone: each carries (a) PROPAGATED Clopper-Pearson bounds (per-cell lower/upper bounds pushed through the formulas: conservative, not a joint 95 %) and (b) a stratified
JEFFREYS-posterior 95 % interval (addendum 3b: the plain bootstrap collapses to a point at 0 or n events, so each stratum rate is drawn from Beta(bad+0.5, n-bad+0.5); 2,000 draws, seed BOOT_SEED = 20260937). QUOTE (a) FIRST. Only 94 of 39,387 unflagged segments are labelled, so recall is wide by construction. (2) COVERED SHARES: the share of sum F over cells that have >= 1 labelled
flagged row, and of sum U over cells with >= 1 labelled unflagged row, are printed next to the overall figures (a cell with no labelled rows drops out of the weights). (3) TWO RATERS: a row labelled by only ONE of the two raters becomes `unsure` and is counted (`labelled_by_one_rater_only`). (4) A label that is not one of the five (a typo) is ignored and COUNTED (`unknown_labels`).
`run()` asserts that the key's ids, cells and flags equal the frozen sample rows."""
import collections, json, os, sys


def load(path):
    with open(path) as f:
        return json.load(f)

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "2026-09-25-discarded-speech"))
import discarded_logic as DL

LABELS = ("readable", "romanised_readable", "garbled", "wrong_language", "unsure")
BAD = ("garbled", "wrong_language")
MIN_N, PREC_FLOOR, ROM_MAX = 10, 0.80, 0.20


def combine(rater_labels):
    """rater_labels: [{row: label}] -> ({row: primary label}, n_disagreements, n_one_rater_only). One rater: their labels. Two: agreement, else unsure; a row labelled by only ONE rater is unsure."""
    if len(rater_labels) == 1:
        return dict(rater_labels[0]), 0, 0
    a, b = rater_labels[0], rater_labels[1]
    out, dis, one = {}, 0, 0
    for k in set(a) | set(b):
        if k in a and k in b:
            if a[k] == b[k]:
                out[k] = a[k]
            else:
                out[k] = "unsure"; dis += 1
        else:
            out[k] = "unsure"; one += 1
    return out, dis, one


def kappa(a, b):
    ks = [k for k in a if k in b]
    if not ks:
        return None
    n = len(ks)
    po = sum(a[k] == b[k] for k in ks) / n
    ca, cb = collections.Counter(a[k] for k in ks), collections.Counter(b[k] for k in ks)
    pe = sum(ca[l] * cb[l] for l in LABELS) / (n * n)
    return None if pe == 1 else round((po - pe) / (1 - pe), 3)


BOOT_N, BOOT_SEED = 2000, 20260937                 # BOOT_N is now the number of posterior draws (addendum 3b)


def _overall(cell_stats, sizes):
    """cell_stats: {cell: (prec or None, miss or None)} -> (precision, recall) by the frozen estimator."""
    num = den_f = miss_w = 0.0
    for cell, (prec, miss) in cell_stats.items():
        F, U = sizes.get(f"{cell}|flagged", 0), sizes.get(f"{cell}|unflagged", 0)
        if prec is not None:
            num += F * prec; den_f += F
        if miss is not None:
            miss_w += U * miss
    return (num / den_f if den_f else None), (num / (num + miss_w) if (num + miss_w) > 0 else None)


def _posterior(rows, labels, sizes):
    """Stratified JEFFREYS-posterior interval (addendum 3b): each cell x flagged stratum's rate is drawn from Beta(bad + 0.5, n - bad + 0.5), the draws pushed through the frozen estimator, 95 % percentile
    interval of overall precision and recall. Unlike a percentile bootstrap it has width at 0 or n events (a stratum with 0 misses in n rows would resample 0 misses every time)."""
    import random
    strata = collections.defaultdict(lambda: [0, 0])
    for r in rows:
        lab = labels.get(r["id"])
        if lab in LABELS and lab != "unsure":
            st = strata[(r["cell"], bool(r["flagged"]))]
            st[0] += lab in BAD
            st[1] += 1
    rng = random.Random(BOOT_SEED)
    ps, rs = [], []
    for _ in range(BOOT_N):
        st = {}
        for (cell, fl), (bad, n) in sorted(strata.items()):
            st.setdefault(cell, [None, None])[0 if fl else 1] = rng.betavariate(bad + 0.5, n - bad + 0.5)
        p, r = _overall({c: tuple(v) for c, v in st.items()}, sizes)
        if p is not None: ps.append(p)
        if r is not None: rs.append(r)
    def pct(xs, q):
        xs = sorted(xs); return None if not xs else round(xs[min(len(xs) - 1, max(0, int(q * len(xs))))], 3)
    return dict(precision=[pct(ps, 0.025), pct(ps, 0.975)], recall=[pct(rs, 0.025), pct(rs, 0.975)], draws=BOOT_N, seed=BOOT_SEED, method="stratified Jeffreys posterior")


def score(rows, labels, sizes):
    """rows: [{id, cell, flagged}] (the sample); labels: {id: label}; sizes: {'cell|flagged': N, 'cell|unflagged': N} -> per-cell table + overall (with intervals and covered shares)."""
    cells = collections.defaultdict(lambda: dict(f=collections.Counter(), u=collections.Counter()))
    unknown = 0
    for r in rows:
        lab = labels.get(r["id"])
        if lab in LABELS:
            cells[r["cell"]]["f" if r["flagged"] else "u"][lab] += 1
        elif lab is not None:
            unknown += 1
    table, num, den_f, miss_w = {}, 0.0, 0.0, 0.0
    lo_stats, hi_stats = {}, {}
    for cell in sorted(cells):
        f, u = cells[cell]["f"], cells[cell]["u"]
        nf = sum(v for k, v in f.items() if k != "unsure")
        tp = sum(f[k] for k in BAD)
        prec = tp / nf if nf else None
        ci = DL.clopper_pearson(tp, nf) if nf else None
        nu = sum(v for k, v in u.items() if k != "unsure")
        miss = sum(u[k] for k in BAD) / nu if nu else None
        rom = f["romanised_readable"] / nf if nf else None
        floor = bool(nf >= MIN_N and prec is not None and prec >= PREC_FLOOR and rom is not None and rom <= ROM_MAX)
        miss_ci = DL.clopper_pearson(sum(u[k] for k in BAD), nu) if nu else None
        lo_stats[cell] = (ci[0] if ci else None, miss_ci[0] if miss_ci else None)         # lower precision, lower miss
        hi_stats[cell] = (ci[1] if ci else None, miss_ci[1] if miss_ci else None)         # upper precision, upper miss
        table[cell] = dict(miss_ci95=miss_ci, flagged_labelled=nf, tp=tp, precision=None if prec is None else round(prec, 3), precision_ci95=ci, romanised_readable_share=None if rom is None else round(rom, 3),
                           flagged_unsure=f["unsure"], precision_if_unsure_all_tp=round((tp + f["unsure"]) / (nf + f["unsure"]), 3) if nf + f["unsure"] else None,
                           precision_if_unsure_all_fp=round(tp / (nf + f["unsure"]), 3) if nf + f["unsure"] else None, unflagged_labelled=nu,
                           miss_rate_unflagged=None if miss is None else round(miss, 3), unflagged_unsure=u["unsure"], passes_collapse_floor=floor,
                           label_counts_flagged=dict(f), label_counts_unflagged=dict(u))
        F, U = sizes.get(f"{cell}|flagged", 0), sizes.get(f"{cell}|unflagged", 0)
        if prec is not None:
            num += F * prec; den_f += F
        if miss is not None:
            miss_w += U * miss
    p_lo, _ = _overall({c: (lo_stats[c][0], hi_stats[c][1]) for c in lo_stats}, sizes)              # lowest precision with the highest miss rate
    _, r_lo = _overall({c: (lo_stats[c][0], hi_stats[c][1]) for c in lo_stats}, sizes)
    p_hi, _ = _overall({c: (hi_stats[c][0], lo_stats[c][1]) for c in hi_stats}, sizes)
    _, r_hi = _overall({c: (hi_stats[c][0], lo_stats[c][1]) for c in hi_stats}, sizes)
    sumF = sum(v for k, v in sizes.items() if k.endswith("|flagged"))
    sumU = sum(v for k, v in sizes.items() if k.endswith("|unflagged"))
    covF = sum(sizes.get(f"{c}|flagged", 0) for c, t in table.items() if t["flagged_labelled"])
    covU = sum(sizes.get(f"{c}|unflagged", 0) for c, t in table.items() if t["unflagged_labelled"])
    r3 = lambda x: None if x is None else round(x, 3)
    overall = dict(precision=round(num / den_f, 3) if den_f else None, recall=round(num / (num + miss_w), 3) if (num + miss_w) > 0 else None,
                   propagated_cp_bounds=dict(precision=[r3(p_lo), r3(p_hi)], recall=[r3(r_lo), r3(r_hi)], note="per-cell 95 % bounds pushed through the estimator: conservative, not a joint 95 %"),
                   posterior95=_posterior(rows, labels, sizes), covered_share_of_flagged=round(covF / sumF, 3) if sumF else None,
                   covered_share_of_unflagged=round(covU / sumU, 3) if sumU else None, unknown_labels=unknown)
    return dict(cells=table, overall=overall)


def run(ids_path, key_path, surg_key_path, rater_paths):
    sample = load(ids_path)
    key = load(key_path)["key"]                              # n -> {id, cell, flagged, engine}
    rows = [dict(id=v["id"], cell=v["cell"], flagged=v["flagged"]) for v in key.values()]
    want = sorted((r["id"], r["cell"], bool(r["flagged"])) for r in sample["rows"])
    if sorted((r["id"], r["cell"], bool(r["flagged"])) for r in rows) != want:
        raise SystemExit("the key's ids, cells and flags do not equal the frozen sample rows: refusing to score")
    surg = load(surg_key_path)                               # L### -> sheet id   (shape: {L001: id} or {L001: {"id": id}})
    surg = {k: (v["id"] if isinstance(v, dict) else v) for k, v in surg.items()}
    raters = []
    for p in rater_paths:
        d = load(p)
        raters.append({surg[k]: (v["a"] if isinstance(v, dict) else v) for k, v in d.items() if k in surg})
    unknown_by_rater = [sum(1 for v in r.values() if v not in LABELS) for r in raters]              # counted BEFORE combining (a typo in one file would otherwise look like a disagreement)
    primary, dis, one = combine(raters)
    res = dict(n_rows=len(rows), raters=len(raters), primary=score(rows, primary, sample["stratum_sizes"]), disagreements_made_unsure=dis, labelled_by_one_rater_only=one, unknown_labels_by_rater=unknown_by_rater,
               per_rater=[score(rows, r, sample["stratum_sizes"]) for r in raters] if len(raters) > 1 else None,
               agreement=None if len(raters) < 2 else dict(raw=round(sum(raters[0][k] == raters[1][k] for k in raters[0] if k in raters[1]) / max(1, len([k for k in raters[0] if k in raters[1]])), 3), kappa=kappa(raters[0], raters[1])))
    return res


def main(argv):
    res = run(argv[0], argv[1], argv[2], argv[4:])
    fd = os.open(argv[3], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(res, indent=1) + "\n")
    print(json.dumps(res["primary"]["overall"]), "| cells passing the floor:", [c for c, v in res["primary"]["cells"].items() if v["passes_collapse_floor"]])


if __name__ == "__main__":
    main(sys.argv[1:])
