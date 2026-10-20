# ft-forest tables (20 Oct 2026): FOREST-TABLES.md + DONE.md from model_frozen_*.json in DIR. Holm within each spec s9 family.
# Usage: forest_tables.py [DIR] [--title T]. Counts, AUCs and deltas only; no ids.
import os, sys, json, glob, hashlib, datetime as dt
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import forest_lib as FL, forest_build as FB

D = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else os.path.expanduser('~/oc/forest-lead/ft/out/ft-forest')
TITLE = sys.argv[sys.argv.index('--title') + 1] if '--title' in sys.argv else 'FOREST-TABLES'
DORDER = {'rx': 0, 'lm3': 1, 'lm7': 2, 'consult': 3}; LORDER = {'h14': 0, 'h90': 1, 'ale': 2, 'ale_strict': 3, 'h14_ge18': 4}
R = sorted([r for f in glob.glob(f'{D}/model_frozen_*.json') for r in json.load(open(f)) if not r.get('tag')],
           key=lambda r: (DORDER[r['design']], LORDER[r['lab']]))
now = dt.datetime.now(dt.timezone(dt.timedelta(hours=5, minutes=30))).strftime('%Y-%m-%d %H:%M IST')
f3 = lambda t: f'{t[0]:.3f} [{t[1]:.3f}, {t[2]:.3f}]'
fd = lambda d: f"{d['delta']:+.3f} [{d['ci'][0]:+.3f}, {d['ci'][1]:+.3f}]"


def family(r, k):
    a, b = k.split('-')[1], k.split('-')[0]
    if b == 'SELECTED': return None
    if r['design'] == 'rx':
        if k == 'M1-M0': return 'F-primary' if r['lab'] in ('h14', 'h90') else 'F-Ale-Rx'
        if k == 'M2-M1' and r['lab'] in ('h14', 'h90'): return 'F-Ale-Rx'
        return None
    if r['design'].startswith('lm'): return 'F-calls'
    if r['design'] == 'consult': return 'F-consults'


tests = [(r, k, d) for r in R for k, d in r['delta'].items() if family(r, k)]
fams = sorted({family(r, k) for r, k, _ in tests}, key=['F-primary', 'F-Ale-Rx', 'F-calls', 'F-consults'].index)
HP = {}
for fm in fams:
    T = [(r, k, d) for r, k, d in tests if family(r, k) == fm]
    for (r, k, d), a in zip(T, FL.holm([d['p_two'] for _, _, d in T])): HP[(r['design'], r['lab'], k)] = (fm, a, len(T))

L = [f'# {TITLE} (ft-forest, {now}). Served by Claude Opus 5.5 on Bedrock. D split only; H never read.',
     '- Spec FT-MODEL-SPEC-20OCT. Learner RF(400, min_samples_leaf=5, sqrt, random_state=0); NaN -> -1 plus has_ flags; in-fold doctor rate (m = 10) in A and B.',
     '- AUC on the repeat-averaged OOF score, 1,000-draw cluster bootstrap, percentile 95% CI. Delta = paired, same rows and folds, same draws. '
     'p = two-sided bootstrap 2 min(P(d<=0), P(d>=0)), floor 1/1000; Holm within each spec s9 family. A gain is claimed only if Holm p < 0.05 (CI excludes 0 after Holm); everything else DIRECTIONAL.',
     '- Doctor rate: designs A and B use the in-fold doctor prior rate (m = 10, FT3); design C uses FT4 pulse_only with its time-respecting doc_prior_rate (ruling 5, 07:24).',
     '- Tree seed: random_state = 0 for every model (spec s3, ruling 1); fold seeds are FTR v2 (RS + rep) for A/B and FT4 (rep) for C. FTR v2 used RS + rep as the tree seed too, so L0 differs slightly from the FTR v2 base: shown per B design.',
     '- SELECTED is chosen on the same data: its AUC is optimistic and its deltas are not tests. FULL = every layer in (identical to the last cumulative model).', '']
DL = {(r['design'], r['lab'], k): d['delta'] for r, k, d in tests}
L += ['## Tests made (two-sided; a gain is claimed only if Holm p < 0.05 and Δ > 0; Holm p < 0.05 with Δ < 0 = the layer made the model WORSE)',
      '| family | tests | Holm p < 0.05, gain (Δ > 0) | Holm p < 0.05, loss (Δ < 0) |', '|---|---|---|---|']
cnt = lambda fm, sg: sum(1 for k, v in HP.items() if (fm is None or v[0] == fm) and v[1] < 0.05 and sg * DL[k] > 0)
for fm in fams:
    L.append(f'| {fm} | {sum(1 for v in HP.values() if v[0] == fm)} | {cnt(fm, 1)} | {cnt(fm, -1)} |')
L += [f'| total here | {len(HP)} | {cnt(None, 1)} | {cnt(None, -1)} |', '',
      'F-bench (24) is scored by the ft-bench harness (run_frozen.sh) on these files; F-H (2) by ft-h1shot.', '']

for r in R:
    ms = list(r['models'])
    L += [f"## {r['design']} / {r['lab']}: n {r['n']}, positives {r['pos']} (base rate {r['pos'] / r['n']:.3f}), clusters {r['clusters']}, "
          f"{r['reps']} repeats x 5 folds (seed {r['fold_seed']})", '']
    L += [f'- {x}' for x in r.get('notes', [])]
    if r['design'].startswith('lm'):
        ftr = [x for x in json.load(open(f"{FB.CT}/model_final2_{r['lab']}-P-lm3_{r['lab']}-P-lm7.json")) if x['design'] == r['design']][0]
        assert ftr['oof']['episode_id'] == r['oof']['episode_id']
        import numpy as np
        from sklearn.metrics import roc_auc_score
        fa = roc_auc_score(ftr['oof']['y'], np.array(ftr['oof']['by_model_repeat']['base']).mean(0))
        L.append(f"- L0 (tree seed 0) AUC {r['auc']['L0']['auc'][0]:.3f} vs FTR v2 base (tree seed RS + rep, same rows and folds) {fa:.3f}: difference {r['auc']['L0']['auc'][0] - fa:+.3f}")
    L += ['']
    L += ['| model | layers | n cols | AUC [95% CI] | PR-AUC [95% CI] | Brier | AUC range over repeats |', '|---|---|---|---|---|---|---|']
    for m in ms:
        a = r['auc'][m]; pr = r['per_repeat_auc'][m]; nc = sum(len(r['layers'][x]) for x in r['models'][m])
        L.append(f"| {m} | {'+'.join(r['models'][m])} | {nc} | {f3(a['auc'])} | {f3(a['prauc'])} | {a['brier'][0]:.4f} | {min(pr):.3f}-{max(pr):.3f} |")
    L += ['', '| delta | ΔAUC [95% CI] | P(Δ<=0) boot / repeats | p two-sided | family | Holm p (family size) |', '|---|---|---|---|---|---|']
    for k, d in r['delta'].items():
        h = HP.get((r['design'], r['lab'], k))
        L.append(f"| {k} | {fd(d)} | {d['p_boot_le0']:.3f} / {d['p_repeats_le0']:.2f} | {d['p_two']:.3f} | {h[0] if h else 'not a test'} | "
                 + (f"{h[1]:.3f} ({h[2]})" if h else '-') + ' |')
    if r.get('selected_path'):
        L += ['', f"SELECTED forward pass (keep if Δ > 0 and P(Δ<=0) <= 0.20): final {'+'.join(r['models']['SELECTED'])}", '',
              '| layer | over | ΔAUC [95% CI] | P(Δ<=0) | kept |', '|---|---|---|---|---|']
        for p in r['selected_path']:
            L.append(f"| {p['layer']} {FB.LAYER_NAMES.get('L' + p['layer'][1], '')} | {p['over']} | {p['delta']:+.3f} [{p['ci'][0]:+.3f}, {p['ci'][1]:+.3f}] | {p['p_boot_le0']:.3f} | {'yes' if p['kept'] else 'no'} |")
    L += ['', '| layer | rows with data | share | positives with data | share of positives | negatives with data | share of negatives | role columns present |', '|---|---|---|---|---|---|---|---|']
    for k, c in r['coverage'].items():
        L.append(f"| {k} | {c['n']} | {c['share']:.3f} | {c['pos']} | {c['pos_share']:.3f} | {c['neg']} | {c['neg_share']:.3f} | {c.get('role_cols_present', '-')} |"
                 + (f" sources: {c['sources']}" if 'sources' in c else ''))
    if r.get('perm'):
        L += ['', f"Grouped permutation importance in {r['perm_model']} (AUC drop; folds of repeats 0-1 x 10 permutations; mean [2.5, 97.5 pct]; descriptive)", '',
              '| group | cols | mean | 2.5% | 97.5% |', '|---|---|---|---|---|']
        for k, v in sorted(r['perm'].items(), key=lambda kv: -kv[1]['mean']):
            L.append(f"| {k} | {v['n_cols']} | {v['mean']:+.4f} | {v['lo']:+.4f} | {v['hi']:+.4f} |")
    L.append('')
out = f'{D}/{TITLE}.md'
fdsc = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fdsc, ('\n'.join(L) + '\n').encode()); os.close(fdsc); os.chmod(out, 0o600)
print(out, len(R), 'design files,', len(HP), 'tests')
