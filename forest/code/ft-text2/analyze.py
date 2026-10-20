"""ft-text2 analysis (counts only; no text). Usage: analyze.py A | final
  A     -> sample A table (Haiku and Jev vs the Opus reference) to stdout (markdown)
  final -> call_tags_jev.parquet + VERDICTS.json + tables for COVERAGE.md (markdown to stdout). Rules: PLAN.md (pre-registered)."""
import json, os, sys
import numpy as np, pandas as pd
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ft2common as C
from statsmodels.stats.proportion import proportion_confint
from sklearn.metrics import roc_auc_score, cohen_kappa_score

LO, HI, THR = 0.2, 0.8, 0.5


def wil(k, n):
    if n == 0: return 'n/a'
    lo, hi = proportion_confint(k, n, method='wilson')
    return f'{k}/{n} ({k / n:.0%} [{lo:.0%}-{hi:.0%}])'


def wlo(k, n):
    return proportion_confint(k, n, method='wilson')[0] if n else np.nan


def status(h, p):
    """Haiku value vs Jev p -> agree (same side of 0.5) / contradict (Haiku 1 & p < 0.2, or Haiku 0 & p >= 0.8) / unsure (otherwise)."""
    h, p = np.asarray(h), np.asarray(p)
    c = ((h == 1) & (p < LO)) | ((h == 0) & (p >= HI)); a = (h == (p >= THR).astype(int)) & ~c
    return np.where(c, 'contradict', np.where(a, 'agree', 'unsure'))


def ece(p, y, bins=10):
    p, y = np.asarray(p), np.asarray(y); e = 0.0
    idx = np.minimum((p * bins).astype(int), bins - 1)
    for b in range(bins):
        m = idx == b
        if m.any(): e += m.mean() * abs(p[m].mean() - y[m].mean())
    return e


def frame():
    hk = C.haiku_rows()
    J = {(r['src'], r['call_id']): r['p'] for r in C.read_jsonl(f'{C.OUT}/jev.jsonl') if 'p' in r}
    R = {}
    for r in C.read_jsonl(f'{C.OUT}/ref.jsonl'):
        if 'lab' in r: R[(r['src'], r['call_id'])] = r
    rows = []
    for s in hk:
        for c, h in hk[s].items():
            b = C.haiku_bin(h); d = {'src': s, 'call_id': c, 'episode_id': h.get('episode_id'), 'haiku_model': h.get('model')}
            for t in C.TAGS:
                d[f'h_{t}'] = b[t]
                d[f'j_{t}'] = J[(s, c)][t] if (s, c) in J else np.nan
                rr = R.get((s, c))
                d[f'r_{t}'] = (rr['lab'][t] if t in rr['lab'] else np.nan) if rr else np.nan
            d['outcome_revealed_unverified'] = int(bool(h.get('outcome_revealed_unverified')))
            rows.append(d)
    return pd.DataFrame(rows)


def table_A(df):
    A = {(x['src'], x['call_id']) for x in json.load(open(f'{C.OUT}/sample_A.json'))}
    a = df[[k in A for k in zip(df.src, df.call_id)]]
    out, stats = [], {}
    out.append(f"Sample A: {len(a)} calls ({', '.join(f'{s} {int((a.src == s).sum())}' for s in ('S1', 'S2', 'S3'))}); model reference = Opus 5.5 blind labeller, not human.\n")
    out.append('| tag | ref pos | Haiku precision | Haiku recall | Jev AUC | Jev Brier | Jev ECE | Jev precision @0.5 | Jev recall @0.5 | kappa Haiku-Jev | kappa Haiku-ref | kappa Jev-ref | Haiku-Jev agree / contradict / unsure |')
    out.append('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for t in C.TAGS:
        x = a[a[f'r_{t}'].notna() & a[f'j_{t}'].notna()]
        y = x[f'r_{t}'].astype(int).values; h = x[f'h_{t}'].values; p = x[f'j_{t}'].values; jb = (p >= THR).astype(int)
        npos = int(y.sum())
        auc = roc_auc_score(y, p) if 0 < npos < len(y) else np.nan
        br = float(np.mean((p - y) ** 2)); ec = ece(p, y)
        st = {'n': len(y), 'ref_pos': npos, 'h_tp': int((h & y).sum()), 'h_pos': int(h.sum()), 'j_tp': int((jb & y).sum()), 'j_pos': int(jb.sum()),
              'auc': auc, 'brier': br, 'ece': ec, 'few': npos < 5}
        kk = lambda u, v: cohen_kappa_score(u, v) if len(set(u)) > 1 or len(set(v)) > 1 else np.nan
        st.update(k_hj=kk(h, jb), k_hr=kk(h, y), k_jr=kk(jb, y))
        stt = status(h, p); st.update({k: int((stt == k).sum()) for k in ('agree', 'contradict', 'unsure')})
        stats[t] = st
        f = ' (too few positives)' if npos < 5 else ''
        aus = f'{auc:.2f}' if auc == auc else 'n/a'
        out.append(f"| {t} | {npos}/{len(y)}{f} | {wil(st['h_tp'], st['h_pos'])} | {wil(st['h_tp'], npos)} | {aus} | {br:.3f} | {ec:.3f} | "
                   f"{wil(st['j_tp'], st['j_pos'])} | {wil(st['j_tp'], npos)} | {st['k_hj']:.2f} | {st['k_hr']:.2f} | {st['k_jr']:.2f} | {st['agree']} / {st['contradict']} / {st['unsure']} |")
    out.append('')
    out.append('Per source on A, pooled over the 16 tags (call x tag cells with a model reference): share where Haiku = reference, Jev(>=0.5) = reference.')
    out.append('')
    out.append('| source | calls | cells | Haiku = model ref | Jev = model ref |')
    out.append('|---|---|---|---|---|')
    for s_ in ('S1', 'S2', 'S3'):
        x = a[a.src == s_]; hc = jc = n = 0
        for t in C.TAGS:
            z = x[x[f'r_{t}'].notna() & x[f'j_{t}'].notna()]; n += len(z)
            hc += int((z[f'h_{t}'] == z[f'r_{t}']).sum()); jc += int(((z[f'j_{t}'] >= THR).astype(int) == z[f'r_{t}']).sum())
        out.append(f'| {s_} | {len(x)} | {n} | {wil(hc, n)} | {wil(jc, n)} |')
    return '\n'.join(out), stats


def table_B(df):
    out, stats = [], {}
    out.append('| tag | source | calls | Haiku pos | Jev pos (>=0.5) | kappa | Haiku-pos with Jev p<0.2 | Haiku-neg with Jev p>=0.8 |')
    out.append('|---|---|---|---|---|---|---|---|')
    for t in C.TAGS:
        for s in ('S1', 'S2', 'S3', 'all'):
            x = df[df[f'j_{t}'].notna()] if s == 'all' else df[(df.src == s) & df[f'j_{t}'].notna()]
            if not len(x): continue
            h = x[f'h_{t}'].values; p = x[f'j_{t}'].values; jb = (p >= THR).astype(int)
            k = cohen_kappa_score(h, jb) if len(set(h)) > 1 or len(set(jb)) > 1 else np.nan
            hpl = int(((h == 1) & (p < LO)).sum()); hnh = int(((h == 0) & (p >= HI)).sum())
            stats[(t, s)] = {'n': len(x), 'h_pos': int(h.sum()), 'j_pos': int(jb.sum()), 'kappa': k, 'hpos_jlow': hpl, 'hneg_jhigh': hnh}
            out.append(f"| {t} | {s} | {len(x)} | {int(h.sum())} | {int(jb.sum())} | {k:.2f} | {wil(hpl, int(h.sum()))} | {wil(hnh, int((h == 0).sum()))} |")
    return '\n'.join(out), stats


def table_C(df):
    p = f'{C.OUT}/sample_C_draw.json'
    if not os.path.exists(p): return 'Sample C not drawn.', {}
    D = pd.DataFrame(json.load(open(p)))
    m = df.set_index(['src', 'call_id'])
    out, stats = [], {}
    out.append('| tag | direction | contradictions (all calls) | arbitrated | model reference agrees with Jev | model reference agrees with Haiku | model reference unverified/missing |')
    out.append('|---|---|---|---|---|---|---|')
    for t in C.TAGS:
        for d in ('hpos_jlow', 'hneg_jhigh'):
            x = D[(D.tag == t) & (D.dir == d)]
            ncand = int(x.n_cand.iloc[0]) if len(x) else 0
            r = [m.loc[(s, c), f'r_{t}'] for s, c in zip(x.src, x.call_id)]
            r = [v for v in r if v == v]
            # hpos_jlow: Haiku says 1, Jev says 0 -> reference 0 = Jev right; hneg_jhigh: Haiku 0, Jev 1 -> reference 1 = Jev right
            jr = sum(1 for v in r if (v == 0 if d == 'hpos_jlow' else v == 1)); hr = len(r) - jr
            stats[(t, d)] = {'n_cand': ncand, 'arb': len(r), 'jev_right': jr, 'haiku_right': hr}
            if ncand: out.append(f'| {t} | {d} | {ncand} | {len(r)} | {jr} | {hr} | {len(x) - len(r)} |')
    return '\n'.join(out), stats


def verdicts(sA, sB, sC):
    V = {}
    for t in C.TAGS:
        b = sB.get((t, 'all'), {}); a = sA.get(t, {}); why = []
        c1 = sC.get((t, 'hpos_jlow'), {'arb': 0, 'jev_right': 0}); c2 = sC.get((t, 'hneg_jhigh'), {'arb': 0, 'jev_right': 0})
        drop = (c1['arb'] >= 5 and c1['jev_right'] > c1['arb'] / 2 and b.get('h_pos', 0) and b['hpos_jlow'] / b['h_pos'] >= 0.2)
        if drop: why.append(f"Haiku over-tags: {b['hpos_jlow']}/{b['h_pos']} Haiku positives have Jev p<0.2; model reference sides with Jev in {c1['jev_right']}/{c1['arb']}")
        if b.get('kappa', np.nan) < 0.4: why.append(f"kappa {b['kappa']:.2f} < 0.4")
        if a and a['h_pos'] >= 5 and wlo(a['h_tp'], a['h_pos']) < 0.5: why.append(f"Haiku precision on A {a['h_tp']}/{a['h_pos']}, Wilson LB < 0.5")
        if c2['arb'] >= 5 and c2['jev_right'] > c2['arb'] / 2: why.append(f"Haiku under-tags: model reference sides with Jev on {c2['jev_right']}/{c2['arb']} Haiku-negative contradictions")
        if a and a['ece'] > 0.15: why.append(f"Jev ECE on A {a['ece']:.2f} > 0.15 (Jev verdict not calibrated enough to drive a drop)")
        jev_ok = not (a and a['ece'] > 0.15)
        V[t] = {'verdict': 'DROP' if drop and jev_ok else ('FLAG' if why else 'KEEP'), 'why': why}
    return V


def final(df):
    tA, sA = table_A(df); tB, sB = table_B(df); tC, sC = table_C(df); V = verdicts(sA, sB, sC)
    for t in C.TAGS:
        df[f'js_{t}'] = np.where(df[f'j_{t}'].notna(), status(df[f'h_{t}'].values, df[f'j_{t}'].fillna(0.5).values), 'no_jev')
        df[f'hf_{t}'] = ((df[f'h_{t}'] == 1) & ~(df[f'j_{t}'] < LO)).astype(int)   # Haiku AND NOT Jev-contradicted (no Jev answer -> Haiku value)
    # outcome_revealed is the leak screen: a Jev contradiction never removes a Haiku 'revealed'; Jev p >= 0.8 ADDS one (conservative)
    df['hf_outcome_revealed'] = ((df.h_outcome_revealed == 1) | (df.j_outcome_revealed >= HI)).astype(int)
    df['leak_union'] = ((df.h_outcome_revealed == 1) | (df.outcome_revealed_unverified == 1) | (df.j_outcome_revealed >= HI)).astype(int)
    p = f'{C.OUT}/call_tags_jev.parquet'; df.to_parquet(p, index=False); os.chmod(p, 0o600)
    json.dump(V, open(f'{C.OUT}/VERDICTS.json', 'w'), indent=1); os.chmod(f'{C.OUT}/VERDICTS.json', 0o600)
    print('## A. Labelled sample (model model reference = Opus 5.5 blind)\n'); print(tA)
    print('\n## B. Haiku vs Jev on all tagged calls\n'); print(tB)
    print('\n## C. Arbitration of contradictions (model reference = Opus 5.5 blind)\n'); print(tC)
    A_ = {(x['src'], x['call_id']) for x in json.load(open(f'{C.OUT}/sample_A.json'))}
    a = df[[k in A_ for k in zip(df.src, df.call_id)]]
    print('\n## D. Raw Haiku vs Jev-filtered Haiku (contradicted positives set to 0; for outcome_revealed: Haiku OR Jev p >= 0.8), on sample A against the model reference (information only; not a pre-registered rule)\n')
    print('| tag | raw precision | raw recall | filtered precision | filtered recall |\n|---|---|---|---|---|')
    for t in C.TAGS:
        z = a[a[f'r_{t}'].notna()]; y = z[f'r_{t}'].astype(int); h = z[f'h_{t}']; f = z[f'hf_{t}']
        print(f"| {t} | {wil(int((h & y).sum()), int(h.sum()))} | {wil(int((h & y).sum()), int(y.sum()))} | {wil(int((f & y).sum()), int(f.sum()))} | {wil(int((f & y).sum()), int(y.sum()))} |")
    print('\n## Verdicts (PLAN.md rules)\n\n| tag | verdict | reasons |\n|---|---|---|')
    for t, v in V.items(): print(f"| {t} | {v['verdict']} | {'; '.join(v['why']) or '-'} |")
    x = df[df.j_outcome_revealed.notna()]; base = (x.h_outcome_revealed | x.outcome_revealed_unverified).astype(bool)
    print(f"\nleak_union: Haiku/unverified revealed {int(base.sum())} calls; union with Jev p>=0.8 {int(x.leak_union.sum())} (+{int(x.leak_union.sum() - base.sum())}), of {len(x)} Jev-checked calls.")
    print(f"\nJev coverage: {int(df.j_outcome_revealed.notna().sum())}/{len(df)} Haiku-tagged calls have Jev answers; by source " +
          ', '.join(f"{s} {int(df[(df.src == s)].j_outcome_revealed.notna().sum())}/{int((df.src == s).sum())}" for s in ('S1', 'S2', 'S3')))


if __name__ == '__main__':
    df = frame()
    if sys.argv[1] == 'A':
        print(table_A(df)[0])
    else:
        final(df)
