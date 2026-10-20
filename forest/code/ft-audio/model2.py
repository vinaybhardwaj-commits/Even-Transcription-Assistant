# ft-audio FT4 v2: same RF/CV/permutation/bootstrap as model.py, parameterised by label and model sets (refute fixes: payer and val_change out of
# the primary sets for < 60% fill; f07 with/without; f07 standalone with CI). usage: model2.py <features.parquet> <label col> <out_json> [min_age_days]
import sys, json
import numpy as np, pandas as pd
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss
import model as M
M.SPEC_MAP.update({'Dermatology': 'other', 'Gynaecology': 'other'})
SETS = {
    'audio_f07': ['specialty', 'doc_prior_rate', 'age_y', 'consult_lang', 'doc_talk_share', 'pat_valence', 'jev_pitch_score'],
    'audio_nof07': ['specialty', 'doc_prior_rate', 'age_y', 'consult_lang', 'doc_talk_share', 'pat_valence', 'jev_pitch_nof07'],
    'pulse_only': ['specialty', 'doc_prior_rate', 'age_y'],
    'audio8_old (payer, val_change; sensitivity)': ['specialty', 'doc_prior_rate', 'age_y', 'payer', 'consult_lang', 'doc_talk_share', 'val_change', 'jev_pitch_score'],
}
if __name__ == '__main__':
    path, lab, out = sys.argv[1:4]; min_age = int(sys.argv[4]) if len(sys.argv) > 4 else None
    df = pd.read_parquet(path)
    if 'jev_pitch_nof07' not in df: df['jev_pitch_nof07'] = df[['jev_f03', 'jev_f18']].mean(axis=1)
    df = df[df[lab].notna()]
    if min_age is not None: df = df[df.age_days >= min_age]
    df = df.reset_index(drop=True); d = M.prep(df)
    y = d[lab].astype(int).values; groups = d.cluster_key.fillna(d.consult_uid).values
    res = dict(label=lab, min_age=min_age, n=len(d), positives=int(y.sum()), patients=int(pd.Series(groups).nunique()), doctors=int(d.doctor_uid.nunique()), models={})
    sc = {}
    for name, feats in SETS.items():
        r = M.run(d, feats, y, groups); sc[name] = r['score']; ci, nb = M.boot_auc(y, r['score'], groups)
        res['models'][name] = dict(features=feats, auc=float(roc_auc_score(y, r['score'])), auc_ci95=ci, auc_rep_range=[float(min(r['aucs'])), float(max(r['aucs']))],
            pr_auc=float(average_precision_score(y, r['score'])), brier=float(brier_score_loss(y, r['score'])),
            perm=[dict(feature=f, mean=float(np.mean(v)), lo=float(np.percentile(v, 2.5)), hi=float(np.percentile(v, 97.5))) for f, v in sorted(r['drops'].items(), key=lambda kv: -np.mean(kv[1]))])
        print(name, round(res['models'][name]['auc'], 3), [round(x, 3) for x in ci], flush=True)
    for a in ('audio_f07', 'audio_nof07'):
        dci, nb = M.boot_auc(y, sc[a], groups, sc['pulse_only'], seed=1)
        res[f'{a}_minus_pulse'] = dict(delta=float(roc_auc_score(y, sc[a]) - roc_auc_score(y, sc['pulse_only'])), ci95=dci)
    sf = {}
    for f in ['jev_f07', 'jev_f03', 'jev_f18', 'jev_pitch_score', 'jev_pitch_nof07', 'doc_prior_rate', 'doc_talk_share', 'pat_valence', 'val_change', 'turns_per_min', 'age_y']:
        x = pd.to_numeric(d[f], errors='coerce'); m = x.notna().values
        if m.sum() > 5 and y[m].min() != y[m].max():
            ci, _ = M.boot_auc(y[m], x[m].values, groups[m])
            sf[f] = dict(n=int(m.sum()), pos=int(y[m].sum()), auc=float(roc_auc_score(y[m], x[m])), ci95=ci)
    res['single_feature_auc'] = sf
    json.dump(res, open(out, 'w'), indent=1)
