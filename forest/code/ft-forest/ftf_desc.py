# ft-forest DESC-jev (20 Oct 2026). Reruns the ft-calltext call-objection descriptives (ftc_desc.py, h14, cohort P) three ways:
#   raw  = Haiku tags_D.jsonl as tagged;
#   jev  = ft-text2 tags_D_jev.jsonl (Haiku positive set to 0 where Jev contradicts, p < 0.2);
#   agree = Haiku positive AND Jev p >= 0.5 (call_tags_jev.parquet, S1; no Jev answer -> not counted).
# Episode set and leak screen are held fixed at the ftc_desc definition (Haiku outcome_revealed / unverified dropped) so the three columns
# share one denominator; a sensitivity line also drops the 6 Jev-added outcome-revealing calls. Wilson 95% CIs. Counts only, no text.
import os, sys, hashlib
import numpy as np, pandas as pd
from statsmodels.stats.proportion import proportion_confint

H = os.path.expanduser
FTC = H('~/oc/forest-lead/ft/out/ft-calltext'); TX2 = H('~/oc/forest-lead/ft/out/ft-text2'); OUT = H('~/oc/forest-lead/ft/out/ft-forest')
F1 = H('~/eta-data/forest/funnel/hash-only/f1-2026-10-19.tsv')
OBJ = ['cost', 'insurance', 'fear', 'second_opinion', 'going_elsewhere', 'timing', 'family_decision', 'unreachable']
TAGS = OBJ + ['any_objection', 'wants_surgery', 'declines', 'next_step_any', 'price_quoted']
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()[:12]

E = pd.read_parquet(f'{FTC}/episodes_D.parquet')
f1 = pd.read_csv(F1, sep='\t', dtype=str, usecols=['cluster_key', 'split', 'ambiguous'])
f1 = f1[f1.split == 'D']                                     # D rows only kept
E['amb_hash'] = E.cluster_key.isin(set(f1.loc[f1.ambiguous == 'true', 'cluster_key']))
C0 = pd.read_parquet(f'{FTC}/calls_D.parquet')


def calls_with(tagfile):
    T = pd.read_json(tagfile, lines=True).drop_duplicates('call_id', keep='last')
    keep = ['call_id', 'objections', 'outcome_revealed', 'outcome_revealed_unverified', 'intent', 'next_step', 'price_quoted']
    return C0.merge(T[keep + [c for c in ('outcome_revealed_jev_added',) if c in T]], on='call_id', how='left')


def per_episode(c):
    ep = pd.DataFrame({o: c.assign(v=c.objections.apply(lambda l: o in l)).groupby('episode_id').v.max() for o in OBJ})
    ep['any_objection'] = ep[OBJ].max(axis=1)
    ep['wants_surgery'] = c.assign(v=c.intent.eq('wants_surgery')).groupby('episode_id').v.max()
    ep['declines'] = c.assign(v=c.intent.eq('declines')).groupby('episode_id').v.max()
    ep['next_step_any'] = c.assign(v=c.next_step.ne('none')).groupby('episode_id').v.max()
    ep['price_quoted'] = c.price_quoted.astype(bool).groupby(c.episode_id).max()
    return ep.astype(float)


raw = calls_with(f'{FTC}/tags_D.jsonl')
jev = calls_with(f'{TX2}/tags_D_jev.jsonl')
# leak screen fixed at the Haiku definition (as ftc_desc); outcome_revealed in the jev file includes Jev-added -> use the raw flags
assert (raw.call_id.values == jev.call_id.values).all()
raw['leak'] = raw.outcome_revealed.eq(True) | raw.outcome_revealed_unverified.eq(True)
jadd = set(jev.loc[jev.outcome_revealed_jev_added.eq(True), 'call_id'])

# agree: Haiku positive and Jev p >= 0.5, from the ft-text2 per-call table (S1 = Runo summaries = tags_D)
P = pd.read_parquet(f'{TX2}/call_tags_jev.parquet'); P = P[P.src == 'S1'].set_index('call_id')
agr = raw.copy()
def ag(cid, tag):
    if cid not in P.index: return False
    p = P.at[cid, f'j_{tag}']
    return bool(P.at[cid, f'h_{tag}'] == 1 and pd.notna(p) and p >= 0.5)
m = agr.objections.notna()
agr.loc[m, 'objections'] = pd.Series([[o for o in l if ag(cid, f'obj_{o}')] for cid, l in zip(agr.call_id[m], agr.objections[m])], index=agr.index[m], dtype=object)
agr.loc[m, 'intent'] = [i if i not in ('wants_surgery', 'undecided', 'declines') or ag(cid, f'intent_{i}') else 'not_stated'
                        for cid, i in zip(agr.call_id[m], agr.intent[m])]
agr.loc[m, 'next_step'] = [s if s == 'none' or ag(cid, f'next_{s}') else 'none' for cid, s in zip(agr.call_id[m], agr.next_step[m])]
agr.loc[m, 'price_quoted'] = [bool(q) and ag(cid, 'price_quoted') for cid, q in zip(agr.call_id[m], agr.price_quoted[m])]

w = lambda k, n: (k, n, *(proportion_confint(k, n, method='wilson') if n else (np.nan, np.nan)))
fmt = lambda t: f'{t[0]}/{t[1]} ({100 * t[0] / t[1]:.0f}% [{100 * t[2]:.0f}-{100 * t[3]:.0f}])' if t[1] else '-'

lab = 'h14'
D = E[E[lab].notna() & (E.rx_date >= '2026-01-01') & ~E.amb_hash]
L = [f'# DESC-jev: call-objection descriptives three ways (ft-forest, {pd.Timestamp.now(tz="Asia/Kolkata"):%Y-%m-%d %H:%M} IST)',
     '- Design as ft-calltext ftc_desc.py: D split, cohort P (hash-only F1 ambiguity dropped), Rx >= 2026-01-01, label h14 final; window calls with a summary, '
     'days 0..14 before the surgery day, outcome-revealing calls dropped (Haiku verified or unverified). Per episode: tag on any non-revealing window call.',
     '- raw = Haiku tags_D.jsonl. jev = tags_D_jev.jsonl (Haiku positive set to 0 where Jev p < 0.2). agree = Haiku positive AND Jev p >= 0.5 (stricter than jev: also drops Jev-unsure 0.2 <= p < 0.5).',
     '- The episode set and leak screen are the same for all three columns, so the denominators match. Wilson 95% CIs. Descriptive only, no test.', '']
res = {}
for name, c in (('raw', raw), ('jev', jev), ('agree', agr)):
    c = c.assign(leak=raw.leak.values)
    c = c[c.episode_id.isin(D.episode_id) & c.outcome_revealed.notna() & ~c.leak]
    res[name] = D[D.episode_id.isin(per_episode(c).index)].join(per_episode(c), on='episode_id')
Dt = res['raw']
assert all(len(r) == len(Dt) for r in res.values())
L += [f'## {lab}: tag share among episodes with >=1 tagged non-revealing window call (n {len(Dt)}, converted {int(Dt[lab].sum())})', '',
      '| tag | raw: converted | raw: not converted | jev: converted | jev: not converted | agree: converted | agree: not converted |', '|---|---|---|---|---|---|---|']
for k in TAGS:
    cells = []
    for name in ('raw', 'jev', 'agree'):
        r = res[name]; a, b = r[r[lab] == 1], r[r[lab] == 0]
        cells += [fmt(w(int(a[k].sum()), len(a))), fmt(w(int(b[k].sum()), len(b)))]
    L.append(f'| {k} | ' + ' | '.join(cells) + ' |')
# sensitivity: also drop the Jev-added outcome-revealing calls (Jev-filtered tags)
c = jev.assign(leak=raw.leak.values | jev.call_id.isin(jadd).values)
c = c[c.episode_id.isin(D.episode_id) & c.outcome_revealed.notna() & ~c.leak]
S = D[D.episode_id.isin(per_episode(c).index)].join(per_episode(c), on='episode_id')
nj = int(raw[raw.episode_id.isin(D.episode_id) & raw.call_id.isin(jadd)].shape[0])
L += ['', f'Sensitivity (jev tags, also dropping the Jev-added outcome-revealing calls: {nj} such calls in this cohort): n {len(S)}, converted {int(S[lab].sum())}.', '',
      '| tag | converted | not converted |', '|---|---|---|']
for k in TAGS:
    a, b = S[S[lab] == 1], S[S[lab] == 0]
    L.append(f'| {k} | {fmt(w(int(a[k].sum()), len(a)))} | {fmt(w(int(b[k].sum()), len(b)))} |')
ins = {p: sha(p) for p in (f'{FTC}/episodes_D.parquet', f'{FTC}/calls_D.parquet', f'{FTC}/tags_D.jsonl', f'{TX2}/tags_D_jev.jsonl',
                           f'{TX2}/call_tags_jev.parquet', F1, os.path.abspath(__file__))}
L += ['', '## Inputs (sha12)', '| file | sha12 |', '|---|---|'] + [f'| {os.path.basename(p)} | {s} |' for p, s in ins.items()]
o = f'{OUT}/DESC-jev.md'
fd = os.open(o, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, ('\n'.join(L) + '\n').encode()); os.close(fd); os.chmod(o, 0o600)
print('\n'.join(L))
