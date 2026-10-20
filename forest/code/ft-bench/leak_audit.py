# ft-bench LEAK-AUDIT of benchmarks (b) Jev and (c) Opus on the COVERED design-B episodes (newcat-orch 05:15, forest-lead 05:3x).
# 1. Lexical scan of the exact text fed to Opus: scheduling/date-fixing, admission, payment, OT/pre-op, pre-auth words (English plus common
#    native-script transliterations; crude, counts only), with call/consult days vs T. Per-episode for ale T=3: all positives + a seeded
#    random equal number of negatives; counts by outcome for every design.
# 2. Rescoring: original, lag1 (calls on day >= T-1 removed), consult-only; Opus and Jev; forest on identical rows.
# 3. Splits: calls-only / consult-only / both; Opus category audit outcome-proxy flags removed; positives by days_to_surgery bucket.
# Writes out/ft-bench/LEAK-AUDIT.md (row numbers, no ids) and leak_audit_rows.parquet (0600, ids for the refuter).
import os, sys, json, re, random
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
from bench_score import boot_auc, boot_delta, f3, FT, WORK, OUT, NB

LEX = {
    'date_fix': r"\b(schedul\w*|dates?|slot|book(?:ed|ing)?|fix(?:ed)?|confirm\w*|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>",
    'admission': r"\b(admit\w*|admission|ward|discharg\w*)\b|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>",
    'payment': r"\b(pay|paid|paying|payment|advance|deposit|upi|gpay|phonepe)\b|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>",
    'ot_preop': r"\b(OT|operation theat\w*|fasting|empty stomach|ana?esthe\w*|pre-?op\w*|ECG|fitness)\b|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>.<native-redacted>|<native-redacted>|<native-redacted>",
    'insurance': r"\b(insurance|insur\w*|polic(?:y|ies)|TPA|mediclaim|health card|ayushman|arogya)\b|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>",   # refute bench2 fix 2
    'preauth': r"\b(pre-?auth\w*|approval|approved|cashless|sanction\w*|claim)\b|<native-redacted>|<native-redacted>|<native-redacted>|<native-redacted>‌?<native-redacted>|<native-redacted>|<native-redacted>‌?<native-redacted>|<native-redacted>",
}
RX = {k: re.compile(v, re.I) for k, v in LEX.items()}


def load(v, eng):
    p = f'{WORK}/scores_{v + "_" if v else ""}{eng}.jsonl'
    if not os.path.exists(p): return pd.DataFrame()
    d = pd.read_json(p, lines=True).drop_duplicates(['episode_id', 'T'], keep='last').set_index(['episode_id', 'T'])
    return d


def row_auc(y, p, g, f, base):
    """benchmark AUC, forest AUC, delta forest-bench on rows."""
    if not 0 < y.sum() < len(y): return None
    return boot_auc(y, p, g), boot_auc(y, f, g), boot_delta(y, p, f, g), boot_auc(y, base, g)


def main():
    B = pd.read_parquet(f'{OUT}/bench_scores.parquet')
    lab = pd.read_parquet(f'{FT}/ft-labels-base/labels.parquet').set_index('episode_id')
    B['dts'] = B.episode_id.map(lab.days_to_surgery)
    INP = {(r['episode_id'], r['T']): r for r in map(json.loads, open(f'{WORK}/inputs.jsonl'))}
    _m = pd.read_csv(os.path.expanduser('~/eta-data/forest/rl/manifest.tsv'), sep='\t', dtype=str).drop_duplicates('key_id')
    TZ0 = set(_m.loc[_m.ts_is_call_day == '0', 'key_id'])
    S = {(v, e): load(v, e) for v in ('', 'lag1', 'consult', 'screen', 'screen2') for e in ('opus', 'jev')}
    ap = f'{WORK}/audit_opus.jsonl'; AU = pd.read_json(ap, lines=True).drop_duplicates(['episode_id', 'T'], keep='last').set_index(['episode_id', 'T'])
    AU['proxy'] = AU.date_or_slot_fixed | AU.admission_or_preop | AU.preauth_or_insurance_filed
    L = [f'# LEAK-AUDIT of benchmarks (b) Jev / (c) Opus, design B (ft-bench, 20 Oct 2026 {pd.Timestamp.now():%H:%M} IST; served by Claude Opus 5.5 on Bedrock)',
         'Ordered by newcat-orch 05:15 and forest-lead. D only. Row numbers only, no ids or text (ids for the refuter: leak_audit_rows.parquet, 0600).', '']
    # ---- 1. lexical scan
    def scan(k):
        r = INP[k]; t = r['text']; return {c: len(x.findall(t)) for c, x in RX.items()}
    L += ['## 1. Lexical scan of the text fed to Opus (crude regex, English + common transliterations; counts of matches)', '']
    d = B[(B.lab == 'ale') & (B['T'] == 3) & B.c_opus.notna()].reset_index(drop=True)
    pos = d[d.y == 1]; neg = d[d.y == 0].sample(len(pos), random_state=20261019)
    sel = pd.concat([pos, neg]).reset_index(drop=True); rows = []
    for i, r in sel.iterrows():
        k = (r.episode_id, 3); m = INP[k]; sc = scan(k)
        rows.append(dict(row=i + 1, episode_id=r.episode_id, y=int(r.y), dts=r.dts, consult_day=m['consult_day'], call_days=','.join(map(str, m['call_days'])),
                         opus_p14=r.c_opus, jev_p14=r.b_jev, opus_booked=bool(r.c_opus_booked), **sc,
                         audit_proxy=bool(AU.at[k, 'proxy']) if k in AU.index else None, audit_main=AU.at[k, 'main'] if k in AU.index else None))
    R = pd.DataFrame(rows); R.to_parquet(f'{OUT}/leak_audit_rows.parquet'); os.chmod(f'{OUT}/leak_audit_rows.parquet', 0o600)
    L += [f'### ale T=3 covered: all {len(pos)} positives + {len(neg)} seeded random negatives (T = 3; every text day < 3 by construction and test)', '',
          '| row | y | days to surgery | consult day | call days | Opus p14 | Jev p14 | ' + ' | '.join(LEX) + ' | Opus audit proxy | Opus audit main |',
          '|---|---|---|---|---|---|---|' + '---|' * len(LEX) + '---|---|']
    for r in R.itertuples():
        L.append(f'| {r.row} | {r.y} | {"" if pd.isna(r.dts) else int(r.dts)} | {"" if r.consult_day is None or pd.isna(r.consult_day) else int(r.consult_day)} | {r.call_days} | '
                 f'{r.opus_p14:.2f} | {"" if pd.isna(r.jev_p14) else f"{r.jev_p14:.2f}"} | ' + ' | '.join(str(getattr(r, c)) for c in LEX) +
                 f' | {r.audit_proxy} | {r.audit_main} |')
    L += ['', 'Share of episodes with >= 1 match, positives vs these negatives: ' + '; '.join(
        f'{c} {np.mean(R[R.y == 1][c] > 0):.0%} vs {np.mean(R[R.y == 0][c] > 0):.0%}' for c in LEX) + '.', '']
    L += ['### All covered episodes, share with >= 1 match (positives / negatives)', '', '| label | T | n | pos | ' + ' | '.join(LEX) + ' |', '|---|---|---|---|' + '---|' * len(LEX)]
    for (lb, T), d in B[B.c_opus.notna()].groupby(['lab', 'T']):
        M = pd.DataFrame([scan((e, T)) for e in d.episode_id]); y = d.y.values
        L.append(f'| {lb} | {T} | {len(d)} | {int(y.sum())} | ' + ' | '.join(f'{np.mean(M[c][y == 1] > 0):.0%} / {np.mean(M[c][y == 0] > 0):.0%}' for c in LEX) + ' |')
    # ---- 2/3. rescoring tables
    L += ['', '## 2. Rescoring (AUC [95% cluster-bootstrap CI]; forest = FTR v2 text_audio on the SAME rows; Δ = forest − benchmark)', '',
          '| label | T | engine | input | rows | n | pos | benchmark AUC | forest AUC | Δ [CI]; P(Δ≤0) |', '|---|---|---|---|---|---|---|---|---|---|']
    for (lb, T), d in B.groupby(['lab', 'T'], sort=False):
        d = d.reset_index(drop=True); key = list(zip(d.episode_id, d['T']))
        hc = np.array([INP[k]['has_consult'] if k in INP else False for k in key]); nc = np.array([INP[k]['n_calls'] if k in INP else 0 for k in key])
        px = np.array([bool(AU.at[k, 'proxy']) if k in AU.index else False for k in key]); au = np.array([k in AU.index for k in key])
        y = d.y.values; g = d.cluster.values; f = d.forest_text_audio.values; b0 = d.forest_base.values
        tz = np.array([k in INP and any(x in TZ0 for x in INP[k]['call_ids']) for k in key])
        lx = np.array([k in INP and INP[k]['chars'] > 0 and any(scan(k)[c] > 0 for c in ('preauth', 'admission', 'ot_preop', 'payment', 'insurance')) for k in key])
        pk = 'p90' if lb == 'h90' else 'p14'
        for eng in ('opus', 'jev'):
            for v, nm in (('', 'original'), ('lag1', 'calls day >= T-1 removed'), ('consult', 'consult only'), ('screen', 'screened text v1 (Addendum 5, renumbered)'), ('screen2', 'screened text v2 (+insurance; layer-8 primary)')):
                D = S[(v, eng)]
                if not len(D): continue
                p = np.array([D.at[k, pk] if k in D.index else np.nan for k in key]); c = ~np.isnan(p)
                subsets = [('covered', c)]
                if v == '':
                    subsets += [('calls only', c & ~hc), ('consult only', c & hc & (nc == 0)), ('consult + calls', c & hc & (nc > 0))]
                    subsets += [('audited, Opus-audit proxy flags removed', c & au & ~px)]
                    subsets += [('no preauth/admission/OT-preop/payment/insurance word', c & ~lx)]
                    subsets += [('without rows using a ts_is_call_day=0 call (fix 8)', c & ~tz)]
                for sn, s in subsets:
                    r = row_auc(y[s], p[s], g[s], f[s], b0[s])
                    if r is None: L.append(f'| {lb} | {T} | {eng} | {nm} | {sn} | {int(s.sum())} | {int(y[s].sum())} | not estimable | | |'); continue
                    ba, fa, dl, _ = r
                    L.append(f'| {lb} | {T} | {eng} | {nm} | {sn} | {int(s.sum())} | {int(y[s].sum())} | {f3(ba)} | {f3(fa)} | {dl[0]:+.3f} [{dl[1]:+.3f}, {dl[2]:+.3f}]; {dl[3]:.2f} |')
    # ---- timing buckets
    L += ['', '## 3. Timing: covered positives by days to surgery (bucket positives vs ALL covered negatives); Opus original input', '',
          '| label | T | bucket | positives | mean Opus p | Opus AUC [CI] | forest AUC [CI] |', '|---|---|---|---|---|---|---|']
    for (lb, T), d in B[B.c_opus.notna()].groupby(['lab', 'T'], sort=False):
        for bn, lo, hi in (('T+1..T+3', T + 1, T + 3), ('T+4..T+7', T + 4, T + 7), ('later', T + 8, 10 ** 6)):
            s = (d.y == 0) | ((d.y == 1) & d.dts.between(lo, hi)); x = d[s]
            if not 0 < x.y.sum() < len(x): L.append(f'| {lb} | {T} | {bn} | 0 | | | |'); continue
            ba = boot_auc(x.y.values, x.c_opus.values, x.cluster.values); fa = boot_auc(x.y.values, x.forest_text_audio.values, x.cluster.values)
            L.append(f'| {lb} | {T} | {bn} | {int(x.y.sum())} | {x[x.y == 1].c_opus.mean():.3f} (neg {x[x.y == 0].c_opus.mean():.3f}) | {f3(ba)} | {f3(fa)} |')
    open(f'{OUT}/LEAK-AUDIT-TABLES.md', 'w').write('\n'.join(L) + '\n'); os.chmod(f'{OUT}/LEAK-AUDIT-TABLES.md', 0o600)
    print('wrote LEAK-AUDIT-TABLES.md')


if __name__ == '__main__':
    main()
