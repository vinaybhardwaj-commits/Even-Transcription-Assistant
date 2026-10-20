"""ft-lexical analyses 3 (language, code-mixing) and 4 (counsellor behaviour). Episode / consult level. Ids and numbers only.
Output (0600): ~/eta-data/forest/ft-lexical/other_tests.parquet (one row per comparison, every comparison counted) + counsellor table."""
import collections, json, os, re, warnings
warnings.filterwarnings('ignore')
import numpy as np, pandas as pd
from scipy import stats
import common as C, names

LAT = re.compile(r'[A-Za-z]'); IND = re.compile(r'[<native-redacted>-<native-redacted>]')
LANGS = ['en-IN', 'kn-IN', 'hi-IN', 'ta-IN', 'te-IN', 'ml-IN']


def seg_mix(segs, roles=None):
    s = [x for x in segs if x[2].strip() and (roles is None or x[0] in roles)]
    if not s: return np.nan, np.nan, None
    L = collections.Counter(); dur = collections.Counter()
    for r, lg, t, a, b in s: dur[lg or 'unk'] += max(b - a, 0.01)
    main = dur.most_common(1)[0][0]
    script = sum(1 for x in s if LAT.search(x[2]) and IND.search(x[2])) / len(s)
    tok = [w for x in s for w in C.tokens(x[2])]
    lat = sum(1 for w in tok if LAT.search(w)); ind = sum(1 for w in tok if IND.search(w))
    minority = min(lat, ind) / (lat + ind) if lat + ind else np.nan     # 0 = one script only, 0.5 = even mix
    return minority, script, main


def main():
    its = C.items(); U = C.units(); T = []
    E = {}
    # ---- per-episode call-transcript language
    ep = collections.defaultdict(list)
    for it in its:
        if it['corpus'] == 'R': ep[it['unit_id']].append(it)
        if it['corpus'] == 'K':
            o, sc, m = seg_mix(it['segs'])
            E[it['unit_id']] = dict(main=it['consult_lang'], mix_lang=o, mix_script=sc, en_share=it['lang_en_share'], corpus='K')
    CL = {}
    for f in os.listdir(C.H('~/eta-data/forest/rl/stt')):
        j = json.load(open(C.H(f'~/eta-data/forest/rl/stt/{f}')))
        CL[f[:-5]] = (j.get('result', {}).get('0.json') or {}).get('language_code')
    for u, L in ep.items():
        allsegs = [s for it in L for s in it['segs']]
        o, sc, _ = seg_mix(allsegs)
        m = collections.Counter(CL.get(it['item_id']) for it in L).most_common(1)[0][0]
        E[u] = dict(main=m, mix_lang=o, mix_script=sc, corpus='R',
                    en_share=np.nan)
    E = pd.DataFrame.from_dict(E, orient='index')
    lang_rows = []
    for corpus, kind in (('R', 'episode'), ('K', 'consult')):
        for lab in C.LABELS:
            L = C.label_map(U, lab, kind); e = E[(E.corpus == corpus) & E.index.isin(L)].copy()
            if not len(e) or sum(L[u] for u in e.index) < 3: continue
            e['y'] = [L[u] for u in e.index]; n1, n0 = int(e.y.sum()), int((1 - e.y).sum())
            for lg in LANGS:
                a = int(((e.main == lg) & (e.y == 1)).sum()); b = int(((e.main == lg) & (e.y == 0)).sum())
                if a + b < 5: continue
                T.append(dict(analysis='language', corpus=corpus, label=lab, what=f'main language {lg}', conv=C.pct(a, n1), non=C.pct(b, n0), p=C.fisher(a, n1, b, n0)))
            for col, nm in (('mix_lang', 'code-mix: minority-script share of words (0 = one script, 0.5 = even Latin/Indic mix)'),
                            ('mix_script', 'code-mix: share of segments with both Latin and Indic script'), ('en_share', 'English share of speech (Sarvam segment language)')):
                x1, x0 = e.loc[e.y == 1, col].dropna(), e.loc[e.y == 0, col].dropna()
                if len(x1) < 3: continue
                T.append(dict(analysis='language', corpus=corpus, label=lab, what=nm, conv=f'median {x1.median():.2f}, mean {x1.mean():.2f} (n {len(x1)})',
                              non=f'median {x0.median():.2f}, mean {x0.mean():.2f} (n {len(x0)})',
                              p=stats.mannwhitneyu(x1, x0).pvalue))
    # ---- counsellor behaviour (episodes, call system)
    cd = pd.read_parquet(f'{C.H("~/oc/forest-lead/ft/out")}/ft-calltext/calls_D.parquet')
    lab_ep = U[U.kind == 'episode'].set_index('unit_id')
    pc = pd.read_parquet(f'{C.H("~/oc/forest-lead/ft/out")}/ft-engines/engine_calls_percall.parquet').set_index('call_id')
    beh = {}
    for u in lab_ep.index:
        beh[u] = {}
    g = cd.groupby('episode_id')
    dts = lab_ep.days_to_surgery
    for u in lab_ep.index:
        r = beh[u]
        if u in g.groups:
            c = g.get_group(u)
            r['n_calls_t3'] = int((c.day_from_rx < 3).sum())
            r['n_conn_t3'] = int(((c.day_from_rx < 3) & (c.duration > 0)).sum())
            cc = c[c.duration > 0]
            r['first_conn_day'] = float(cc.day_from_rx.min()) if len(cc) else np.nan
        else:
            r['n_calls_t3'] = 0; r['n_conn_t3'] = 0; r['first_conn_day'] = np.nan
    # talk share and question rate from R transcripts (role lexicon/lexicon_weak only)
    qs = collections.defaultdict(lambda: [0, 0.0]); ts = collections.defaultdict(list)
    for it in its:
        if it['corpus'] != 'R' or it['role_src'] not in C.ROLE_OK: continue
        u = it['unit_id']
        for r, lg, t, a, b in it['segs']:
            if r == 'counsellor': qs[u][0] += t.count('?'); qs[u][1] += max(b - a, 0) / 60
        ts[u].append(pc.counsellor_talk_share.get(it['item_id'], np.nan))
    for u in beh:
        beh[u]['counsellor_talk_share'] = np.nanmean(ts[u]) if ts.get(u) else np.nan
        beh[u]['counsellor_q_per_min'] = qs[u][0] / qs[u][1] if qs.get(u) and qs[u][1] > 0.2 else np.nan
    B = pd.DataFrame.from_dict(beh, orient='index')
    for lab in C.LABELS:
        L = C.label_map(U, lab, 'episode'); b = B[B.index.isin(L)].copy(); b['y'] = [L[u] for u in b.index]
        # at-risk rule: count / first-call metrics only for episodes with no surgery by day 3 (T=3 landmark), so converters are not cut short
        ar = b[~(dts.reindex(b.index) <= 3)]
        for col, nm, d in (('n_calls_t3', 'window calls before day 3 (at-risk at day 3)', ar), ('n_conn_t3', 'connected calls before day 3 (at-risk at day 3)', ar),
                           ('first_conn_day', 'days Rx -> first connected call (episodes with one, at-risk at day 3)', ar),
                           ('counsellor_talk_share', 'counsellor talk share (recorded calls, lexicon roles)', b),
                           ('counsellor_q_per_min', 'counsellor questions per minute (recorded calls, lexicon roles)', b)):
            x1, x0 = d.loc[d.y == 1, col].dropna(), d.loc[d.y == 0, col].dropna()
            if len(x1) < 3: continue
            T.append(dict(analysis='counsellor', corpus='calls', label=lab, what=nm,
                          conv=f'median {x1.median():.2f}, mean {x1.mean():.2f} (n {len(x1)})', non=f'median {x0.median():.2f}, mean {x0.mean():.2f} (n {len(x0)})',
                          p=stats.mannwhitneyu(x1, x0).pvalue))
        a = int(((ar.n_conn_t3 > 0) & (ar.y == 1)).sum()); bb = int(((ar.n_conn_t3 > 0) & (ar.y == 0)).sum())
        n1, n0 = int(ar.y.sum()), int((1 - ar.y).sum())
        T.append(dict(analysis='counsellor', corpus='calls', label=lab, what='>= 1 connected call before day 3 (at-risk at day 3)', conv=C.pct(a, n1), non=C.pct(bb, n0), p=C.fisher(a, n1, bb, n0)))
    T = pd.DataFrame(T)
    T['q'] = np.nan
    for l, g2 in T.groupby('label'): T.loc[g2.index, 'q'] = C.bh(g2.p.values)
    p = f'{C.W}/other_tests.parquet'; T.to_parquet(p, index=False); os.chmod(p, 0o600)
    # ---- counsellor ids (names found in text only; C1..Cn by episode count)
    nm = collections.defaultdict(collections.Counter); ncall = 0; nnamed = 0
    for it in its:
        if it['corpus'] == 'K': continue
        ncall += 1
        t = it['segs'][0][2] if it['corpus'] == 'S' else ' '.join(s[2] for s in it['segs'] if s[0] != 'patient')
        x = names.name_of(t, it['corpus'])
        if x: nm[it['unit_id']][x] += 1; nnamed += 1
    epn = {u: c.most_common(1)[0][0] for u, c in nm.items()}
    order = [n for n, _ in collections.Counter(epn.values()).most_common()]
    cid = {n: f'C{i + 1}' for i, n in enumerate(order)}
    L = C.label_map(U, 'ale', 'episode')
    rows = []
    for n in order:
        us = [u for u, v in epn.items() if v == n]; ul = [u for u in us if u in L]
        rows.append(dict(counsellor=cid[n], n_episodes=len(us), n_ale_labelled=len(ul), ale_conv=sum(L[u] for u in ul),
                         med_calls_t3=B.loc[us, 'n_calls_t3'].median(), med_first_conn_day=B.loc[us, 'first_conn_day'].median(),
                         med_talk_share=B.loc[us, 'counsellor_talk_share'].median(), med_q_per_min=B.loc[us, 'counsellor_q_per_min'].median()))
    CT = pd.DataFrame(rows); CT.attrs = {}
    p = f'{C.W}/counsellors.parquet'; CT.to_parquet(p, index=False); os.chmod(p, 0o600)
    json.dump(dict(calls=ncall, named_calls=nnamed, named_episodes=len(epn), counsellors=len(order)), open(f'{C.W}/counsellor_cov.json', 'w'))
    pd.set_option('display.width', 250); pd.set_option('display.max_colwidth', 70)
    print(T.to_string()); print(CT.to_string()); print('named calls', nnamed, '/', ncall, 'episodes', len(epn))


if __name__ == '__main__': main()
