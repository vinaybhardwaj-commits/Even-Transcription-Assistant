# ft-forest: FOREST-TABLES-SENS.md from out/ft-forest/sens/sens_*.json (reported, not tested; FOREST-TABLES.md and model_frozen_* untouched).
import os, sys, json, glob, datetime as dt
H = os.path.expanduser; FIN = H('~/oc/forest-lead/ft/out/ft-forest'); S = f'{FIN}/sens'
now = dt.datetime.now(dt.timezone(dt.timedelta(hours=5, minutes=30))).strftime('%Y-%m-%d %H:%M IST')
DO = {'rx': 0, 'lm3': 1, 'lm7': 2, 'consult': 3}; LO = {'h14': 0, 'h90': 1, 'ale': 2, 'ale_strict': 3, 'h14_ge18': 4}
R = sorted([json.load(open(f)) for f in glob.glob(f'{S}/sens_*.json')], key=lambda r: (DO[r['design']], LO[r['lab']]))
f3 = lambda t: f'{t[0]:.3f} [{t[1]:.3f}, {t[2]:.3f}]'
KIND = {'rawtags': 'Raw Haiku tags in layer 3 (no Jev filter; tags_D.jsonl, rl-feat tags.jsonl, bolna_raw_*)',
        'rolefree': 'Role-free audio only (every patient / counsellor / doctor engine column dropped; _all_ and role-free columns kept)',
        'wavlm': 'FULL + separate WavLM embeddings (Aniemore wavlm-emotion-v1 mean-pool, 1024-d per role; 3 PCA components per role fitted in-fold on the training rows; has_ flag per role)',
        'l8raw': 'Layer 8 = the UNSCREENED Opus score (opus_p14 / opus_p90, has_text): proxy-inflated (pre-auth / insurance / payment talk kept)'}
L = [f'# FOREST-TABLES-SENS (ft-forest, {now}). Served by Claude Opus 5.5 on Bedrock. D split only; H never read.',
     '- Ordered by forest-lead 09:32 (spec s4 / s6 / s7). Everything here is REPORTED, NOT TESTED (not in any Holm family). Primary results: FOREST-TABLES.md (sha 057ee325677d), unchanged.',
     '- Same rows, folds, seeds, learner and bootstrap (1,000 cluster draws, seed 20261019) as the final run. FULL - L0 only (A: M2 - M0; C: FULL - C0). '
     'L0 is identical in every sensitivity (same columns, folds and seed), so its OOF is read from the final model_frozen file.', '']
for k in ('rawtags', 'rolefree', 'wavlm', 'l8raw'):
    rows = [r for r in R if r['kind'] == k]
    if not rows: continue
    L += [f'## Sensitivity: {KIND[k]}', '', '| design | label | n / pos | FULL AUC primary | FULL AUC sensitivity | Δ FULL−L0 primary | Δ FULL−L0 sensitivity [95% CI] | P(Δ≤0) boot / repeats |' + (' WavLM rows per role |' if k == 'wavlm' else ''),
          '|---|---|---|---|---|---|---|---|' + ('---|' if k == 'wavlm' else '')]
    for r in rows:
        d = r['delta']; p = r['primary']
        L.append(f"| {r['design']} | {r['lab']} | {r['n']} / {r['pos']} | {p['FULL_auc'][0]:.3f} | {f3(r['auc']['FULL']['auc'])} | {p['delta']['delta']:+.3f} | "
                 f"{d['delta']:+.3f} [{d['ci'][0]:+.3f}, {d['ci'][1]:+.3f}] | {d['p_boot_le0']:.3f} / {d['p_repeats_le0']:.2f} |" + (f" {r.get('wavlm_rows')} |" if k == 'wavlm' else ''))
    L.append('')
P = [r for r in R if r['kind'] == 'platt']
if P:
    L += ['## Calibration: raw RF vs nested in-fold sigmoid (spec s6)', '',
          '- Nested sigmoid: for each repeat and outer fold, inner GroupKFold(3) OOF scores on the TRAINING folds only -> logistic map of y on logit(score) (ft-bench calib._lr); '
          'the model fitted on the full training folds scores the held-out fold and the map is applied. Repeat-averaged. Metrics = ft-bench calib.calibration (cluster bootstrap CIs). '
          'The raw-RF refit inside this run equals the final OOF (max abs diff shown). Calibration does not change AUC much (the map is monotone per fold; averaging over repeats can move it slightly).', '',
          '| design | label | model | version | AUC | Brier | no-skill Brier | Brier skill | slope | intercept | CITL | ECE | raw refit = final (max diff) |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|']
    for r in P:
        for m, c in r['calibration'].items():
            for v in ('raw', 'platt'):
                pt, ci = c[v]['point'], c[v]['ci']
                cell = lambda k: f"{pt[k]:.3f} [{ci[k][0]:.3f}, {ci[k][1]:.3f}]" if k in ci else f"{pt[k]:.3f}"
                L.append(f"| {r['design']} | {r['lab']} | {m} | {'raw RF' if v == 'raw' else 'nested sigmoid'} | " + ' | '.join(cell(k) for k in ('auc', 'brier', 'brier_noskill', 'bss', 'slope', 'intercept', 'citl', 'ece'))
                         + f" | {r.get(f'raw_matches_final_{m}', float('nan')):.1e} |")
    L += ['', '- Reading: the raw RF is under-dispersed at T3/T7 (slope 0.63-0.92) and close to 1 at the Rx; the nested sigmoid brings the slopes to about 1.0-1.3 with CITL near 0, '
          'and Brier is unchanged to 3 decimals everywhere. It does not improve discrimination and costs up to 0.02 AUC (repeat-averaged per-fold maps).',
          '- NOT USABLE: consult h14_ge18 (12 positives). With about 2 positives per inner fold, some fold maps have a negative slope, which inverts the ranking (AUC 0.265, slope -6.0). '
          'This is a small-n failure of in-fold calibration, not evidence about the model; report only the raw RF for this design.',
          '- ECE: the bootstrap interval can lie above the point estimate because bootstrap ECE is biased upward (ft-bench DONE note).',
          '', '### Reliability, nested sigmoid (10 quantile bins: mean predicted vs observed [95% Wilson])', '']
    for r in P:
        for m, c in r['calibration'].items():
            rel = c['platt']['reliability']
            L += [f"**{r['design']} {r['lab']} / {m}**", '', '| bin | n | pos | mean predicted | observed [95% Wilson] |', '|---|---|---|---|---|']
            L += [f"| {b['bin']} | {b['n']} | {b['pos']} | {b['mean_p']:.3f} | {b['obs']:.3f} [{b['obs_lo']:.3f}, {b['obs_hi']:.3f}] |" for b in rel] + ['']
p = f'{FIN}/FOREST-TABLES-SENS.md'
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, ('\n'.join(L) + '\n').encode()); os.close(fd)
print(p, len(R), 'sens files')
