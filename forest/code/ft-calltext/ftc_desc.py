# ft-calltext descriptive tables (19 Oct 2026). D split, cohort P (hash-only F1 ambiguity dropped), Rx >= 2026-01-01, label final.
# Per episode: any verified tag over its window calls that have a summary (days 0..14 after Rx, before surgery day, outcome-revealing calls
# dropped). Objection share among converted vs not, overall and per specialty, Wilson 95% CIs. Plus the tag audit. Counts only, no text.
import os, json
import numpy as np, pandas as pd
from statsmodels.stats.proportion import proportion_confint

OD = os.path.expanduser('~/oc/forest-lead/ft/out/ft-calltext')
OBJ = ['cost', 'insurance', 'fear', 'second_opinion', 'going_elsewhere', 'timing', 'family_decision', 'unreachable']
E = pd.read_parquet(f'{OD}/episodes_D.parquet')
f1 = pd.read_csv(os.path.expanduser('~/eta-data/forest/funnel/hash-only/f1-2026-10-19.tsv'), sep='\t', dtype=str)
E['amb_hash'] = E.cluster_key.isin(set(f1.loc[(f1.split == 'D') & (f1.ambiguous == 'true'), 'cluster_key']))
C = pd.read_parquet(f'{OD}/calls_D.parquet')
T = pd.read_json(f'{OD}/tags_D.jsonl', lines=True).drop_duplicates('call_id', keep='last')
C = C.merge(T.drop(columns=['episode_id']), on='call_id', how='left')
C['leak'] = C.outcome_revealed.fillna(False).astype(bool) | C.outcome_revealed_unverified.fillna(False).astype(bool)

BIG = {'General Surgery': 'GS', 'General surgery': 'GS', 'Surgery': 'GS', 'Gynaecology': 'Gyn', 'Gynaec': 'Gyn', 'GOBS': 'Gyn',
       'Orthopaedics': 'Ortho', 'Ortho': 'Ortho', 'Urology': 'Uro'}
E['spec4'] = E.specialty.map(BIG).fillna('Other')
L = []
w = lambda k, n: (k, n, *(proportion_confint(k, n, method='wilson') if n else (np.nan, np.nan)))
fmt = lambda t: f'{t[0]}/{t[1]} ({100 * t[0] / t[1]:.0f}% [{100 * t[2]:.0f}-{100 * t[3]:.0f}])' if t[1] else '-'

# ---- tag audit (all D window calls with a summary) ----
s = C[C.summary.notna()]
tg = s[s.outcome_revealed.notna()]
L += ['## Tag audit (D split, window calls with a summary, all D episodes incl. ambiguous)',
      f'- window calls with summary: {len(s)} in {s.episode_id.nunique()} episodes; tagged: {len(tg)} ({100 * len(tg) / len(s):.1f}%); untagged (11 failed parse chunks, not retried): {len(s) - len(tg)}',
      f'- outcome_revealed (verified quote): {int(tg.outcome_revealed.sum())} calls; claimed but quote unverified: {int(tg.outcome_revealed_unverified.sum())} (also dropped)']
cnt = {o: int(tg.objections.apply(lambda l: o in l).sum()) for o in OBJ}
L += ['- verified objection tags (calls): ' + ', '.join(f'{k} {v}' for k, v in cnt.items()),
      f"- intent: {tg.intent.value_counts().to_dict()}; next_step: {tg.next_step.value_counts().to_dict()}; price_quoted: {int(tg.price_quoted.sum())}"]
rep = json.load(open(f'{OD}/tag_report_run.json'))
L += [f"- runs: {len(rep)}; total tokens in {sum(r['in'] for r in rep)}, out {sum(r['out'] for r in rep)}; quotes failing verification (tag dropped): {sum(r['unverified'] for r in rep)}; model {rep[-1]['model']}", '']

for lab in ('h14', 'h90'):
    D = E[E[lab].notna() & (E.rx_date >= '2026-01-01') & ~E.amb_hash]
    c = C[C.episode_id.isin(D.episode_id) & C.outcome_revealed.notna()]
    lk = c.groupby('episode_id').leak.max()
    D = D.assign(leak_any=D.episode_id.map(lk).fillna(False).astype(bool))
    L += [f'## {lab}: outcome-revealing calls by label (cohort P, n {len(D)}, pos {int(D[lab].sum())})',
          f"- episodes with >=1 outcome-revealing window call: converted {fmt(w(int(D[D[lab] == 1].leak_any.sum()), int((D[lab] == 1).sum())))}, "
          f"not converted {fmt(w(int(D[D[lab] == 0].leak_any.sum()), int((D[lab] == 0).sum())))}", '']
    c = c[~c.leak]
    ep = pd.DataFrame({o: c.assign(v=c.objections.apply(lambda l: o in l)).groupby('episode_id').v.max() for o in OBJ})
    ep['any_objection'] = ep[OBJ].max(axis=1)
    ep['wants_surgery'] = c.assign(v=c.intent.eq('wants_surgery')).groupby('episode_id').v.max()
    ep['declines'] = c.assign(v=c.intent.eq('declines')).groupby('episode_id').v.max()
    ep['next_step_any'] = c.assign(v=c.next_step.ne('none')).groupby('episode_id').v.max()
    ep['price_quoted'] = c.price_quoted.astype(bool).groupby(c.episode_id).max()
    Dt = D[D.episode_id.isin(ep.index)].join(ep.astype(float), on='episode_id')
    L += [f'## {lab}: tag share among episodes with >=1 tagged non-revealing window call (cohort P: n {len(Dt)}, converted {int(Dt[lab].sum())})',
          '| tag | converted | not converted |', '|---|---|---|']
    for k in OBJ + ['any_objection', 'wants_surgery', 'declines', 'next_step_any', 'price_quoted']:
        a, b = Dt[Dt[lab] == 1], Dt[Dt[lab] == 0]
        L.append(f'| {k} | {fmt(w(int(a[k].sum()), len(a)))} | {fmt(w(int(b[k].sum()), len(b)))} |')
    # refute fix 3: worst case for the 11 parse-failed chunks: every episode with an untagged window call is given the tag
    failed = set(C.loc[C.summary.notna() & C.outcome_revealed.isna(), 'episode_id']) & set(D.episode_id)
    L += ['', f'Worst case for parse failures ({len(failed)} episodes in this cohort have untagged window calls; each is given the tag, and added to n if it had no tagged call):',
          '| tag | converted worst case | not converted worst case |', '|---|---|---|']
    for k in OBJ:
        cells = []
        for yv in (1, 0):
            grp = Dt[Dt[lab] == yv]; fl = [e for e in failed if D.set_index('episode_id').loc[e, lab] == yv]
            have = set(grp.episode_id)
            kk = int(grp[k].sum()) + sum(1 for e in fl if e not in have or grp.set_index('episode_id').loc[e, k] == 0)
            nn = len(grp) + sum(1 for e in fl if e not in have)
            cells.append(fmt(w(kk, nn)))
        L.append(f'| {k} | {cells[0]} | {cells[1]} |')
    L += ['', f'### {lab}: objection share per specialty (converted / not converted), same episodes', '| specialty | n (conv) | ' + ' | '.join(OBJ) + ' |', '|---' * (len(OBJ) + 2) + '|']
    for sp in ['GS', 'Gyn', 'Ortho', 'Uro', 'Other']:
        g = Dt[Dt.spec4 == sp]
        if not len(g): continue
        a, b = g[g[lab] == 1], g[g[lab] == 0]
        cell = lambda k: f'{100 * a[k].mean():.0f}% / {100 * b[k].mean():.0f}%' if len(a) and len(b) else '-'
        L.append(f'| {sp} | {len(g)} ({len(a)}) | ' + ' | '.join(cell(k) for k in OBJ) + ' |')
    L.append('')
open(f'{OD}/DESC.md', 'w').write('\n'.join(L)); os.chmod(f'{OD}/DESC.md', 0o600)
print('\n'.join(L))
