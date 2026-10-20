"""ft-lexical analysis 2: theme rates converters vs non (unit = episode for R/S, consult for K; theme present in >= 1 eligible item of the unit).
Wilson 95% CIs, Fisher exact p, BH per mode over every theme x corpus x label test (PLAN family; q_label = per mode x label). Modes: see MODES. Mode admin_removed: a theme counts only if its verified quote has no
admin word (common.ADMIN); cost_quoted / insurance_cashless are not tested in that mode. Jev cross-check: per-theme Cohen kappa (Haiku vs Jev p >= 0.5).
Output (0600): ~/eta-data/forest/ft-lexical/theme_tests.parquet, jev_kappa.parquet."""
import collections, json, os, re
import numpy as np, pandas as pd
import common as C, tag as T

ADMIN_TH = {'cost_quoted', 'insurance_cashless'}
# modes: all | admin_removed | matched (refute F1: each non-converter's calls cut at a pseudo surgery day drawn from converters' days_to_surgery, seed 20) |
# lm3 (landmark: at risk at day 3, items before day 3) | drop_decided (refute F2: going_elsewhere / second_opinion quotes stating an already made or
# completed alternative do not count)
MODES = ('all', 'admin_removed', 'matched', 'lm3', 'drop_decided')
DECIDED_TH = {'going_elsewhere', 'second_opinion'}
DECIDED = re.compile(r"already|decided|decide to go|admitted|got (it )?done|done (it )?(at|in|there|elsewhere)|underwent|operated|has gone|have gone|went (to|for)|"
                     r"completed|booked|scheduled|took (the )?(treatment|surgery)|undergone|finali[sz]ed|chose|opted|joined|discharged", re.I)


def window_cut(mode, L, dts):
    """unit -> exclusive day cut. Converters: their own surgery day (items are already before it). Non-converters (matched): a converter day drawn at random."""
    if mode == 'lm3': return {u: 3 for u in L}
    if mode != 'matched': return {}
    conv = sorted(dts[[u for u in L if L[u] == 1 and u in dts.index]].dropna().tolist())
    rng = np.random.default_rng(20); out = {}
    for u in sorted(L):
        out[u] = dts.get(u) if L[u] == 1 else rng.choice(conv)
    return out


def kappa(a, b):
    a, b = np.asarray(a), np.asarray(b); po = (a == b).mean(); pe = a.mean() * b.mean() + (1 - a.mean()) * (1 - b.mean())
    return (po - pe) / (1 - pe) if pe < 1 else np.nan


def main():
    th = {}
    for l in open(T.OUTF):
        r = json.loads(l); th[r['item_id']] = r
    U = C.units(); rows = []
    day = {json.loads(l)['item_id']: json.loads(l).get('day_from_rx') for l in open(f'{C.W}/items.jsonl')}
    dts = U[U.kind == 'episode'].set_index('unit_id').days_to_surgery
    for mode in MODES:
        for corpus in ('R', 'S', 'K'):
            if corpus == 'K' and mode in ('matched', 'lm3'): continue      # consult = day 0, no window
            kind = 'consult' if corpus == 'K' else 'episode'
            for lab in C.LABELS:
                L = C.label_map(U, lab, kind)
                cut = window_cut(mode, L, dts) if kind == 'episode' else {}
                pres = collections.defaultdict(lambda: collections.defaultdict(int)); us = set()
                for r in th.values():
                    u = r['unit_id']
                    if r['corpus'] != corpus or u not in L: continue
                    if mode == 'lm3' and dts.get(u, np.nan) <= 3: continue
                    if mode in ('matched', 'lm3') and not day[r['item_id']] < cut[u]: continue
                    us.add(u)
                    for k, v in r['themes'].items():
                        q = r['quotes'].get(k, '')
                        if not v: continue
                        if mode == 'admin_removed' and C.ADMIN.search(q): continue
                        if mode == 'drop_decided' and k in DECIDED_TH and DECIDED.search(q): continue
                        pres[u][k] = 1
                n1 = sum(L[u] for u in us); n0 = len(us) - n1
                if n1 < 3: continue
                for k in T.TH:
                    if mode == 'admin_removed' and k in ADMIN_TH: continue
                    if corpus == 'K' and k == 'callback_prompt': continue
                    a = sum(pres[u][k] for u in us if L[u] == 1); b = sum(pres[u][k] for u in us if L[u] == 0)
                    rows.append(dict(mode=mode, corpus=corpus, label=lab, theme=k, a=a, n1=n1, b=b, n0=n0, conv=C.pct(a, n1), non=C.pct(b, n0),
                                     p=C.fisher(a, n1, b, n0)))
    R = pd.DataFrame(rows)
    # PLAN family (primary, refute F4): one BH per mode over every theme x corpus x label test; q_label = per mode x label (first draft's family)
    R['q'] = np.nan; R['q_label'] = np.nan
    for _, g in R.groupby('mode'): R.loc[g.index, 'q'] = C.bh(g.p.values)
    for _, g in R.groupby(['mode', 'label']): R.loc[g.index, 'q_label'] = C.bh(g.p.values)
    p = f'{C.W}/theme_tests.parquet'; R.to_parquet(p, index=False); os.chmod(p, 0o600)
    # Jev kappa on the sample
    J = [json.loads(l) for l in open(f'{C.W}/jev.jsonl')]; J = {j['item_id']: j for j in J if 'p' in j}
    ks = []
    for k in T.TH:
        ids = [i for i in J if i in th and not (th[i]['corpus'] == 'K' and k == 'callback_prompt')]
        h = [th[i]['themes'][k] for i in ids]; j = [int(J[i]['p'][k] >= 0.5) for i in ids]
        for c in ('R', 'S', 'K'):
            ic = [i for i in ids if th[i]['corpus'] == c]
            if not ic: continue
            hc = [th[i]['themes'][k] for i in ic]; jc = [int(J[i]['p'][k] >= 0.5) for i in ic]
            ks.append(dict(theme=k, corpus=c, n=len(ic), haiku_pos=sum(hc), jev_pos=sum(jc), agree=float(np.mean(np.array(hc) == np.array(jc))), kappa=kappa(hc, jc)))
        ks.append(dict(theme=k, corpus='all', n=len(ids), haiku_pos=sum(h), jev_pos=sum(j), agree=float(np.mean(np.array(h) == np.array(j))), kappa=kappa(h, j)))
    K = pd.DataFrame(ks); p = f'{C.W}/jev_kappa.parquet'; K.to_parquet(p, index=False); os.chmod(p, 0o600)
    pd.set_option('display.width', 250)
    print(R[(R.label == 'ale')].to_string()); print(K.to_string())
    print(R.groupby(['mode']).agg(tests=('p', 'size'), flagged=('q', lambda s: int((s < 0.10).sum()))))
    print('coded items', collections.Counter(r['corpus'] for r in th.values()), 'jev sample coded', sum(1 for i in J if i in th))


if __name__ == '__main__': main()
