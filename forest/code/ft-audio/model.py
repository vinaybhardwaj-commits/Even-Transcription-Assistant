# ft-audio FT4 step 2: small random forest on recorded consults (H14). DIRECTIONAL. Repeated stratified group 5-fold x 10 (group = patient cluster).
# AUC on pooled out-of-fold predictions per repeat; 95% CI = patient-cluster bootstrap of the repeat-averaged OOF score; permutation importance = AUC drop
# when a raw feature is permuted inside the test folds (5 perms x 10 repeats), 2.5-97.5 percentiles. Pulse-only model on the same consults and splits.
# usage: model.py <features.parquet> <out_json>
import sys, json, warnings
import numpy as np, pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss
warnings.filterwarnings('ignore')
REPS, K, NPERM, NBOOT = 10, 5, 5, 2000
SPEC_MAP = {'General Surgery': 'GS', 'Orthopaedics': 'Ortho', 'Urology': 'Uro', 'Gastroenterology': 'Gastro', 'Gastroentrology Medical': 'Gastro',
            'Cardiology Interventional': 'Cardio', 'Cardiology Non Interventional': 'Cardio'}
MODELS = {
    'audio8': ['specialty', 'doc_prior_rate', 'age_y', 'payer', 'consult_lang', 'doc_talk_share', 'val_change', 'jev_pitch_score'],
    'pulse_only': ['specialty', 'doc_prior_rate', 'age_y', 'payer'],
    'audio_jev_items': ['doc_prior_rate', 'consult_lang', 'doc_talk_share', 'val_change', 'jev_f03', 'jev_f07', 'jev_f18'],
}
CAT = {'specialty', 'payer', 'consult_lang'}


def prep(df):
    d = df.copy()
    d['specialty'] = d.specialty.map(SPEC_MAP).fillna('other')
    d['consult_lang'] = d.consult_lang.map({'en-IN': 'en', 'kn-IN': 'kn', 'hi-IN': 'hi'}).fillna('other')
    d['payer'] = d.payer.fillna('missing') if 'payer' in d else 'missing'
    return d


def design(d, feats):
    """raw feature list -> numeric matrix; one-hot for categoricals, NaN -> median + missing flag. Column -> raw feature map for permutation."""
    cols, owner = [], []
    for f in feats:
        if f in CAT:
            for lv in sorted(d[f].astype(str).unique()):
                cols.append((d[f].astype(str) == lv).astype(float).rename(f'{f}={lv}')); owner.append(f)
        else:
            x = pd.to_numeric(d[f], errors='coerce').astype(float)
            if x.isna().any():
                cols.append(x.isna().astype(float).rename(f'{f}_missing')); owner.append(f)
            cols.append(x.rename(f)); owner.append(f)
    return pd.concat(cols, axis=1), owner


def fit_pred(Xtr, ytr, Xte, seed):
    med = Xtr.median(); Xtr = Xtr.fillna(med).fillna(0); Xte = Xte.fillna(med).fillna(0)
    m = RandomForestClassifier(n_estimators=500, max_depth=3, min_samples_leaf=3, max_features='sqrt', class_weight='balanced_subsample',
                               random_state=seed, n_jobs=4).fit(Xtr, ytr)
    m.n_jobs = 1
    return m, Xte


def run(d, feats, y, groups):
    raw = d[feats].copy(); X, owner = design(d, feats)
    oof = np.zeros((REPS, len(d))); aucs = []; drops = {f: [] for f in feats}
    for rep in range(REPS):
        cv = StratifiedGroupKFold(n_splits=K, shuffle=True, random_state=rep)
        fold_of = np.zeros(len(d), int); models = {}
        for k, (tr, te) in enumerate(cv.split(X, y, groups)):
            m, Xte = fit_pred(X.iloc[tr], y[tr], X.iloc[te], rep * 100 + k)
            oof[rep, te] = m.predict_proba(Xte)[:, 1]; fold_of[te] = k; models[k] = (m, tr, te)
        base = roc_auc_score(y, oof[rep]); aucs.append(base)
        rng = np.random.default_rng(rep)
        for f in feats:
            for _ in range(NPERM):
                dp = raw.copy(); p = oof[rep].copy()
                for k, (m, tr, te) in models.items():
                    dp.iloc[te, dp.columns.get_loc(f)] = dp.iloc[te][f].values[rng.permutation(len(te))]
                Xp, _ = design(pd.concat([d.drop(columns=feats), dp], axis=1), feats)
                Xp = Xp.reindex(columns=X.columns, fill_value=0.0)
                for k, (m, tr, te) in models.items():
                    med = X.iloc[tr].median()
                    p[te] = m.predict_proba(Xp.iloc[te].fillna(med).fillna(0))[:, 1]
                drops[f].append(base - roc_auc_score(y, p))
    score = oof.mean(0)
    return dict(aucs=aucs, score=score, drops=drops)


def boot_auc(y, s, groups, s2=None, seed=0):
    rng = np.random.default_rng(seed); ug = np.unique(groups); idx = {g: np.where(groups == g)[0] for g in ug}; out = []
    for _ in range(NBOOT):
        ii = np.concatenate([idx[g] for g in rng.choice(ug, len(ug))])
        if y[ii].min() == y[ii].max(): continue
        a = roc_auc_score(y[ii], s[ii]); out.append(a - roc_auc_score(y[ii], s2[ii]) if s2 is not None else a)
    return np.percentile(out, [2.5, 97.5]).tolist(), len(out)


if __name__ == '__main__':
    df = pd.read_parquet(sys.argv[1]); df = df[df.h14.notna()].reset_index(drop=True); d = prep(df)
    y = d.h14.astype(int).values; groups = d.cluster_key.fillna(d.consult_uid).values
    res = dict(n=int(len(d)), positives=int(y.sum()), patients=int(pd.Series(groups).nunique()), pos_patients=int(pd.Series(groups[y == 1]).nunique()),
               doctors=int(d.doctor_uid.nunique()), label_src=str(d.label_src.iloc[0]), models={})
    scores = {}
    for name, feats in MODELS.items():
        r = run(d, feats, y, groups); scores[name] = r['score']
        ci, nb = boot_auc(y, r['score'], groups)
        res['models'][name] = dict(features=feats, auc_oof_mean=float(np.mean(r['aucs'])), auc_rep_range=[float(min(r['aucs'])), float(max(r['aucs']))],
            auc_repavg=float(roc_auc_score(y, r['score'])), auc_ci95=ci, n_boot=nb,
            pr_auc=float(average_precision_score(y, r['score'])), brier=float(brier_score_loss(y, r['score'])),
            perm=[dict(feature=f, mean=float(np.mean(v)), lo=float(np.percentile(v, 2.5)), hi=float(np.percentile(v, 97.5))) for f, v in
                  sorted(r['drops'].items(), key=lambda kv: -np.mean(kv[1]))])
        print(name, 'AUC', round(res['models'][name]['auc_repavg'], 3), [round(x, 3) for x in ci], flush=True)
    dci, nb = boot_auc(y, scores['audio8'], groups, scores['pulse_only'], seed=1)
    res['audio8_minus_pulse'] = dict(delta=float(roc_auc_score(y, scores['audio8']) - roc_auc_score(y, scores['pulse_only'])), ci95=dci, n_boot=nb)
    # single-feature reads (no model): AUC of the raw value, orientation as is
    sf = {}
    for f in ['doc_prior_rate', 'doc_talk_share', 'val_change', 'jev_pitch_score', 'jev_f03', 'jev_f07', 'jev_f18', 'age_y', 'pat_valence', 'turns_per_min']:
        x = pd.to_numeric(d[f], errors='coerce'); m = x.notna().values
        if m.sum() > 5 and y[m].min() != y[m].max():
            sf[f] = dict(n=int(m.sum()), pos=int(y[m].sum()), auc=float(roc_auc_score(y[m], x[m])))
    res['single_feature_auc'] = sf
    json.dump(res, open(sys.argv[2], 'w'), indent=1)
    print(json.dumps({k: v for k, v in res.items() if k != 'models'}, indent=1))
