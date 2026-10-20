# ft-forest sensitivities + nested in-fold sigmoid (forest-lead 09:32, spec s4/s6/s7). Reported, not tested. Writes ONLY to out/ft-forest/sens/.
# Usage: forest_sens.py <design> <lab> <kind>
#   kind rawtags  : raw Haiku tags (tags_D.jsonl, rl-feat tags.jsonl, bolna_raw_*) in layer 3            (B)
#        rolefree : role-free audio only (role-specific engine columns dropped)                          (A, B, C)
#        wavlm    : FULL + separate WavLM embeddings, 3 in-fold PCA components per role                 (A, B, C)
#        l8raw    : layer 8 = the unscreened Opus score (proxy-inflated)                                  (A, B, C)
#        platt    : nested in-fold sigmoid (inner GroupKFold(3) on the training folds only) for FULL (B, C) or M0, M1 (A)
# FULL - L0 only. L0 has the same columns, folds and seed as the final run, so its OOF is read from the final model_frozen file (asserted equal ids/y).
import os, sys, json, time, argparse
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, os.path.expanduser('~/wt/ft-bench/code'))
import warnings; warnings.simplefilter('ignore')
import numpy as np, pandas as pd
from sklearn.decomposition import PCA
from sklearn.model_selection import GroupKFold
from sklearn.metrics import roc_auc_score
import forest_lib as FL, forest_build as FB
import calib

H = os.path.expanduser; FIN = H('~/oc/forest-lead/ft/out/ft-forest'); SENS = f'{FIN}/sens'
ROLES = {'calls': ('patient', 'counsellor', 'all'), 'consults': ('patient', 'doctor', 'all')}


def add_embeddings(Dz):
    """Append raw 1024-d per-role WavLM embeddings as emb_<role>_<i> columns (NaN where absent). Same masking as the engine layers:
    no eligible call before T, or ruling-4 rows -> missing (the file's patient/counsellor rows are already role-masked by ft-engines)."""
    if Dz.design == 'consult':
        E = pd.read_parquet(f'{FB.ENG}/engine_wavlm_emb_consults.parquet'); key, keys, roles = 'consult_uid', Dz.ids, ROLES['consults']
    else:
        E = pd.read_parquet(f'{FB.ENG}/engine_wavlm_emb_calls.parquet'); roles = ROLES['calls']
        if Dz.design == 'rx':
            E = pd.read_parquet(f'{FB.ENG}/engine_wavlm_emb_consults.parquet').merge(
                FB.consult_frame()[['consult_uid', 'episode_id']].dropna().drop_duplicates('consult_uid'), on='consult_uid'); roles = ROLES['consults']
        else:
            E = E[E['T'] == int(Dz.design[2:])]
        key, keys = 'episode_id', Dz.ids
    ec = [f'e{i}' for i in range(1024)]; parts = []
    blocked = np.zeros(len(keys), bool)
    if Dz.design.startswith('lm'):
        blocked = (Dz.DX['has_nemo'].values == 0) & (Dz.DX['has_ody'].values == 0) & (Dz.DX['has_e2v'].values == 0) & (Dz.DX['has_clef'].values == 0)
    for r in roles:
        M = E[(E.role == r) & (E.n_win.fillna(0) > 0)].drop_duplicates(key).set_index(key).reindex(keys)[ec].astype(float)
        M.loc[blocked, :] = np.nan
        M.columns = [f'emb_{r}_{i}' for i in range(1024)]; parts.append(M.reset_index(drop=True))
    Dz.DX = pd.concat([Dz.DX] + parts, axis=1)
    return roles


def wavlm_fit_predict(roles):
    def fp(cols, Xtr, ytr, gtr, Xte, seed=None, use_doc=True):
        Xtr = Xtr.copy(); Xte = Xte.copy(); extra = []
        for r in roles:
            ec = [f'emb_{r}_{i}' for i in range(1024)]
            mtr = Xtr[ec].notna().all(axis=1).values; mte = Xte[ec].notna().all(axis=1).values
            nm = [f'wl_{r}_pc{k + 1}' for k in range(3)]
            for X in (Xtr, Xte):
                for c in nm: X[c] = np.nan
            if mtr.sum() >= 10:
                pca = PCA(3, random_state=0).fit(Xtr.loc[mtr, ec].values)        # in-fold: training rows only
                Xtr.loc[mtr, nm] = pca.transform(Xtr.loc[mtr, ec].values)
                if mte.any(): Xte.loc[mte, nm] = pca.transform(Xte.loc[mte, ec].values)
            Xtr[f'has_wl_{r}'] = mtr.astype(float); Xte[f'has_wl_{r}'] = mte.astype(float)
            extra += nm + [f'has_wl_{r}']
        return FL.fit_predict(cols + extra, Xtr, ytr, gtr, Xte, use_doc=use_doc)
    return fp


def oof(Dz, cols, fp=FL.fit_predict):
    O = np.zeros((Dz.reps, len(Dz.y)))
    for rep in range(Dz.reps):
        for a, b in Dz.folds(rep):
            tr, te = Dz.DX.iloc[a].reset_index(drop=True), Dz.DX.iloc[b].reset_index(drop=True)
            O[rep, b], _ = fp(cols, tr, Dz.y[a], Dz.g[a], te, use_doc=Dz.use_doc)
    return O


def nested_platt(Dz, cols, inner=3):
    """Spec s6: per repeat / outer fold, inner GroupKFold(3) OOF scores on the training folds -> logistic map on logit (calib._lr);
    the full-training-fold model scores the held-out fold; the map is applied. Same folds as the final run. -> (raw, platt) (REPS, n)."""
    R = np.zeros((Dz.reps, len(Dz.y))); C = np.zeros_like(R)
    for rep in range(Dz.reps):
        for a, b in Dz.folds(rep):
            tr, te = Dz.DX.iloc[a].reset_index(drop=True), Dz.DX.iloc[b].reset_index(drop=True); ya, ga = Dz.y[a], Dz.g[a]
            inn = np.zeros(len(a))
            for ia, ib in GroupKFold(inner).split(tr, ya, ga):
                inn[ib], _ = FL.fit_predict(cols, tr.iloc[ia].reset_index(drop=True), ya[ia], ga[ia], tr.iloc[ib].reset_index(drop=True), use_doc=Dz.use_doc)
            i0, s0 = calib._lr(calib.logit(inn), ya)
            R[rep, b], _ = FL.fit_predict(cols, tr, ya, ga, te, use_doc=Dz.use_doc)
            C[rep, b] = 1 / (1 + np.exp(-(i0 + s0 * calib.logit(R[rep, b]))))
    return R, C


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('design'); ap.add_argument('lab'); ap.add_argument('kind'); a = ap.parse_args()
    t0 = time.time()
    FB.L8_RAW = a.kind == 'l8raw'
    Dz = FB.build(a.design, a.lab, raw_tags=a.kind == 'rawtags', role_free=a.kind == 'rolefree')
    fin = json.load(open(f'{FIN}/model_frozen_{a.design}_{a.lab}.json'))[0]
    assert fin['oof']['episode_id'] == list(map(str, Dz.ids)) and fin['oof']['y'] == Dz.y.tolist()
    full = [c for L in Dz.order for c in Dz.layers[L]]
    base = 'M0' if a.design == 'rx' else ('C0' if a.design == 'consult' else 'L0'); fname = 'M2' if a.design == 'rx' else 'FULL'
    r = dict(design=a.design, lab=a.lab, kind=a.kind, n=int(len(Dz.y)), pos=int(Dz.y.sum()), notes=Dz.notes, layer_order=Dz.order)
    y, g, nb = Dz.y, Dz.g, 1000
    if a.kind == 'platt':
        r['calibration'] = {}
        for m in (['M0', 'M1'] if a.design == 'rx' else ['FULL']):
            cols = [c for L in fin['models'][m] for c in Dz.layers[L]]
            assert cols == [c for L in fin['models'][m] for c in fin['layers'][L]]
            R, C = nested_platt(Dz, cols)
            ref = np.array(fin['oof']['by_model_repeat'][m])
            r[f'raw_matches_final_{m}'] = float(np.abs(R.round(6) - ref).max())
            r['calibration'][m] = {'raw': calib.calibration(y, R.mean(0), g), 'platt': calib.calibration(y, C.mean(0), g)}
    else:
        P0 = np.array(fin['oof']['by_model_repeat'][base])
        if a.kind == 'wavlm':
            roles = add_embeddings(Dz); Of = oof(Dz, full, wavlm_fit_predict(roles))
            r['wavlm_rows'] = {ro: int(Dz.DX[f'emb_{ro}_0'].notna().sum()) for ro in roles}
        else:
            Of = oof(Dz, full)
        Pf = Of.mean(0)
        r['auc'] = {'L0': FL.boot(y, P0.mean(0), g, nb), 'FULL': FL.boot(y, Pf, g, nb)}
        r['delta'] = FL.boot_delta(y, P0.mean(0), Pf, g, nb)
        rd = np.array([roc_auc_score(y, f) - roc_auc_score(y, b) for b, f in zip(P0, Of)]); r['delta']['p_repeats_le0'] = float(np.mean(rd <= 0))
        r['primary'] = {'FULL_auc': fin['auc'][fname]['auc'], 'delta': fin['delta'][f'{fname}-{base}']}
        r['n_cols_full'] = len(full) + (12 if a.kind == 'wavlm' else 0)
    os.makedirs(SENS, mode=0o700, exist_ok=True)
    p = f'{SENS}/sens_{a.design}_{a.lab}_{a.kind}.json'
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as fh: json.dump(r, fh, default=lambda o: o.to_dict(orient='records') if isinstance(o, pd.DataFrame) else float(o))
    print('wrote', p, f'{round(time.time() - t0)}s', flush=True)


if __name__ == '__main__':
    main()
