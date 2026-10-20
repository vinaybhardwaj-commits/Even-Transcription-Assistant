# ft-forest: design-C benchmarks vs the frozen forest (spec s7, F-bench consult part), written to OUR dir only (ft-bench bench_score_c.py
# would overwrite ft-bench's own BENCH-TABLES-C.md). Same rules as bench_score_c.py: benchmarks scored as given; ALL population = rows without a
# score (NaN) get the median of the covered scores; (a) = raw ordinal stated intent (a_intent_raw: -1 = none stated is kept as the lowest level in ALL, excluded from COVERED); (b) = b_jev;
# (c) = c_opus (pre-registered); c_opus_screen2 as a sensitivity. Bootstrap = ft-bench boot_auc / boot_delta (imported read-only; seed 20261019).
# Holm: F-bench = the 18 design-B tests (text_audio slot = FULL) from bench_results<TAG>.json + the 6 design-C FULL - benchmark (ALL) tests.
# Usage: forest_bench_c.py <forest dir> <ft-bench OUT_TAG, e.g. -frozen-1412>
import os, sys, json
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, os.path.expanduser('~/wt/ft-bench/code'))
import numpy as np, pandas as pd
from bench_score import boot_auc, boot_delta, NB
import forest_lib as FL

O, TAG = sys.argv[1], sys.argv[2]
BS = pd.read_parquet(os.path.expanduser('~/oc/forest-lead/ft/out/ft-bench/bench_scores_c.parquet')).set_index('consult_uid')
f3 = lambda t: f'{t[0]:.3f} [{t[1]:.3f}, {t[2]:.3f}]'
L = [f'# Design C benchmarks vs the frozen forest (ft-forest; benchmark scores = ft-bench bench_scores_c.parquet, scored as given)', '']
tests = []
for lab in ('ale_strict', 'h14_ge18'):
    r = json.load(open(f'{O}/model_frozen_consult_{lab}.json'))[0]; o = r['oof']
    ids = o['episode_id']; y = np.array(o['y']); g = np.array(o['cluster'])
    P = {m: np.array(v).mean(0) for m, v in o['by_model_repeat'].items()}
    L += [f'## {lab}: n {len(y)}, positives {int(y.sum())}', '', '| benchmark | population | n | pos | benchmark AUC [CI] | FULL AUC [CI] | Δ FULL−bench [CI]; P(Δ≤0) | C7 AUC [CI] | Δ C7−bench [CI]; P(Δ≤0) |',
          '|---|---|---|---|---|---|---|---|---|']
    for nm in ('a_intent_raw', 'b_jev', 'c_opus', 'c_opus_screen2'):
        v = BS.reindex(ids)[nm].astype(float).values; c = ~np.isnan(v) & ((v >= 0) if nm == 'a_intent_raw' else True)
        for pop in ('all', 'covered'):
            s = np.ones(len(y), bool) if pop == 'all' else c
            if not 0 < y[s].sum() < s.sum() or c.sum() == 0: continue
            vv = np.where(np.isnan(v), np.nanmedian(v[c]), v)[s]   # as bench_score_c.py: only NaN gets the median; a_intent_raw -1 (none stated) stays the lowest level (refute fix 1, 11:21)
            ba = boot_auc(y[s], vv, g[s]); row = f'| {nm} | {pop} | {int(s.sum())} | {int(y[s].sum())} | {f3(ba)} |'
            for m in ('FULL', 'C7'):
                fa = boot_auc(y[s], P[m][s], g[s]); d = boot_delta(y[s], vv, P[m][s], g[s])
                row += f' {f3(fa)} | {d[0]:+.3f} [{d[1]:+.3f}, {d[2]:+.3f}]; {d[3]:.2f} |'
                if m == 'FULL' and pop == 'all' and nm in ('a_intent_raw', 'b_jev', 'c_opus'):
                    tests.append((f'consult {lab}', nm, d[0], max(2 * min(d[3], d[4]), 1 / NB)))
            L.append(row)
    L.append('')
B = json.load(open(os.path.expanduser(f'~/oc/forest-lead/ft/out/ft-bench/bench_results{TAG}.json')))
bt = [(f"{h['lab']} lm{h['T']}", h['bench'], h['delta'], h['p']) for h in B['holm']]
allt = bt + tests; adj = FL.holm([t[3] for t in allt])
L += [f'## F-bench Holm family ({len(allt)} tests: {len(bt)} design B from ft-bench bench_results{TAG}.json, text_audio slot = FULL; {len(tests)} design C here)', '',
      '| design | benchmark | Δ FULL−bench | raw p | Holm p |', '|---|---|---|---|---|']
for t, a in sorted(zip(allt, adj), key=lambda z: z[1]):
    L.append(f'| {t[0]} | {t[1]} | {t[2]:+.3f} | {t[3]:.3f} | {a:.3f} |')
p = f'{O}/BENCH-C-FOREST.md'
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, ('\n'.join(L) + '\n').encode()); os.close(fd)
print(p, len(allt), 'F-bench tests')
