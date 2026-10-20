"""ft-lexical: write LEXICAL.md (summary + tables, < 250 lines) and LEXICAL-TERMS.md (top-25 each way per speaker with snippets) from the work files.
The plain-English summary is code/summary.md (written by the lane after reading the tables). Numbers in the tables come only from the parquet files."""
import json, os, hashlib
import numpy as np, pandas as pd
import common as C, tag as T, themes as TM, names as NM

LBL = {'R': 'call transcripts', 'S': 'call summaries', 'K': 'consults'}
SPK = [('R', 'counsellor', 'Calls: counsellor'), ('R', 'patient', 'Calls: patient side'), ('S', 'summary', 'Call summaries (counsellor-written)'),
       ('K', 'doctor', 'Consults: doctor'), ('K', 'patient', 'Consults: patient side')]


_NAMES = set()
def _load_names():
    for it in C.items():
        if it['corpus'] == 'K': continue
        t = it['segs'][0][2] if it['corpus'] == 'S' else ' '.join(s[2] for s in it['segs'] if s[0] != 'patient')
        n = NM.name_of(t, it['corpus'])
        if n: _NAMES.add(n)


def mask(term, gloss):
    """refute F3: a term that Haiku glosses as a name, or that contains a counsellor first name found in the text, is shown as [name]."""
    g = (gloss or '').lower()
    if ('name' in g and term != 'name') or any(w in _NAMES for w in term.split()): return '[name]'
    return term


def sha(p): return hashlib.sha256(open(p, 'rb').read()).hexdigest()[:12]


def qf(q): return f'{q:.3f}' + (' *' if q < 0.10 else '')


def main():
    lex = pd.read_parquet(f'{C.W}/lex.parquet'); cells = pd.read_parquet(f'{C.W}/lex_cells.parquet')
    th = pd.read_parquet(f'{C.W}/theme_tests.parquet'); jk = pd.read_parquet(f'{C.W}/jev_kappa.parquet')
    ot = pd.read_parquet(f'{C.W}/other_tests.parquet'); ls = pd.read_parquet(f'{C.W}/lex_sens.parquet'); ct = pd.read_parquet(f'{C.W}/counsellors.parquet')
    cc = json.load(open(f'{C.W}/counsellor_cov.json')); qt = json.load(open(f'{C.W}/quotes.json'))
    rep = json.load(open(f'{C.W}/tag_report.json'))
    gl = {(k, x['term']): x for k, v in qt.items() for x in v}
    _load_names(); L = []; A = L.append
    A(open(os.path.join(os.path.dirname(__file__), 'summary.md')).read().rstrip())
    A('')
    # ---- tests ledger
    A('## Comparisons counted (every test; * = q < 0.10). BH families: words = label x mode; themes = mode, all labels pooled (PLAN); 3+4 = label')
    A('| analysis | mode | Ale tests / flagged | h14 | h90 |'); A('|---|---|---|---|---|')
    for nm, df, md, ms in (('1 words/phrases', lex, 'mode', ('all', 'admin_removed')), ('1b flagged words, window check', ls, 'mode', ('matched', 'lm3')),
                           ('2 themes', th, 'mode', TM.MODES)):
        for m in ms:
            s = [f"{len(g)} / {int((g.q < 0.10).sum())}" for l in C.LABELS for g in [df[(df[md] == m) & (df.label == l)]]]
            A(f'| {nm} | {m} | {s[0]} | {s[1]} | {s[2]} |')
    for nm, a in (('3 language', 'language'), ('4 counsellor', 'counsellor')):
        s = [f"{len(g)} / {int((g.q < 0.10).sum())}" for l in C.LABELS for g in [ot[(ot.analysis == a) & (ot.label == l)]]]
        A(f'| {nm} | all | {s[0]} | {s[1]} | {s[2]} |')
    tot = len(lex) + len(ls) + len(th) + len(ot)
    A(f'Total comparisons: {tot}. Analyses 3 and 4 share one BH family per label. Lexical tests are episode-level Fisher (term present), not the Monroe z.')
    A('')
    # ---- 1 lexical
    A('## 1. Words and phrases (Ale, all text; top 8 each way by Monroe z; full top 25 with snippets in LEXICAL-TERMS.md)')
    c = cells[(cells['mode'] == 'all') & (cells.label == 'ale')].set_index(['corpus', 'speaker'])
    A('Cell = term [gloss] units-with-term conv/non, z, q. Units: episodes (calls) or consults.')
    for corpus, sp, name in SPK:
        r = c.loc[(corpus, sp)]
        g = lex[(lex['mode'] == 'all') & (lex.label == 'ale') & (lex.corpus == corpus) & (lex.speaker == sp)]
        A(f'**{name}** ({int(r.n_conv)} converters / {int(r.n_units - r.n_conv)} non; {int(r.n_terms)} terms tested; {int((g.q < 0.10).sum())} flagged)')
        A('| # | more in converters | more in non-converters |'); A('|---|---|---|')
        up, dn = g.nlargest(8, 'z'), g.nsmallest(8, 'z')
        def cell(x):
            gg = gl.get((f'{corpus}:{sp}', x.term), {}).get('gloss', '')
            gs = f' [{gg}]' if gg and gg.lower() != x.term.lower() and not x.term.isascii() else ''
            return f'{mask(x.term, gg)}{gs if mask(x.term, gg) == x.term else ""} {x.n_unit_conv}/{x.n_conv_units} vs {x.n_unit_non}/{x.n_non_units}, z {x.z:.1f}, q {qf(x.q)}'
        for i, (a, b) in enumerate(zip(up.itertuples(), dn.itertuples())):
            A(f'| {i + 1} | {cell(a)} | {cell(b)} |')
    A('')
    A('**Admin talk removed** (segments with insurance / pre-auth / payment / booking / date words deleted). BH-flagged terms that remain:')
    f = lex[(lex['mode'] == 'admin_removed') & (lex.q < 0.10)].sort_values(['label', 'q'])
    for x in f.itertuples():
        A(f'- {x.label} {LBL[x.corpus]} {x.speaker}: "{x.term}" {x.n_unit_conv}/{x.n_conv_units} vs {x.n_unit_non}/{x.n_non_units}, z {x.z:.1f}, q {x.q:.3f}')
    fa = lex[(lex['mode'] == 'all') & (lex.q < 0.10)]
    for l in C.LABELS:
        s = fa[fa.label == l]
        A(f'- {l}, all text: {len(s)} flagged, {int((s.z > 0).sum())} more in converters; {int(s.term.str.contains(C.ADMIN).sum())} of them contain an admin word.')
    zz = lex[lex['mode'] == 'all'][['corpus', 'speaker', 'label', 'term', 'z']]
    S2 = ls[ls.label == 'ale'].merge(zz, on=['corpus', 'speaker', 'label', 'term'])
    S2['keep'] = ((S2.a / S2.n1 - S2.b / S2.n0) * S2.z > 0) & (S2.p < 0.05)
    k = {m: (int(g.keep.sum()), len(g)) for m, g in S2.groupby('mode')}
    up = S2[S2.term == 'up'].set_index('mode')
    A(f'- Window check (refute F1; calls and summaries; converters\' windows stop at surgery): of the {k["matched"][1]} Ale-flagged call/summary terms, '
      f'{k["matched"][0]} keep direction with p < 0.05 when non-converters are cut at a matched pseudo surgery day, and {k["lm3"][0]} at the day-3 landmark '
      f'(at risk at day 3, calls before day 3). "up" (summaries, mostly "follow up") keeps it when matched (p {up.loc["matched", "p"]:.4f}) but not at day 3 '
      f'(p {up.loc["lm3", "p"]:.2f}). These BH q values are conditional on selection, so read p, not q.')
    A('')
    # ---- 2 themes
    A('## 2. Themes (Haiku 5.5, verified quotes; share of units with the theme; Ale; 95% Wilson CI; q = BH)')
    t = th[(th['mode'] == 'all') & (th.label == 'ale')]
    n = {k: (int(g.n1.iloc[0]), int(g.n0.iloc[0])) for k, g in t.groupby('corpus')}
    A(f'Units: calls R {n["R"][0]} conv / {n["R"][1]} non episodes; summaries S {n["S"][0]} / {n["S"][1]}; consults K {n["K"][0]} / {n["K"][1]}.')
    A('| theme | calls conv | calls non | q | summ conv | summ non | q | consult conv | consult non | q |'); A('|---|---|---|---|---|---|---|---|---|---|')
    tt = t.set_index(['theme', 'corpus'])
    def tc(k, c):
        if (k, c) not in tt.index: return '- | - | -'
        x = tt.loc[(k, c)]
        p1, p0 = x.a / x.n1, x.b / x.n0; lo1, hi1 = C.wilson(x.a, x.n1); lo0, hi0 = C.wilson(x.b, x.n0)
        return f'{100 * p1:.0f}% [{100 * lo1:.0f}-{100 * hi1:.0f}] | {100 * p0:.0f}% [{100 * lo0:.0f}-{100 * hi0:.0f}] | {qf(x.q)}'
    for k in T.TH:
        A(f'| {k} | {tc(k, "R")} | {tc(k, "S")} | {tc(k, "K")} |')
    A('')
    A('**Sensitivity, Ale, every theme cell flagged in any mode** (conv vs non %; q in that mode\'s PLAN family). matched = non-converters cut at a pseudo '
      'surgery day drawn from converters (seed 20); lm3 = at risk at day 3, calls before day 3; drop_decided = going_elsewhere / second_opinion quotes '
      'that state an already chosen or completed alternative (the negative outcome itself) do not count.')
    A('| theme (corpus) | ' + ' | '.join(TM.MODES) + ' |'); A('|---|' + '---|' * len(TM.MODES))
    ta = th[th.label == 'ale']; hit = ta[ta.q < 0.10][['theme', 'corpus']].drop_duplicates()
    for x in hit.itertuples():
        cells_ = []
        for m in TM.MODES:
            r = ta[(ta['mode'] == m) & (ta.theme == x.theme) & (ta.corpus == x.corpus)]
            cells_.append('-' if r.empty else f'{100 * r.a.iloc[0] / r.n1.iloc[0]:.0f} vs {100 * r.b.iloc[0] / r.n0.iloc[0]:.0f}, q {qf(r.q.iloc[0])}')
        A(f'| {x.theme} ({LBL[x.corpus]}) | ' + ' | '.join(cells_) + ' |')
    for l in ('h14', 'h90'):
        s = th[(th['mode'] == 'all') & (th.label == l) & (th.q < 0.10)].sort_values('q')
        A(f'- {l}, all text: ' + ('; '.join(f'{x.theme} ({LBL[x.corpus]}) {x.a}/{x.n1} vs {x.b}/{x.n0}, q {x.q:.3f}' for x in s.itertuples()) or 'none flagged'))
    ja = jk[jk.corpus == 'all']
    A(f'- Jev cross-check (jev-latest, 15% random sample, seed 20, n {int(ja.n.max())} items): Cohen kappa Haiku vs Jev(p >= 0.5), pooled: ' +
      ', '.join(f'{x.theme} {x.kappa:.2f}' for x in ja.itertuples()) + '.')
    jc = jk.set_index(['theme', 'corpus'])
    A('- Per corpus, for the flagged cells (refute F5): ' + ', '.join(
        f'{x.theme} ({LBL[x.corpus]}) {jc.loc[(x.theme, x.corpus), "kappa"]:.2f} [Haiku {int(jc.loc[(x.theme, x.corpus), "haiku_pos"])} / Jev {int(jc.loc[(x.theme, x.corpus), "jev_pos"])} yes of {int(jc.loc[(x.theme, x.corpus), "n"])}]'
        for x in hit.itertuples() if (x.theme, x.corpus) in jc.index) + '. Below 0.6 = moderate agreement only.')
    A('')
    # ---- 3 language
    A('## 3. Language and code-mixing (Ale)')
    A('| corpus | measure | converters | non-converters | p | q |'); A('|---|---|---|---|---|---|')
    for x in ot[(ot.analysis == 'language') & (ot.label == 'ale')].itertuples():
        A(f'| {LBL.get(x.corpus, x.corpus)} | {x.what} | {x.conv} | {x.non} | {x.p:.3f} | {qf(x.q)} |')
    for l in ('h14', 'h90'):
        s = ot[(ot.analysis == 'language') & (ot.label == l) & (ot.q < 0.10)]
        A(f'- {l}: ' + ('; '.join(f'{LBL.get(x.corpus)} {x.what} {x.conv} vs {x.non}, q {x.q:.3f}' for x in s.itertuples()) or 'none flagged'))
    A('')
    # ---- 4 counsellor
    A('## 4. Counsellor behaviour (episodes, Ale)')
    A('| measure | converters | non-converters | p | q |'); A('|---|---|---|---|---|')
    for x in ot[(ot.analysis == 'counsellor') & (ot.label == 'ale')].itertuples():
        A(f'| {x.what} | {x.conv} | {x.non} | {x.p:.3f} | {qf(x.q)} |')
    for l in ('h14', 'h90'):
        s = ot[(ot.analysis == 'counsellor') & (ot.label == l) & (ot.q < 0.10)]
        A(f'- {l}: ' + ('; '.join(f'{x.what} {x.conv} vs {x.non}, q {x.q:.3f}' for x in s.itertuples()) or 'none flagged'))
    A(f'Per counsellor: no D-side source carries a Runo agent id. Names were found in the text of only {cc["named_calls"]} of {cc["calls"]} call items (transcripts + summaries) '
      f'({cc["named_episodes"]} episodes, {cc["counsellors"]} names), so this table is a small, biased subsample. Counsellors with >= 3 named episodes; no tests run on it.')
    A('| id | episodes | Ale conv / labelled | median calls < day 3 | median first connected day | median talk share | median questions / min |'); A('|---|---|---|---|---|---|---|')
    for x in ct[ct.n_episodes >= 3].itertuples():
        A(f'| {x.counsellor} | {x.n_episodes} | {x.ale_conv}/{x.n_ale_labelled} | {x.med_calls_t3:.0f} | {x.med_first_conn_day:.1f} | {x.med_talk_share:.2f} | {x.med_q_per_min:.1f} |'.replace('nan', '-'))
    A(f'Other {int((ct.n_episodes < 3).sum())} named counsellors have 1-2 episodes each.')
    A('')
    A(open(os.path.join(os.path.dirname(__file__), 'caveats.md')).read().rstrip())
    A('')
    A(open(os.path.join(os.path.dirname(__file__), 'deviations.md')).read().rstrip())
    A('')
    # ---- files
    A('## Files and sha12')
    out = C.OUT
    ins = {'lex_sens.parquet (work)': f'{C.W}/lex_sens.parquet', 'labels.parquet': C.H('~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet'), 'PLAN.md (pre-registered)': f'{out}/PLAN.md',
           'items.jsonl (work)': f'{C.W}/items.jsonl', 'themes.jsonl (work)': T.OUTF, 'jev.jsonl (work)': f'{C.W}/jev.jsonl',
           'lex.parquet (work)': f'{C.W}/lex.parquet', 'theme_tests.parquet (work)': f'{C.W}/theme_tests.parquet', 'other_tests.parquet (work)': f'{C.W}/other_tests.parquet'}
    A('| file | sha12 |'); A('|---|---|')
    for k, p in ins.items(): A(f'| {k} | {sha(p)} |')
    for f in sorted(os.listdir(f'{out}/code')):
        if f.endswith(('.py', '.md')): A(f'| code/{f} | {sha(f"{out}/code/{f}")} |')
    tin = sum(r['inp'] for r in rep); tout = sum(r['out'] for r in rep)
    nu = len({json.loads(l)['item_id'] for l in open(T.OUTF)})
    A(f'Haiku theme coding: {sum(r["rows"] for r in rep)} coded rows = {nu} unique items (rows re-coded in the retry pass: last row used), {sum(r["fail"] for r in rep)} failed requests, {sum(r["unverified"] for r in rep)} unverified quotes '
      f'(theme set to no), {tin} in / {tout} out tokens. Work files ~/eta-data/forest/ft-lexical/ (0700). Snippets: LEXICAL-TERMS.md.')
    p = f'{out}/LEXICAL.md'; open(p, 'w').write('\n'.join(L) + '\n'); os.chmod(p, 0o600)
    print('LEXICAL.md lines', len(L))
    # ---- appendix: top 25 with snippets
    M = ['# ft-lexical appendix: top 25 terms each way per speaker (Ale, all text), with example snippets',
         'Snippet = up to 4 words either side of the term, from one unit of that group, rendered in English by Haiku 5.5 with names -> [name], numbers -> [#], '
         'places -> [place]. Native-script snippets are translations, NOT verbatim. Counts = units with the term, converters vs non. DESCRIPTIVE, post hoc.', '']
    for corpus, sp, name in SPK:
        g = lex[(lex['mode'] == 'all') & (lex.label == 'ale') & (lex.corpus == corpus) & (lex.speaker == sp)]
        for direc, sub in (('conv', g.nlargest(25, 'z')), ('non', g.nsmallest(25, 'z'))):
            M.append(f'## {name}: more in {"converters" if direc == "conv" else "non-converters"}')
            M.append('| term | gloss | conv units | non units | tokens conv / non | z | q | example |'); M.append('|---|---|---|---|---|---|---|---|')
            for x in sub.itertuples():
                q = gl.get((f'{corpus}:{sp}', x.term), {})
                M.append(f'| {mask(x.term, q.get("gloss", ""))} | {q.get("gloss", "") if mask(x.term, q.get("gloss", "")) == x.term else "person name"} | {x.n_unit_conv}/{x.n_conv_units} | {x.n_unit_non}/{x.n_non_units} | {x.n_tok_conv} / {x.n_tok_non} | '
                         f'{x.z:.1f} | {x.q:.3f} | {q.get("en", "").replace("|", "/")} |')
            M.append('')
    p = f'{out}/LEXICAL-TERMS.md'; open(p, 'w').write('\n'.join(M) + '\n'); os.chmod(p, 0o600)


if __name__ == '__main__': main()
