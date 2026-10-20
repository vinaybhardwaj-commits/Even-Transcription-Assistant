# ft-bench scoring, design B (FTR v2 landmark episodes: h14/h90/Ale x T=3/7). D split only. Pre-registration: out/ft-bench/DONE.md.
# (a) stated intent alone (last stated intent before T; consult Jev f10/f11/f12 fallback) as a one-feature RF on the FTR folds;
# (b) Jev and (c) Opus raw-transcript probabilities as given (h14/Ale <- p14, h90 <- p90).
# Every comparison uses the SAME episodes, y, clusters as FTR v2; forest OOF = FTR v2 repeat-averaged OOF (base, text_audio) until the
# frozen FULL model's OOF exists (pass FOREST=<json glob> with the same 'oof' format to swap it in).
# Bootstrap: ftc_model.boot / boot_delta copied verbatim (1,000 cluster draws, seed 20261019).
# Writes out/ft-bench/BENCH-TABLES.md, bench_scores.parquet (ids + scores only), bench_results.json.
import os, sys, json, glob
import numpy as np, pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss
sys.path.insert(0, os.path.dirname(__file__))
from bench_inputs import ftr_designs
from calib import calibration, folds, md_calib

H = os.path.expanduser; FT = H('~/oc/forest-lead/ft/out'); CT = f'{FT}/ft-calltext'; RL = H('~/eta-data/forest/rl'); WORK = H('~/eta-data/forest/bench')
OUT = f'{FT}/ft-bench'; RS = 20261019; TAG = os.environ.get('OUT_TAG', ''); NB = int(os.environ.get('NB', 1000)); REPS = 5
CODE = {'declines': 0, 'undecided': 1, 'wants_surgery': 2}


# ---- copied from ft-calltext/code/ftc_model.py (unchanged) ----
def metrics(y, p): return dict(auc=roc_auc_score(y, p), prauc=average_precision_score(y, p), brier=brier_score_loss(y, p))


def cl_boot_idx(g, nb, seed):
    rng = np.random.default_rng(seed); ug = np.unique(g); idx = {k: np.where(g == k)[0] for k in ug}
    for _ in range(nb):
        yield np.concatenate([idx[k] for k in rng.choice(ug, len(ug))])


def boot_auc(y, p, g, nb=NB, seed=RS):
    res = [roc_auc_score(y[s], p[s]) for s in cl_boot_idx(g, nb, seed) if 0 < y[s].sum() < len(s)]
    return (roc_auc_score(y, p), *np.percentile(res, [2.5, 97.5]))


def boot_delta(y, pa, pb, g, nb=NB, seed=RS):
    d = [roc_auc_score(y[s], pb[s]) - roc_auc_score(y[s], pa[s]) for s in cl_boot_idx(g, nb, seed) if 0 < y[s].sum() < len(s)]
    d = np.array(d)
    return (roc_auc_score(y, pb) - roc_auc_score(y, pa), *np.percentile(d, [2.5, 97.5]), float(np.mean(d <= 0)), float(np.mean(d >= 0)))


# ---- (a) stated intent ----
def consult_jev():
    """consult_uid -> {f10, f11, f12} from existing Jev v2 answers (Saaras English; FT6 caveat)."""
    LC = {}
    for l in open(H('~/eta-data/convert/p1/linked.jsonl')):
        r = json.loads(l); LC[r['clip_key']] = r['consult_uid']
    out = {}
    for r in map(json.loads, open(f'{FT}/ft-audio/rf775_members.jsonl')):
        out[r['consult_uid']] = {q: r.get(f'jev_{q}') for q in ('f10', 'f11', 'f12')}
    J = pd.concat([pd.read_json(f, lines=True) for f in (H('~/eta-data/convert/p2v2/jev.jsonl'), f'{FT}/ft-audio/jev_gapfill.jsonl',
                                                         f'{FT}/ft-cohortb-expand/jev_gapfill.jsonl')])
    J = J[J.qid.isin(['f10', 'f11', 'f12'])]
    for k, g in J.groupby('clip_key'):
        out.setdefault(LC.get(k, k), dict(zip(g.qid, g.p_yes)))
    return out


def intent_codes(eps, T):
    """episode -> (code, source): last stated intent before T over Runo-summary tags and Runo-STT tags; consult fallback."""
    lab = pd.read_parquet(f'{FT}/ft-labels-base/labels.parquet').set_index('episode_id')
    C = pd.read_parquet(f'{CT}/calls_D.parquet')
    tga = pd.read_json(f'{CT}/tags_D.jsonl', lines=True)
    fa = set(tga.loc[(tga.outcome_revealed == True) | (tga.outcome_revealed_unverified == True), 'call_id'])   # fix 7: ANY tag record
    tg = tga.drop_duplicates('call_id', keep='last')
    C = C.merge(tg[['call_id', 'intent']], on='call_id', how='inner')   # tagged only
    C = C[(C.day_from_rx < T) & ~C.call_id.isin(fa)]
    # fix 10: one timestamp format for ordering (summary_ts has a +0530 offset; no summary time -> start of the call day)
    sts = pd.to_datetime(C.summary_ts.astype(str).str[:23], errors='coerce')
    A = pd.DataFrame({'episode_id': C.episode_id, 'ts': sts.fillna(pd.to_datetime(C.call_day)), 'intent': C.intent, 'src': 'summary'})
    man = pd.read_csv(f'{RL}/manifest.tsv', sep='\t', dtype=str); man = man[man.in_shard.isin(['a', 'b', 'c'])].drop_duplicates('key_id')
    sta = pd.read_json(f'{RL}/feat/tags.jsonl', lines=True)
    fs = set(sta.loc[(sta.outcome_revealed == True) | (sta.outcome_revealed_unverified == True), 'call_id'])
    st = sta.drop_duplicates('call_id', keep='last')
    M = man.merge(st[['call_id', 'intent']], left_on='key_id', right_on='call_id')
    ev = pd.to_datetime(M.episode_id.map(lab.event_date))
    M = M[(M.day_from_rx.astype(int) < T) & ~M.call_id.isin(fs)
          & ~(ev.notna() & (pd.to_datetime(M.call_date) >= ev))]
    B = pd.DataFrame({'episode_id': M.episode_id, 'ts': pd.to_datetime(M.call_ts, errors='coerce').fillna(pd.to_datetime(M.call_date)), 'intent': M.intent, 'src': 'stt'})
    X = pd.concat([A, B]); X = X[X.intent.isin(CODE) & X.episode_id.isin(eps)].sort_values(['episode_id', 'ts'])
    last = X.groupby('episode_id').tail(1).set_index('episode_id')
    inv = pd.read_parquet(f'{FT}/ft-cohortb-expand/inventory.parquet'); inv = inv[inv.duplicate_of.isna()].sort_values('consult_ist')
    inv = inv.assign(day=(pd.to_datetime(inv.consult_ist.str[:10]) - pd.to_datetime(inv.rx_date)).dt.days)
    inv = inv[inv.day < T].drop_duplicates('episode_id').set_index('episode_id')
    CJ = consult_jev(); out = {}
    for e in eps:
        if e in last.index: out[e] = (CODE[last.at[e, 'intent']], 'call_' + last.at[e, 'src']); continue
        j = CJ.get(inv.at[e, 'consult_uid']) if e in inv.index else None
        if j and j.get('f10') is not None:
            if j['f10'] >= 0.5: out[e] = (2, 'consult'); continue
            if (j.get('f11') or 0) >= 0.5 or (j.get('f12') or 0) >= 0.5: out[e] = (1, 'consult'); continue
        out[e] = (-1, 'none')
    return out


def rf_one_feature(x, y, g):
    P = np.zeros((REPS, len(y)))
    for rep in range(REPS):
        for a, b in folds(y, g, rep):
            m = RandomForestClassifier(n_estimators=400, min_samples_leaf=5, max_features='sqrt', n_jobs=4, random_state=RS + rep).fit(x[a, None], y[a])
            P[rep, b] = m.predict_proba(x[b, None])[:, 1]
    return P.mean(0)


def load_llm(engine):
    d = pd.read_json(f'{WORK}/scores_{engine}.jsonl', lines=True).drop_duplicates(['episode_id', 'T'], keep='last')
    return d.set_index(['episode_id', 'T'])


def forest_oof(lab, T):
    """Repeat-averaged OOF per model, aligned to the FTR episode order. FOREST env = glob of frozen-model JSONs (same format)."""
    pat = os.environ.get('FOREST', f'{CT}/model_final2_{lab}-P-lm3_{lab}-P-lm7.json')
    hits = [(f, r) for f in sorted(glob.glob(pat)) for r in json.load(open(f)) if r.get('lab') == lab and r.get('design') == f'lm{T}']
    assert len(hits) <= 1, f'{len(hits)} forest OOF blocks match {lab} lm{T} in {pat}: make the glob unique'
    for f, r in hits:
        P = {m: np.array(v).mean(0) for m, v in r['oof']['by_model_repeat'].items()}
        for kv in filter(None, os.environ.get('FOREST_MODELS', '').split(',')):     # e.g. FULL:text_audio,L0:base
            src, dst = kv.split(':'); P[dst] = P[src]
        return P, r['oof']['episode_id']
    raise SystemExit(f'no forest OOF for {lab} lm{T}')


def f3(t): return f'{t[0]:.3f} [{t[1]:.3f}, {t[2]:.3f}]'


def main():
    R = ftr_designs(); J = load_llm('jev'); O = load_llm('opus')
    MT = pd.read_parquet(f'{WORK}/inputs_meta.parquet').set_index(['episode_id', 'T'])
    ap = f'{WORK}/audit_opus.jsonl'
    AU = pd.read_json(ap, lines=True).drop_duplicates(['episode_id', 'T'], keep='last') if os.path.exists(ap) and os.path.getsize(ap) else pd.DataFrame(columns=['episode_id', 'T'])
    if len(AU): AU['proxy'] = AU.date_or_slot_fixed | AU.admission_or_preop | AU.preauth_or_insurance_filed
    AU = AU.set_index(['episode_id', 'T'])
    rows, res, L, tests = [], [], [], []
    for (lab, T), o in sorted(R.items(), key=lambda x: (x[0][1], x[0][0])):
        e = np.array(o['episode_id']); y = np.array(o['y'], int); g = np.array(o['cluster'])
        FO, fe = forest_oof(lab, T); assert list(fe) == list(e), 'forest OOF episode order differs'
        ic = intent_codes(set(e), T); code = np.array([ic[x][0] for x in e], float); isrc = np.array([ic[x][1] for x in e])
        a_rf = rf_one_feature(code, y, g)
        pk = 'p90' if lab == 'h90' else 'p14'
        S = {'a_intent_rf': a_rf, 'a_intent_raw': code}
        cov = {'a_intent_rf': code >= 0, 'a_intent_raw': code >= 0}
        for nm, D in (('b_jev', J), ('c_opus', O)):
            v = np.array([D.at[(x, T), pk] if (x, T) in D.index else np.nan for x in e], float)
            c = ~np.isnan(v); v[~c] = np.median(v[c]); S[nm] = v; cov[nm] = c
        bk = np.array([bool(O.at[(x, T), 'booked']) if (x, T) in O.index else False for x in e])
        rec = dict(lab=lab, T=T, n=len(y), pos=int(y.sum()), clusters=len(np.unique(g)), intent_src=pd.Series(isrc).value_counts().to_dict(),
                   opus_booked=int(bk.sum()), opus_booked_pos=int((bk & (y == 1)).sum()), bench={})
        L += [f'### {lab} T={T}: n {len(y)}, positives {int(y.sum())}, clusters {len(np.unique(g))}',
              f'Stated-intent source: {rec["intent_src"]}. Opus booked=true on {rec["opus_booked"]} episodes ({rec["opus_booked_pos"]} positive).', '',
              '| benchmark | population | n | pos | benchmark AUC [CI] | base AUC [CI] | text_audio AUC [CI] | Δ text_audio−bench [CI]; P(Δ≤0) | Δ base−bench [CI]; P(Δ≤0) |',
              '|---|---|---|---|---|---|---|---|---|']
        for nm in S:
            for pop in ('all', 'covered'):
                s = np.ones(len(y), bool) if pop == 'all' else cov[nm]
                if not 0 < y[s].sum() < s.sum(): continue
                yy, gg, pb = y[s], g[s], S[nm][s]
                ba = boot_auc(yy, pb, gg); fa = {m: boot_auc(yy, FO[m][s], gg) for m in ('base', 'text_audio')}
                dl = {m: boot_delta(yy, pb, FO[m][s], gg) for m in ('base', 'text_audio')}
                rec['bench'][f'{nm}/{pop}'] = dict(n=int(s.sum()), pos=int(yy.sum()), auc=ba, forest=fa, delta=dl)
                L.append(f'| {nm} | {pop} | {int(s.sum())} | {int(yy.sum())} | {f3(ba)} | {f3(fa["base"])} | {f3(fa["text_audio"])} | '
                         f'{dl["text_audio"][0]:+.3f} [{dl["text_audio"][1]:+.3f}, {dl["text_audio"][2]:+.3f}]; {dl["text_audio"][3]:.2f} | '
                         f'{dl["base"][0]:+.3f} [{dl["base"][1]:+.3f}, {dl["base"][2]:+.3f}]; {dl["base"][3]:.2f} |')
                if pop == 'all' and nm in ('a_intent_raw', 'b_jev', 'c_opus'):          # Addendum 3: RF variant invalid (null bias)
                    d = dl['text_audio']; tests.append((lab, T, nm, d[0], max(2 * min(d[3], d[4]), 1 / NB)))
        # sensitivities (not tested): Opus booked=false; calls-only text; audit outcome-proxy flags removed (Addendum 3)
        hc = np.array([MT.at[(x, T), 'has_consult'] if (x, T) in MT.index else False for x in e], bool)
        px = np.array([AU.at[(x, T), 'proxy'] if (x, T) in AU.index else False for x in e], bool)
        aud = np.array([(x, T) in AU.index for x in e], bool)
        sens = [('c_opus', 'covered, Opus booked=false', cov['c_opus'] & ~bk), ('b_jev', 'covered, calls-only text', cov['b_jev'] & ~hc),
                ('c_opus', 'covered, calls-only text', cov['c_opus'] & ~hc), ('b_jev', 'covered, consult in text', cov['b_jev'] & hc),
                ('c_opus', 'covered, consult in text', cov['c_opus'] & hc)]
        if len(AU):
            sens += [('c_opus', 'audited (selection, see DONE)', cov['c_opus'] & aud), ('c_opus', 'audited, outcome-proxy flags removed', cov['c_opus'] & aud & ~px),
                     ('b_jev', 'audited, outcome-proxy flags removed', cov['b_jev'] & aud & ~px)]
            rec['audit'] = dict(audited=int(aud.sum()), proxy=int(px.sum()), proxy_pos=int((px & (y == 1)).sum()), audited_pos=int((aud & (y == 1)).sum()))
            L.append(f'Audit: {rec["audit"]["audited"]} audited ({rec["audit"]["audited_pos"]} positive); outcome-proxy flagged {rec["audit"]["proxy"]} ({rec["audit"]["proxy_pos"]} positive).')
        L += ['', '| sensitivity (not a test) | subset | n | pos | benchmark AUC [CI] | base AUC [CI] | text_audio AUC [CI] | Δ text_audio−bench [CI]; P(Δ≤0) |', '|---|---|---|---|---|---|---|---|']
        for nm, lbl, s in sens:
            if not 0 < y[s].sum() < s.sum(): L.append(f'| {nm} | {lbl} | {int(s.sum())} | {int(y[s].sum())} | not estimable | | | |'); continue
            ba = boot_auc(y[s], S[nm][s], g[s]); fb = boot_auc(y[s], FO['base'][s], g[s]); fa = boot_auc(y[s], FO['text_audio'][s], g[s])
            d = boot_delta(y[s], S[nm][s], FO['text_audio'][s], g[s]); rec['bench'][f'{nm}/{lbl}'] = dict(n=int(s.sum()), pos=int(y[s].sum()), auc=ba, delta=d)
            L.append(f'| {nm} | {lbl} | {int(s.sum())} | {int(y[s].sum())} | {f3(ba)} | {f3(fb)} | {f3(fa)} | {d[0]:+.3f} [{d[1]:+.3f}, {d[2]:+.3f}]; {d[3]:.2f} |')
        L.append('')
        for nm, pop in (('b_jev', 'covered'), ('c_opus', 'covered')):
            s = np.ones(len(y), bool) if pop == 'all' else cov[nm]
            L += md_calib(f'Calibration {lab} T={T} / {nm} ({pop})', calibration(y[s], S[nm][s], g[s]))
        res.append(rec)
        for i, x in enumerate(e):
            rows.append(dict(episode_id=x, lab=lab, T=T, y=int(y[i]), cluster=g[i], a_intent_code=int(code[i]), a_intent_src=isrc[i], a_intent_rf=a_rf[i],
                             b_jev=S['b_jev'][i] if cov['b_jev'][i] else np.nan, c_opus=S['c_opus'][i] if cov['c_opus'][i] else np.nan,
                             c_opus_booked=bk[i], forest_base=FO['base'][i], forest_text_audio=FO['text_audio'][i]))
        print(lab, T, 'done', flush=True)
    # Holm over the 18-delta family (text_audio - benchmark, ALL population, 3 benchmarks x 6 designs)
    tests.sort(key=lambda t: t[4]); m = len(tests); adj = []; run = 0
    for i, t in enumerate(tests):
        run = max(run, min(1, (m - i) * t[4])); adj.append(run)
    Ht = ['', f'Holm, family of {m} (text_audio − benchmark, ALL population); two-sided bootstrap p = 2·min(P(Δ≤0), P(Δ≥0)), floor 1/{NB}.', '',
          '| label | T | benchmark | Δ | raw p | Holm p |', '|---|---|---|---|---|---|'] + \
         [f'| {t[0]} | {t[1]} | {t[2]} | {t[3]:+.3f} | {t[4]:.3f} | {a:.3f} |' for t, a in zip(tests, adj)]
    hdr = [f'# BENCH-TABLES (ft-bench, design B), 20 Oct 2026 {pd.Timestamp.now():%H:%M} IST. Served by Claude Opus 5.5 on Bedrock. D split only; H never read.',
           'Pre-registration: DONE.md (prompts sha in PREREG.md). Episodes, labels, clusters, folds = ft-calltext FTR v2 (model_final2_*.json).',
           'Forest = FTR v2 base and text_audio repeat-averaged OOF (stand-in until the frozen FULL OOF exists). 1,000-draw cluster bootstrap, seed 20261019.',
           'Populations: ALL = every at-risk episode (no-text LLM rows = median of covered scores; intent none = code −1); COVERED = episodes with a benchmark value.',
           '(a) = a_intent_raw (ordinal code, no training). a_intent_rf rows are INVALID (one-feature in-fold RF has null OOF AUC ~0.40 on shuffled labels; DONE.md Addendum 3).', '']
    txt = '\n'.join(hdr + L + Ht) + '\n'
    open(f'{OUT}/BENCH-TABLES{TAG}.md', 'w').write(txt); os.chmod(f'{OUT}/BENCH-TABLES{TAG}.md', 0o600)
    pd.DataFrame(rows).to_parquet(f'{OUT}/bench_scores{TAG}.parquet'); os.chmod(f'{OUT}/bench_scores{TAG}.parquet', 0o600)
    json.dump(dict(results=res, holm=[dict(lab=t[0], T=t[1], bench=t[2], delta=t[3], p=t[4], holm=a) for t, a in zip(tests, adj)]),
              open(f'{OUT}/bench_results{TAG}.json', 'w'), indent=1, default=float)
    os.chmod(f'{OUT}/bench_results{TAG}.json', 0o600)
    print('wrote BENCH-TABLES.md')


if __name__ == '__main__':
    main()
