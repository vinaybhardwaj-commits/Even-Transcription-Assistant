"""ft-lexical refute F1: window-length sensitivity for the terms BH-flagged with all text (Ale, h14, h90; R and S corpora only; consults have no window).
matched = each non-converter's items cut at a pseudo surgery day drawn from converters' days_to_surgery (themes.window_cut, seed 20);
lm3 = at risk at day 3, items before day 3. Episode-level Fisher on presence; BH = one family per mode over all flagged terms x labels.
Output (0600): ~/eta-data/forest/ft-lexical/lex_sens.parquet."""
import collections, json, os, re
import numpy as np, pandas as pd
import common as C, themes as TH


def item_terms(it, speaker):
    out = set()
    for role, lg, txt, *_ in it['segs']:
        if speaker not in ('all', 'summary') and role != speaker: continue
        out.update(C.ngrams(C.tokens(txt)))
    return out


def main():
    its = [i for i in C.items() if i['corpus'] in ('R', 'S')]; U = C.units()
    dts = U[U.kind == 'episode'].set_index('unit_id').days_to_surgery
    lex = pd.read_parquet(f'{C.W}/lex.parquet')
    F = lex[(lex['mode'] == 'all') & (lex.q < 0.10) & lex.corpus.isin(['R', 'S'])]
    rows = []
    for (corpus, sp, lab), g in F.groupby(['corpus', 'speaker', 'label']):
        L = C.label_map(U, lab, 'episode'); terms = set(g.term)
        cand = [it for it in its if it['corpus'] == corpus and it['unit_id'] in L and not (sp in ('counsellor', 'patient') and it['role_src'] not in C.ROLE_OK)]
        IT = {it['item_id']: item_terms(it, sp) & terms for it in cand}
        for mode in ('matched', 'lm3'):
            cut = TH.window_cut(mode, L, dts); pres = collections.defaultdict(set); us = set()
            for it in cand:
                u = it['unit_id']
                if mode == 'lm3' and dts.get(u, np.nan) <= 3: continue
                if not it['day_from_rx'] < cut[u]: continue
                us.add(u); pres[u] |= IT[it['item_id']]
            n1 = sum(L[u] for u in us); n0 = len(us) - n1
            for x in g.itertuples():
                a = sum(x.term in pres[u] for u in us if L[u] == 1); b = sum(x.term in pres[u] for u in us if L[u] == 0)
                rows.append(dict(mode=mode, corpus=corpus, speaker=sp, label=lab, term=x.term, a=a, n1=n1, b=b, n0=n0, p=C.fisher(a, n1, b, n0),
                                 admin=bool(C.ADMIN.search(x.term)), q_all=x.q))
    R = pd.DataFrame(rows); R['q'] = np.nan
    for _, g in R.groupby('mode'): R.loc[g.index, 'q'] = C.bh(g.p.values)
    p = f'{C.W}/lex_sens.parquet'; R.to_parquet(p, index=False); os.chmod(p, 0o600)
    print(R.groupby(['mode', 'label']).agg(tests=('p', 'size'), flagged=('q', lambda s: int((s < 0.10).sum())),
                                           flagged_nonadmin=('q', lambda s: int(((s < 0.10) & ~R.loc[s.index, 'admin']).sum()))))


if __name__ == '__main__': main()
