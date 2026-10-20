"""ft-lexical analysis 1: weighted log-odds with informative Dirichlet prior (Monroe, Colaresi & Quinn 2008) per corpus x speaker, converters vs not.
Prior: alpha_w = alpha0 * (count_w / N) over that corpus x speaker, alpha0 = mean group token count (PLAN.md).
Test into BH: episode/consult-level Fisher exact on presence (term in >= 1 of the unit's texts); every term with >= 5 units is one test.
BH family = one label x one mode (all text / admin removed), across every corpus x speaker group.
Output (0600, work dir, has raw terms): lex.parquet. Ids/counts only on stdout."""
import collections, sys, os
import numpy as np, pandas as pd
from scipy import stats
import common as C

MIN_UNITS = 5
GROUPS = [('R', 'counsellor'), ('R', 'patient'), ('R', 'all'), ('S', 'summary'), ('K', 'doctor'), ('K', 'patient'), ('K', 'all')]


def unit_terms(its, corpus, speaker, admin_removed):
    """unit_id -> Counter of n-grams."""
    out = collections.defaultdict(collections.Counter)
    for it in its:
        if it['corpus'] != corpus: continue
        if speaker in ('counsellor', 'patient') and corpus == 'R' and it['role_src'] not in C.ROLE_OK: continue
        if speaker in ('doctor', 'patient') and corpus == 'K' and not C.k_role_ok(it): continue
        for role, lg, txt, *_ in it['segs']:
            if speaker not in ('all', 'summary') and role != speaker: continue
            if corpus == 'S':
                parts = [s for s in __import__('re').split(r'(?<=[.!?])\s+', txt) if not (admin_removed and C.ADMIN.search(s))]
            else:
                parts = [] if (admin_removed and C.ADMIN.search(txt)) else [txt]
            for p in parts: out[it['unit_id']].update(C.ngrams(C.tokens(p)))
        out[it['unit_id']]   # unit present even if empty
    return out


def monroe(y1, y0, a):
    n1, n0, a0 = y1.sum(), y0.sum(), a.sum()
    d = np.log((y1 + a) / (n1 + a0 - y1 - a)) - np.log((y0 + a) / (n0 + a0 - y0 - a))
    return d, d / np.sqrt(1 / (y1 + a) + 1 / (y0 + a))


def one(UT, lab):
    ids = [u for u in UT if u in lab]
    pos = [u for u in ids if lab[u] == 1]; neg = [u for u in ids if lab[u] == 0]
    if len(pos) < 3: return None, (len(ids), len(pos))
    c1, c0, d1, d0 = collections.Counter(), collections.Counter(), collections.Counter(), collections.Counter()
    for u in pos: c1.update(UT[u]); d1.update(UT[u].keys())
    for u in neg: c0.update(UT[u]); d0.update(UT[u].keys())
    voc = [w for w in set(d1) | set(d0) if d1[w] + d0[w] >= MIN_UNITS]
    y1 = np.array([c1[w] for w in voc], float); y0 = np.array([c0[w] for w in voc], float)
    tot = y1 + y0
    # prior over the filtered vocabulary, alpha0 = mean group token count
    a0 = (y1.sum() + y0.sum()) / 2; a = a0 * tot / tot.sum()
    delta, z = monroe(y1, y0, a)
    e1 = np.array([d1[w] for w in voc]); e0 = np.array([d0[w] for w in voc])
    n1, n0 = len(pos), len(neg)
    # Fisher (two-sided) via hypergeometric, vectorised over terms
    K = e1 + e0; N = n1 + n0
    p = np.array([stats.fisher_exact([[x, n1 - x], [k - x, n0 - (k - x)]])[1] for x, k in zip(e1, K)])
    df = pd.DataFrame(dict(term=voc, n_tok_conv=y1.astype(int), n_tok_non=y0.astype(int), n_unit_conv=e1, n_unit_non=e0, delta=delta, z=z, p=p))
    df['n_conv_units'] = n1; df['n_non_units'] = n0; df['ngram'] = df.term.str.count(' ') + 1
    return df, (len(ids), n1)


def main():
    its = C.items(); U = C.units(); rows = []; cells = []
    for mode in ('all', 'admin_removed'):
        for corpus, sp in GROUPS:
            UT = unit_terms(its, corpus, sp, mode == 'admin_removed')
            kind = 'consult' if corpus == 'K' else 'episode'
            for lab in C.LABELS:
                L = C.label_map(U, lab, kind)
                df, (n, npos) = one(UT, L)
                cells.append(dict(mode=mode, corpus=corpus, speaker=sp, label=lab, n_units=n, n_conv=npos, n_terms=0 if df is None else len(df)))
                if df is None: continue
                rows.append(df.assign(mode=mode, corpus=corpus, speaker=sp, label=lab))
    R = pd.concat(rows, ignore_index=True)
    R['q'] = np.nan
    for (m, l), g in R.groupby(['mode', 'label']): R.loc[g.index, 'q'] = C.bh(g.p.values)
    p = f'{C.W}/lex.parquet'; R.to_parquet(p, index=False); os.chmod(p, 0o600)
    cl = pd.DataFrame(cells); p = f'{C.W}/lex_cells.parquet'; cl.to_parquet(p, index=False); os.chmod(p, 0o600)
    print(cl.to_string())
    print(R.groupby(['mode', 'label']).agg(tests=('p', 'size'), flagged=('q', lambda s: int((s < 0.10).sum()))).to_string())


if __name__ == '__main__': main()
