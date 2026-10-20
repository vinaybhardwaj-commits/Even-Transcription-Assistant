# ft-h1shot (20 Oct 2026): the one-shot sealed-H score of the frozen at-Rx model (FT-MODEL-SPEC-20OCT s8, design A, M0 and M1).
# Run: ~/.venv-forest/bin/python -I h1shot.py --dry      D-only rehearsal: fold 0 of StratifiedGroupKFold(5, shuffle, seed 0, groups =
#                                                         cluster_key) stands in for H; train on the other D rows; -> DRY-RESULT.md
#      ~/.venv-forest/bin/python -I h1shot.py --run-H    the single real run; refuses unless GO-H.txt exists and H_RUN.done does not;
#                                                         claims H_RUN.done atomically (O_EXCL) at start; -> H-RESULT.md (metrics only)
# Layer 0 = FT3 (code/ft3_features_split.py, a copy of ft-labels-base ft3_features.py with only the split filter and output made
# parameters), same-day payer excluded as in FT3. Layer 1 = FT8 (ft8-clinical ft8_build.build, unchanged, imported; the cohort and the
# pull paths are parameters here). M0 = layer 0; M1 = layers 0+1. RF(400, min_samples_leaf=5, max_features='sqrt', random_state=0).
# Doctor prior rate as FT3 (m = 10): inner GroupKFold(5) OOF for the training rows, the training-row rate for the target rows.
# H discipline: no H row, id or feature value is printed, logged or written anywhere except the 0600 sealed file
# SEALED_FILE (dir 0700). Exceptions in --run-H print only the exception type and line numbers. The only other H output is H-RESULT.md.
import argparse, contextlib, datetime as dt, glob, hashlib, io, json, os, re, runpy, sys, traceback, warnings
import numpy as np, pandas as pd, pyarrow.parquet as pq
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import StratifiedGroupKFold, GroupKFold
from sklearn.metrics import roc_auc_score, average_precision_score

H = os.path.expanduser
CODE = os.path.dirname(os.path.abspath(__file__))
FT3_COPY = f'{CODE}/ft3_features_split.py'
FT3_D = H('~/oc/forest-lead/ft/out/ft-labels-base/features_D.parquet'); FT3_D_COLS = H('~/oc/forest-lead/ft/out/ft-labels-base/features_D.cols.json')
LABELS = H('~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet'); LABELS_SHA = '0aefc00f425b'
FT8_CODE = H('~/oc/forest-lead/ft/out/ft8-clinical/code'); FT8_STATS = H('~/oc/forest-lead/ft/out/ft8-clinical/build_stats.json')
SPLIT_DIR = H('~/oc/forest-lead/ft/vendor_split'); LOCK_LIST_SHA = '52959278edd8'   # lock RD0-2026-10-18-52959278edd8
D_PULL_A_TS = H('~/eta-data/forest/ft8/ft8-pull-a.tsv'); D_PULL_A_DAY = H('~/eta-data/forest/ft8/ft8-pull-a-day.tsv')
D_PULL_B = H('~/eta-data/forest/ft8/ft8-pull-b.tsv')   # pull B (labs) is day-cut already: result_date < anchor date (age_d >= 1)
D_PULLS = {'timestamp': (D_PULL_A_TS, D_PULL_B), 'day': (D_PULL_A_DAY, D_PULL_B)}
SRC_RE = re.compile(r'^src_max_ts(_\w+)?$'); CUT_COL = 'cut_ist_midnight'   # gating-lead audit columns of the day pulls
TZ_RE = r'.*([+-]\d\d:\d\d|Z)$'
H_PULL_DIR = H('~/eta-data/forest/ft8/H')
H_PULL_A = f'{H_PULL_DIR}/ft8-pull-a.tsv'; H_PULL_B = f'{H_PULL_DIR}/ft8-pull-b.tsv'
OUTDIR = H('~/oc/forest-lead/ft/out/ft-h1shot')
SEALED_DIR = f'{OUTDIR}/sealed'; SEALED_FILE = f'{SEALED_DIR}/H_features.parquet'
DONE_FLAG = f'{OUTDIR}/H_RUN.done'
GO_FILE = H('~/wt/ft-h1shot/.bc/GO-H.txt')   # written by forest-lead after the refute; never created by this lane
H_SPLIT = 'H'                                # the target split of --run-H (tests point it at D to exercise the sealed path)
FT3_INPUTS = [H('~/oc/forest-lead/data/ft5a.tsv'), H('~/oc/forest-lead/data/ft3b.tsv'), H('~/oc/forest-lead/data/ft3c.tsv'),
              H('~/oc/forest-lead/data/ft3d.tsv'), H('~/eta-data/forest/split-input/10.tsv'),
              H('~/eta-data/forest/split/clusters-2026-10-18.tsv')] + sorted(glob.glob(H('~/wt/forest-funnel-join/.bc/out/f1-s5-*.tsv')))
LABS = ('h14', 'h90')                        # finality (h14 age >= 18 d, h90 age >= 94 d) is NaN in labels.parquet
RF_KW = dict(n_estimators=400, min_samples_leaf=5, max_features='sqrt', random_state=0)
DRY_SEED = 0; BOOT_SEED = 20261020; NB = 1000; EPS = 1e-4
EXPECTED_H = {'h14': (361, 82), 'h90': (224, 64)}   # spec s8 labelled H n / pos (refute fix 4: stated, never 'fixed' by a rerun)

sys.path.insert(0, FT8_CODE); sys.path.insert(0, SPLIT_DIR)
import ft8_build, split_guard


def sha12(p): return hashlib.sha256(open(p, 'rb').read()).hexdigest()[:12]
def now_ist(): return dt.datetime.now(dt.timezone(dt.timedelta(hours=5, minutes=30))).strftime('%Y-%m-%d %H:%M:%S IST')


class Refused(SystemExit):
    pass


# --- layer builders --------------------------------------------------------------------------------------------------------------
def ft3_layer(split):
    """FT3 copy with SPLIT=split, nothing written; its prints (counts, procedure mix) are discarded. The copy orders the ch_* columns
    by Python set iteration (string-hash seed of the process), so columns and avail are put in the canonical order of
    ft-labels-base features_D.parquet / features_D.cols.json (same set required): RF results depend on column order."""
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        g = runpy.run_path(FT3_COPY, init_globals={'SPLIT': split, 'OUT_DIR': None})
    L, avail = g['L'], list(g['avail'])
    order = pq.read_schema(FT3_D).names; cols = json.load(open(FT3_D_COLS))
    if set(L.columns) != set(order) or set(avail) != set(cols) or len(avail) != len(cols):
        raise RuntimeError('FT3 copy columns differ from features_D')
    return L[order], cols


def ft8_cohort(split, guard, labels_path=LABELS):
    """ft8_build.load_cohort with the split as a parameter: reads ONLY split==split rows (parquet filter), drops (and counts) rows
    whose cluster the split_guard does not map to that split."""
    C = pd.read_parquet(labels_path, filters=[('split', '==', split)])
    sets = C['cluster_key'].map(guard.set_of)
    st = {'n_labels': len(C), 'n_dropped_guard': int((sets != split).sum())}
    C = C[sets == split].copy()
    C['rx_date'] = pd.to_datetime(C['rx_date']).dt.normalize()
    return C.reset_index(drop=True), st


def ft8_layer(split, pull_a, pull_b, pull_cut, guard):
    C, st = ft8_cohort(split, guard)
    a, b = ft8_build.load_a_b(pull_a, pull_b)
    F, A, st2 = ft8_build.build(C, a, b, pull_cut=pull_cut)
    if pull_cut == 'day':
        ft8_build.assert_cutoff(A)              # as ft8_build.main: a day-level build aborts on any violation
    assert len(F) == len(C) and F.episode_id.is_unique
    return F, {**st, **{k: v for k, v in st2.items() if isinstance(v, (int, np.integer))}}


def read_pull(path, kind):
    """-> (pull without the audit columns, read as ft8_build.load_a_b reads it; audit columns + prescription_uid). Used by the cut
    check only; the builder gets the pulls from ft8_build.load_a_b, unchanged."""
    df = pd.read_csv(path, sep='\t', dtype=str) if kind == 'a' else pd.read_csv(path, sep='\t')
    audit = [c for c in df.columns if SRC_RE.match(c) or c == CUT_COL]
    return df.drop(columns=audit), df[['prescription_uid'] + audit].astype(str).where(df[['prescription_uid'] + audit].notna())


def ist_naive(v):
    return pd.to_datetime(v, errors='coerce', utc=True).dt.tz_convert('Asia/Kolkata').dt.tz_localize(None)


def pull_cut_of(a_path, b_path, split, labels_path=LABELS):
    """The cut level of a pair of pulls, from the data: 'day' when pull A carries src_max_ts* and cut_ist_midnight, cut_ist_midnight is
    the IST midnight of the anchor Rx day, every src_max_ts* is strictly before it, and every pull-B row has age_d >= 1 (and any
    src_max_ts* in B is before the anchor day); otherwise 'timestamp'. Returns (cut, counts). Raises Refused (counts only) when a
    pull row is not an anchor of this split, or a timestamp has no explicit offset or does not parse."""
    C = pd.read_parquet(labels_path, filters=[('split', '==', split)], columns=['prescription_uid', 'rx_date'])
    anchor = C.set_index('prescription_uid')['rx_date'].pipe(pd.to_datetime).dt.normalize()
    hard, late = {}, {}
    marked = False
    for kind, path in (('a', a_path), ('b', b_path)):
        pull, au = read_pull(path, kind)
        day = au['prescription_uid'].map(anchor)
        hard[f'{kind}:row_not_{split}_anchor'] = int(day.isna().sum())
        src = [c for c in au.columns if SRC_RE.match(c)]
        if kind == 'a':
            marked = bool(src) and CUT_COL in au.columns
        for c in src + ([CUT_COL] if CUT_COL in au.columns else []):
            v = au[c]; nn = v.notna()
            hard[f'{kind}:{c}:no_offset'] = int((nn & ~v.fillna('').str.match(TZ_RE)).sum())
            t = ist_naive(v)
            hard[f'{kind}:{c}:unparsed'] = int((nn & t.isna()).sum())
            if c == CUT_COL:
                late[f'{kind}:{c}:missing_or_not_anchor_midnight'] = int((~nn | (t != day)).sum())
            else:
                late[f'{kind}:{c}:on_or_after_anchor_day'] = int((nn & (t >= day)).sum())
        if kind == 'b':
            late['b:age_d_lt1'] = int((pd.to_numeric(pull['age_d'], errors='coerce') < 1).sum())
    hard = {k: v for k, v in hard.items() if v}
    if hard:
        raise Refused(f'REFUSED: {split} FT8 pulls fail the audit-column check: {hard}')
    if not marked:
        late['a:audit_columns_absent'] = 1
    late = {k: v for k, v in late.items() if v}
    return ('timestamp' if late else 'day'), late


def check_cuts(pull_cut, pulls_by_split):
    """Preflight (before any claim): the D features_ft8 build, the --pull-cut argument and every split's pulls use the same cut."""
    built = ft8_build_cut()
    if built != pull_cut:
        raise Refused(f'REFUSED: --pull-cut {pull_cut}, but the D features_ft8 build (build_stats.json) is {built}')
    out = {}
    for split, (a, b) in pulls_by_split.items():
        try:
            ft8_build.load_a_b(a, b)      # the builder's own column check, run here so a bad column cannot fail after the claim
        except ValueError as e:
            raise Refused(f'REFUSED: {split} FT8 pulls: {e}')   # message = column names only
        cut, why = pull_cut_of(a, b, split)
        if cut != pull_cut:
            raise Refused(f'REFUSED: {split} FT8 pulls are cut at {cut}, not {pull_cut} (counts: {why})')
        out[split] = cut
    return out


def build_layers(split, pull_a, pull_b, pull_cut, guard):
    """-> frame (labels + layer-0 + layer-1 columns), layer-0 columns (FT3 cols.json order, no same-day payer), layer-1 columns, counts."""
    L, avail = ft3_layer(split)
    F8, st = ft8_layer(split, pull_a, pull_b, pull_cut, guard)
    X = L.merge(F8, on='episode_id', how='left', validate='1:1', indicator=True)
    st['n_ft8_unmatched'] = int((X.pop('_merge') != 'both').sum())
    if st['n_ft8_unmatched']:
        raise RuntimeError(f"{st['n_ft8_unmatched']} layer-0 rows have no FT8 row")
    bad = int((X.cluster_key.map(guard.set_of) != split).sum())
    if bad:
        raise RuntimeError(f'{bad} rows do not map to split {split} under split_guard')
    st['n_rows'] = len(X)
    cols0 = [c for c in avail if c != 'payer']   # same-day payer is leaky: excluded exactly as ft3_model (PAYER != 1)
    cols1 = cols0 + [c for c in F8.columns if c.startswith('ft8_')]
    return X.reset_index(drop=True), cols0, cols1, st


# --- learner (ft3_model.py doc_rate / Enc / fit_predict; random_state 0) ---------------------------------------------------------
def doc_rate(tr_doc, tr_y, ap_doc, m=10):
    g = pd.DataFrame({'d': tr_doc, 'y': tr_y}).groupby('d').y.agg(['sum', 'count']); p = tr_y.mean()
    r = ((g['sum'] + m * p) / (g['count'] + m)).to_dict(); v = g['count'].to_dict()
    return np.array([r.get(d, p) for d in ap_doc]), np.array([v.get(d, 0) for d in ap_doc])


class Enc:
    def __init__(self, cols, Xtr):
        self.cat = [c for c in cols if Xtr[c].dtype == object and c != 'doctor_id']
        self.num = [c for c in cols if c not in self.cat + ['doctor_id']]

    def fit(self, X):
        self.levels = {c: [l for l, n in X[c].value_counts().items() if n >= 10] for c in self.cat}; return self

    def tf(self, X, dr, dv):
        out = [X[self.num].astype(float).fillna(-1).values]
        for c in self.cat:
            for l in self.levels[c]: out.append((X[c] == l).values[:, None].astype(float))
        out += [dr[:, None], dv[:, None]]
        return np.hstack(out)


def fit_predict(cols, Xtr, ytr, gtr, Xte):
    drt = np.zeros(len(Xtr)); dvt = np.zeros(len(Xtr))
    for a, b in GroupKFold(5).split(Xtr, ytr, gtr):
        drt[b], dvt[b] = doc_rate(Xtr.doctor_id.values[a], ytr[a], Xtr.doctor_id.values[b])
    dre, dve = doc_rate(Xtr.doctor_id.values, ytr, Xte.doctor_id.values)
    enc = Enc(cols, Xtr).fit(Xtr)
    rf = RandomForestClassifier(n_jobs=10, **RF_KW).fit(enc.tf(Xtr, drt, dvt), ytr)
    return rf.predict_proba(enc.tf(Xte, dre, dve))[:, 1]


# --- metrics (calibration as ft-bench calib.py: logit clip 1e-4, unpenalised LR of y on logit(p), no-skill = prev*(1-prev)) -------
def logit(p): p = np.clip(np.asarray(p, float), EPS, 1 - EPS); return np.log(p / (1 - p))


def calib_lr(x, y):
    X = np.column_stack([np.ones(len(x)), x]); b = np.zeros(2)
    for _ in range(100):
        q = 1 / (1 + np.exp(-(X @ b))); W = q * (1 - q); Hm = X.T @ (X * W[:, None]); gr = X.T @ (y - q)
        try: st = np.linalg.solve(Hm, gr)
        except np.linalg.LinAlgError: break
        b += st
        if np.max(np.abs(st)) < 1e-10: break
    return float(b[0]), float(b[1])


def point(y, p):
    prev = float(y.mean()); a, s = calib_lr(logit(p), y)
    return dict(n=int(len(y)), pos=int(y.sum()), base_rate=prev, auc=float(roc_auc_score(y, p)),
                prauc=float(average_precision_score(y, p)), brier=float(np.mean((p - y) ** 2)), noskill_brier=prev * (1 - prev),
                calib_slope=s, calib_intercept=a)


def delta_boot(y, p0, p1, g, nb=NB, seed=BOOT_SEED):
    rng = np.random.default_rng(seed); ug = np.unique(g); idx = {k: np.where(g == k)[0] for k in ug}; d = []; skipped = 0
    for _ in range(nb):
        s = np.concatenate([idx[k] for k in rng.choice(ug, len(ug))])
        if not 0 < y[s].sum() < len(s): skipped += 1; continue
        d.append(roc_auc_score(y[s], p1[s]) - roc_auc_score(y[s], p0[s]))
    d = np.array(d); lo, hi = np.percentile(d, [2.5, 97.5]); lo2, hi2 = np.percentile(d, [1.25, 98.75])
    return dict(delta=float(roc_auc_score(y, p1) - roc_auc_score(y, p0)), lo=float(lo), hi=float(hi), lo975=float(lo2), hi975=float(hi2),
                p_le0=float(np.mean(d <= 0)), draws=int(len(d)), skipped=skipped, n_clusters=int(len(ug)))


def score(train, target, cols0, cols1):
    R = {}
    for lab in LABS:
        tr = train[train[lab].notna()].reset_index(drop=True); te = target[target[lab].notna()].reset_index(drop=True)
        ytr = tr[lab].values.astype(int); yte = te[lab].values.astype(int); g = tr.cluster_key.values
        p0 = fit_predict(cols0, tr, ytr, g, te); p1 = fit_predict(cols1, tr, ytr, g, te)
        R[lab] = dict(train_n=int(len(tr)), train_pos=int(ytr.sum()), M0=point(yte, p0), M1=point(yte, p1),
                      delta=delta_boot(yte, p0, p1, te.cluster_key.values))
    return R


# --- reporting -------------------------------------------------------------------------------------------------------------------
def holm_reading(R):
    """Pre-declared F-H rule (spec s9, Holm over 2; refute fix 3): order h14 / h90 by P(delta <= 0) (ties: h14 first). The first is
    a gain only if its 97.5% CI lies above 0; the second only if the first was a gain AND its 95% CI lies above 0. Else no gain shown."""
    order = sorted(R, key=lambda lab: (R[lab]['delta']['p_le0'], LABS.index(lab)))
    out, go = {}, True
    for k, lab in enumerate(order):
        d = R[lab]['delta']; lo = d['lo975'] if k == 0 else d['lo']
        go = go and lo > 0
        out[lab] = (k + 1, '97.5%' if k == 0 else '95%', lo, 'GAIN SHOWN' if go else 'no gain shown')
    return out


def render(title, R, meta):
    f = lambda v: f'{v:.3f}'
    out = [f'# {title}', '', f"Written {meta['finished']} by ft-h1shot h1shot.py (started {meta['started']}). Metrics only.", '',
           '| label | model | train n / pos | target n / pos | base rate | AUC | PR-AUC | Brier | no-skill Brier | calib slope | calib intercept |',
           '|---|---|---|---|---|---|---|---|---|---|---|']
    for lab, r in R.items():
        for m in ('M0', 'M1'):
            x = r[m]
            out.append(f"| {lab} | {m} | {r['train_n']} / {r['train_pos']} | {x['n']} / {x['pos']} | {f(x['base_rate'])} | {f(x['auc'])} | "
                       f"{f(x['prauc'])} | {f(x['brier'])} | {f(x['noskill_brier'])} | {f(x['calib_slope'])} | {f(x['calib_intercept'])} |")
    out += ['', f'Delta AUC M1 - M0: cluster bootstrap over target clusters, {NB} draws, seed {BOOT_SEED}, percentile 95% CI.', '',
            '| label | delta AUC | 95% CI | 97.5% CI | P(delta <= 0) | draws used / skipped | clusters |', '|---|---|---|---|---|---|---|']
    for lab, r in R.items():
        d = r['delta']
        out.append(f"| {lab} | {d['delta']:+.3f} | [{d['lo']:+.3f}, {d['hi']:+.3f}] | [{d['lo975']:+.3f}, {d['hi975']:+.3f}] | {d['p_le0']:.3f} | "
                   f"{d['draws']} / {d['skipped']} | {d['n_clusters']} |")
    out += ['', 'Reading rule (pre-declared, Holm over the 2 F-H tests): order h14 / h90 by P(delta <= 0); the first is a gain only if its '
            '97.5% CI lies above 0; the second only if the first is a gain and its 95% CI lies above 0; otherwise "no gain shown".', '',
            '| Holm step | label | CI used | CI lower bound | reading |', '|---|---|---|---|---|']
    for lab, (k, ci, lo, v) in sorted(holm_reading(R).items(), key=lambda t: t[1][0]):
        out.append(f'| {k} | {lab} | {ci} | {lo:+.3f} | {v} |')
    out += ['', '## Run record', ''] + [f'- {k}: {v}' for k, v in meta.items() if k not in ('started', 'finished')]
    return '\n'.join(out) + '\n'


def input_shas(pulls):
    files = {'labels.parquet': LABELS, 'features_D.parquet (column order)': FT3_D, 'features_D.cols.json': FT3_D_COLS, 'ft3_features_split.py': FT3_COPY, 'h1shot.py': os.path.abspath(__file__),
             'ft8_build.py': f'{FT8_CODE}/ft8_build.py', 'icd_map.py': f'{FT8_CODE}/icd_map.py', 'split_guard.py': f'{SPLIT_DIR}/split_guard.py'}
    files.update({os.path.basename(p): p for p in FT3_INPUTS})
    files.update(pulls)
    return ', '.join(f'{k} {sha12(p)}' for k, p in files.items())


def preflight(pulls):
    missing = [p for p in [LABELS, FT3_COPY, FT3_D, FT3_D_COLS, FT8_STATS] + FT3_INPUTS + list(pulls.values()) if not os.path.exists(p)]
    if missing:
        raise Refused(f'REFUSED: missing input file(s): {missing}')
    if sha12(LABELS) != LABELS_SHA:
        raise Refused(f'REFUSED: labels.parquet sha is not {LABELS_SHA}')
    if not split_guard.PINNED_LIST_SHA256.startswith(LOCK_LIST_SHA):
        raise Refused(f'REFUSED: split_guard pin is not lock {LOCK_LIST_SHA}')


def ft8_build_cut():
    return json.load(open(FT8_STATS))['pull_cut']   # the cut level of the refuted D features_ft8.parquet build


# --- modes -----------------------------------------------------------------------------------------------------------------------
def run_dry(pull_cut):
    started = now_ist()
    da, db = D_PULLS[pull_cut]
    pulls = {f'D {os.path.basename(da)}': da, f'D {os.path.basename(db)}': db}
    preflight(pulls)
    cuts = check_cuts(pull_cut, {'D': (da, db)})
    guard = split_guard.load()
    X, cols0, cols1, st = build_layers('D', da, db, pull_cut, guard)
    strata = X.h14.fillna(-1).astype(int).astype(str) + '|' + X.h90.fillna(-1).astype(int).astype(str)
    _, te = next(StratifiedGroupKFold(5, shuffle=True, random_state=DRY_SEED).split(X, strata, X.cluster_key))
    m = np.zeros(len(X), bool); m[te] = True
    R = score(X[~m].reset_index(drop=True), X[m].reset_index(drop=True), cols0, cols1)
    meta = dict(started=started, finished=now_ist(), mode='--dry (fold 0 of StratifiedGroupKFold(5, shuffle=True, random_state=0) on '
                'all D episodes, strata = h14 x h90 status, groups = cluster_key, stands in for H)',
                rows=f"D {st['n_rows']} (stand-in {int(m.sum())}, train {int((~m).sum())})", pull_cut=f'{pull_cut} (checked: {cuts})',
                ft8_counts=json.dumps({k: v for k, v in st.items() if k != 'n_rows'}, default=int),
                layer0_cols=f'{len(cols0)} ({", ".join(cols0)}) + doctor_rate, doctor_vol', layer1_cols=f'{len(cols1) - len(cols0)} ft8_*',
                learner=f'RandomForestClassifier({RF_KW})', inputs=input_shas(pulls))
    os.makedirs(OUTDIR, exist_ok=True)
    p = f'{OUTDIR}/DRY-RESULT.md'
    with open(os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as fh:
        fh.write(render('ft-h1shot DRY run (D only; one D fold stands in for H)', R, meta))
    os.chmod(p, 0o600)
    print('dry done:', p)
    print(json.dumps({lab: {'M0_auc': round(r['M0']['auc'], 3), 'M1_auc': round(r['M1']['auc'], 3),
                            'delta': round(r['delta']['delta'], 3)} for lab, r in R.items()}))


def claim_shot():
    """Atomic test-and-set: O_CREAT|O_EXCL fails if the flag exists, so two runs can never both pass."""
    try:
        fd = os.open(DONE_FLAG, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise Refused(f'REFUSED: {DONE_FLAG} exists: H has already been scored (or a run is in progress)')
    os.write(fd, f'H run claimed {now_ist()} pid {os.getpid()}\n'.encode()); os.close(fd)


def mark(msg):
    with open(DONE_FLAG, 'a') as fh: fh.write(f'{msg} {now_ist()}\n')


def tb_lines(e):
    return ' > '.join(f'{os.path.basename(fr.filename)}:{fr.lineno}' for fr in traceback.extract_tb(e.__traceback__))


def run_H(pull_cut):
    if os.path.exists(DONE_FLAG):
        raise Refused(f'REFUSED: {DONE_FLAG} exists: H has already been scored (or a run is in progress)')
    if not os.path.exists(GO_FILE):
        raise Refused(f'REFUSED: {GO_FILE} does not exist (forest-lead writes it after the refute)')
    da, db = D_PULLS[pull_cut]
    pulls = {f'D {os.path.basename(da)}': da, f'D {os.path.basename(db)}': db, 'H ft8-pull-a.tsv': H_PULL_A, 'H ft8-pull-b.tsv': H_PULL_B}
    if not (os.path.isfile(H_PULL_A) and os.path.isfile(H_PULL_B)):
        raise Refused(f'REFUSED: FT8 H pulls missing: need {H_PULL_A} and {H_PULL_B} (gating-lead day-level pulls A and B for the H anchors)')
    os.umask(0o077); warnings.simplefilter('ignore')
    # PRE-CLAIM (refute fixes 1, 2): every check and the whole in-memory build of both layers, D and H (incl. ft8_build.assert_cutoff
    # and the column check), happen here. Any failure refuses WITHOUT the flag; a non-Refused error prints only type + file:line.
    try:
        preflight(pulls)
        check_cuts(pull_cut, {'D': (da, db), H_SPLIT: (H_PULL_A, H_PULL_B)})
        built = _build_H(pull_cut)
    except Refused:
        raise
    except BaseException as e:
        raise Refused(f'REFUSED before the claim (shot NOT used): {type(e).__name__} at {tb_lines(e)} '
                      '(message suppressed: it may contain H data)')
    claim_shot()
    started = now_ist()
    try:
        _run_H_body(built, pull_cut, pulls, started)
    except BaseException as e:
        mark(f'FAILED {type(e).__name__} at {tb_lines(e)}')
        print(f'H run FAILED: {type(e).__name__} at {tb_lines(e)} (message suppressed: it may contain H data)', file=sys.stderr)
        raise SystemExit(1)
    mark('finished ok')
    print(f'H run finished: {OUTDIR}/H-RESULT.md')


def _build_H(pull_cut):
    """Both layers for D (train) and H (target), in memory only; nothing is written."""
    guard = split_guard.load()
    D, cols0, cols1, _ = build_layers('D', *D_PULLS[pull_cut], pull_cut, guard)
    T, t0, t1, _ = build_layers(H_SPLIT, H_PULL_A, H_PULL_B, pull_cut, guard)
    if t0 != cols0 or t1 != cols1:
        raise RuntimeError('H feature columns differ from D')
    return D, T, cols0, cols1


def _run_H_body(built, pull_cut, pulls, started):
    """After the claim: seal the H features, score exactly what is sealed, write H-RESULT.md."""
    D, T, cols0, cols1 = built
    os.makedirs(SEALED_DIR, mode=0o700, exist_ok=True); os.chmod(SEALED_DIR, 0o700)
    T.to_parquet(SEALED_FILE, index=False); os.chmod(SEALED_FILE, 0o600)
    del T, built
    T = pd.read_parquet(SEALED_FILE)
    R = score(D, T, cols0, cols1)
    vs = '; '.join(f"{lab} {R[lab]['M0']['n']}/{R[lab]['M0']['pos']} (spec {e[0]}/{e[1]}: "
                   f"{'match' if (R[lab]['M0']['n'], R[lab]['M0']['pos']) == e else 'DIFFERS, stated here, not rerun'})"
                   for lab, e in EXPECTED_H.items())
    meta = dict(started=started, finished=now_ist(), mode=f'--run-H (single run; target split {H_SPLIT}; train = all labelled D)',
                h_counts_vs_spec_s8=vs,
                pull_cut=pull_cut, layer0_cols=f'{len(cols0)} + doctor_rate, doctor_vol', layer1_cols=f'{len(cols1) - len(cols0)} ft8_*',
                learner=f'RandomForestClassifier({RF_KW})', sealed=f'{SEALED_FILE} (0600, dir 0700; not opened by hand)',
                inputs=input_shas(pulls))
    p = f'{OUTDIR}/H-RESULT.md'
    with open(os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as fh:
        fh.write(render('ft-h1shot H RESULT (sealed H split, scored once)', R, meta))


def main(argv=None):
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--dry', action='store_true'); g.add_argument('--run-H', dest='run_h', action='store_true')
    ap.add_argument('--pull-cut', choices=['timestamp', 'day'], required=True,
                    help='FT8 pull cut level, the same for D and H; must equal the D features_ft8 build and the cut found in every pull')
    ns = ap.parse_args(argv)
    pull_cut = ns.pull_cut
    if ns.run_h:
        run_H(pull_cut)
    else:
        run_dry(pull_cut)


if __name__ == '__main__':
    main()
