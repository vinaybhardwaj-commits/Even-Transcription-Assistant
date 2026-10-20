"""ft-lexical step 1 (venv-forest): build the three text corpora (D only), with speaker roles and leak screens. Ids and counts on stdout only.
R  Runo call transcripts: Sarvam STT segments -> Nemotron speaker by overlap -> role (ft-engines roles_A.one, unchanged).
   Eligible = ft-engines elig_t14 (day_from_rx < 14, STT ok, pre-event, Haiku-tagged, not outcome_revealed) and not Jev leak_union (ft-text2).
S  Runo counsellor summaries: ft-calltext calls_D window (Rx..Rx+14, pre-event), Haiku-tagged, not outcome_revealed / unverified, not Jev leak_union.
K  Consults: ft-audio features_ale (198, one per patient). Native Sarvam STT segments; role per segment by ft-audio roles_map (+ caa-labels).
Every episode / consult passes split_guard (pinned list) -> D, else it is dropped and counted.
Work output (0600, ~/eta-data/forest/ft-lexical/): items.jsonl {corpus, item_id, unit_id, segs:[[role, lang, text]...], ...}, units.parquet (labels)."""
import sys, os, json, glob, collections
import numpy as np, pandas as pd
H = os.path.expanduser
sys.path.insert(0, H('~/wt/forest-funnel-join/studies/2026-10-16-runo-linkage/split'))
sys.path.insert(0, H('~/oc/forest-lead/ft/out/ft-engines/code'))
sys.path.insert(0, H('~/wt/ft-cohortb-expand/code'))
import split_guard as SG
import roles_A
import audio_feats as AF

PIN = '52959278edd8cd5db65c362fb8fb872c1d8e7b79767fac81334d321491052d65'
O = H('~/oc/forest-lead/ft/out'); W = H('~/eta-data/forest/ft-lexical')
os.makedirs(W, mode=0o700, exist_ok=True)
G = SG.load(lock_dir=H('~/eta-data/forest/split'), pinned_list_sha256=PIN)


def guard(ck):
    try: return G.set_of(ck)
    except Exception as e: return 'err_' + type(e).__name__


# ---- episode labels (D only)
lab = pd.read_parquet(f'{O}/ft-labels-base/labels.parquet')
lab = lab[lab.split == 'D'].copy()
ep = pd.read_parquet(f'{O}/ft-calltext/episodes_D.parquet')[['episode_id', 'amb_hash', 'amb_phone']]
lab = lab.merge(ep, on='episode_id', how='left')
lab['ale'] = np.where(lab.days_to_surgery <= 14, 1.0, np.where(lab.age_days >= 14, 0.0, np.nan))
lab['guard'] = lab.cluster_key.map(guard)
print('D episodes', len(lab), 'guard', lab.guard.value_counts().to_dict())
lab = lab[lab.guard == 'D']
jv = pd.read_parquet(f'{O}/ft-text2/call_tags_jev.parquet')[['src', 'call_id', 'leak_union']]
jleak = {(s, c) for s, c, l in jv.itertuples(index=False) if l == 1}

items = []
# ---- R: call transcripts
pc = pd.read_parquet(f'{O}/ft-engines/engine_calls_percall.parquet')
N = {}
for l in open(H('~/eta-data/forest/ft-engines/A_nemo.jsonl')):
    d = json.loads(l); N[d['call_id']] = d
bas = pd.read_parquet(H('~/eta-data/forest/rl/feat/calls_basic.parquet'))[['call_id', 'lang_main', 'call_span_s', 'audio_dur_s']]
pc = pc.merge(bas, on='call_id', how='left')
pc['jev_leak'] = [('S2', c) in jleak for c in pc.call_id]
pc['elig'] = pc.elig_t14 & ~pc.jev_leak & pc.episode_id.isin(lab.episode_id)
print('R calls', len(pc), 'elig_t14', int(pc.elig_t14.sum()), 'jev_leak drop', int((pc.elig_t14 & pc.jev_leak).sum()),
      'not-D/guard drop', int((pc.elig_t14 & ~pc.jev_leak & ~pc.episode_id.isin(lab.episode_id)).sum()), 'eligible', int(pc.elig.sum()))
man = pd.read_csv(H('~/eta-data/forest/rl/manifest.tsv'), sep='\t', dtype=str).set_index('key_id')
for r in pc[pc.elig].itertuples():
    f, rl, segs = roles_A.one(r.call_id, N.get(r.call_id, {}))
    stt = roles_A.rp.parse_stt(json.load(open(f'{roles_A.STT}/{r.call_id}.json')))
    out = []
    for a, b, _, t, lg in stt:
        o = collections.Counter()
        for c, e, s in segs: o[s] += roles_A.ov(a, b, c, e)
        role = rl.get(o.most_common(1)[0][0]) if o and o.most_common(1)[0][1] > 0 else None
        role = role if role in ('counsellor', 'patient') else 'unclear'
        out.append([role, lg, t, round(a, 2), round(b, 2)])
    items.append(dict(corpus='R', item_id=r.call_id, unit_id=r.episode_id, day_from_rx=int(r.day_from_rx), role_src=r.role_src,
                      lang_main=r.lang_main, dur_s=r.audio_dur_s, call_ts=man.call_ts.get(r.call_id), segs=out))

# ---- S: counsellor summaries
cd = pd.read_parquet(f'{O}/ft-calltext/calls_D.parquet')
tg = {}
for l in open(f'{O}/ft-calltext/tags_D.jsonl'):
    d = json.loads(l); tg[d['call_id']] = d
cd = cd[cd.summary.notna() & cd.episode_id.isin(lab.episode_id)].drop_duplicates(['episode_id', 'call_id'])
n0 = len(cd)
cd = cd[cd.call_id.isin(tg)]
n1 = len(cd)
cd = cd[[not (tg[c]['outcome_revealed'] or tg[c]['outcome_revealed_unverified']) for c in cd.call_id]]
n2 = len(cd)
cd = cd[[('S1', c) not in jleak for c in cd.call_id]]
print('S summaries in window', n0, 'tagged', n1, 'not revealed', n2, 'not Jev leak', len(cd))
for r in cd.itertuples():
    items.append(dict(corpus='S', item_id=r.call_id, unit_id=r.episode_id, day_from_rx=int(r.day_from_rx), segs=[['summary', None, r.summary]]))

# ---- K: consults
fa = pd.read_parquet(f'{O}/ft-audio/features_ale.parquet')
fa['guard'] = fa.cluster_key.map(guard)
print('K consults', len(fa), 'guard', fa.guard.value_counts().to_dict())
fa = fa[fa.guard == 'D']
kstat = collections.Counter()
for r in fa.itertuples():
    d = AF.reb_dir(r)
    if not d: kstat['no_reb'] += 1; continue
    t = d + '/tracks'
    stt = AF.newest(f'{t}/stt.sarvam-saaras*')
    if not stt or stt.get('status') != 'ok': kstat['no_stt'] += 1; continue
    rmap, rsrc = AF.roles_map(t)
    R = {}
    caa = AF.newest(f'{t}/role.caa-labels__*')
    if rsrc == 'none' and caa and caa.get('status') == 'ok':
        R = {x['t0_ms']: x['role'] for x in caa['segments']}; rsrc = 'caa-labels'
    out = []
    for s in stt['segments']:
        ro = R.get(s['t0_ms'], 'unknown') if rsrc == 'caa-labels' else rmap.get(str(s['speaker']))
        sd = AF.side(ro) if ro else None
        out.append([{'doctor': 'doctor', 'patient_side': 'patient'}.get(sd, 'unclear'), s.get('lang'), s.get('text') or '', s['t0_ms'] / 1000, s['t1_ms'] / 1000])
    kstat['ok'] += 1
    items.append(dict(corpus='K', item_id=r.consult_uid, unit_id=r.consult_uid, role_src_k=rsrc, feat_role_src=r.role_src, consult_lang=r.consult_lang,
                      lang_en_share=r.lang_en_share, segs=out))
print('K', dict(kstat))

with open(f'{W}/items.jsonl', 'w', opener=lambda p, f: os.open(p, f, 0o600)) as fh:
    for it in items: fh.write(json.dumps(it, ensure_ascii=False) + '\n')
# units with labels: episodes (R, S) and consults (K)
U = lab[['episode_id', 'doctor_id', 'specialty', 'rx_date', 'age_days', 'days_to_surgery', 'h14', 'h90', 'ale', 'amb_hash']].rename(columns={'episode_id': 'unit_id'})
U['kind'] = 'episode'
K = fa[['consult_uid', 'doctor_uid', 'specialty', 'h14', 'ale', 'h90_s', 'episode_id', 'consult_lang', 'lang_en_share', 'lang_n', 'role_src']].rename(
    columns={'consult_uid': 'unit_id', 'doctor_uid': 'doctor_id', 'h90_s': 'h90', 'role_src': 'feat_role_src'})
K['kind'] = 'consult'; K['amb_hash'] = False
U = pd.concat([U, K], ignore_index=True)
p = f'{W}/units.parquet'; U.to_parquet(p, index=False); os.chmod(p, 0o600)
print('items', collections.Counter(i['corpus'] for i in items), 'units', U.kind.value_counts().to_dict())
