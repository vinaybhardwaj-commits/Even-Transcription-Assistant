"""ft-engines COVERAGE.md (counts only) from the assembled outputs + raw engine files. Usage: cov.py <work> <out>
Also: split_guard (forest-funnel-join split_guard, pinned list, as ft-audio seal_check.py) on every consult of set B -> ext86_split_guard.tsv (consult_uid, set_src, guard)."""
import sys, os, json, csv, collections
import numpy as np, pandas as pd
H = os.path.expanduser
sys.path.insert(0, H('~/wt/forest-funnel-join/studies/2026-10-16-runo-linkage/split'))
import split_guard as SG
PIN = '52959278edd8cd5db65c362fb8fb872c1d8e7b79767fac81334d321491052d65'
FTA = H('~/oc/forest-lead/ft/out/ft-audio')


def jl(p): return [json.loads(l) for l in open(p)] if os.path.exists(p) else []


def guard_consults(uids, clip_keys=None):
    g = SG.load(lock_dir=H('~/eta-data/forest/split'), pinned_list_sha256=PIN)
    link = {}
    for l in open(H('~/eta-data/convert/p1/linked.jsonl')):
        r = json.loads(l)
        if r['consult_uid']: link[r['clip_key']] = r['consult_uid']; link[r['consult_uid']] = r['consult_uid']
    pk = {r['consult_uid']: r['patient_key'] for r in csv.DictReader(open(H('~/oc/forest-lead/data/10b-patient-key-c2.tsv')), delimiter='\t')}
    cl = {r['patient_key']: r['cluster_key'] for r in csv.DictReader(open(H('~/eta-data/forest/split/clusters-2026-10-18.tsv')), delimiter='\t')}
    out = {}
    for u in uids:
        c = link.get(u) or link.get((clip_keys or {}).get(u))
        if not c: out[u] = 'not_a_linked_consult'; continue
        k = pk.get(c)
        if not k: out[u] = 'no_patient_key'; continue
        try: out[u] = g.set_of(cl.get(k, k))
        except SG.GuardError as e: out[u] = 'guard_' + type(e).__name__
    return out


def status_counts(rows, key):
    """per item: ok if >= 1 ok row, failed if rows but none ok."""
    by = collections.defaultdict(list)
    for r in rows: by[key(r)].append(r.get('status', '') == 'ok')
    return {k: any(v) for k, v in by.items()}


def main(work, out):
    P = pd.read_pickle(f'{work}/assembled.pkl')
    dfA, cb, winA, CA = P['A']; dfB, winB, CB, itemsB = P['B']
    L = ['# ft-engines COVERAGE (counts only; D split only). Generated ' + pd.Timestamp.now(tz='Asia/Kolkata').strftime('%Y-%m-%d %H:%M IST'), '']
    # ---------------- A
    calls = set(cb.call_id)
    L += ['## Set A: Runo calls (933 D calls in shard a/b/c, 369 D episodes)', '', '| engine | unit | ok | failed | missing |', '|---|---|---|---|---|']
    nem = {r['call_id']: r['status'] for r in jl(f'{work}/A_nemo.jsonl')}
    L.append(f"| Nemotron-3 diarization | call | {sum(v == 'ok' for v in nem.values())} | {sum(v != 'ok' for v in nem.values())} | {len(calls - set(nem))} |")
    wcalls = set(winA.item)
    L.append(f'| (calls with >= 1 speech window from Sarvam STT turns; all window engines are bounded by this) | call | {len(wcalls)} | - | {len(calls - wcalls)} |')
    for eng in ('ody', 'wavlm', 'e2v'):
        okw = winA[f'{eng}__{"valence" if eng == "ody" else ("anger" if eng == "wavlm" else "angry")}'].notna()
        okc = set(winA.item[okw])
        L.append(f'| {eng} | window | {int(okw.sum())} | {int((~okw).sum())} (not ok or not scored) | - |')
        L.append(f'| {eng} | call | {len(okc)} | {len(wcalls - okc)} | {len(calls - wcalls)} |')
    for ro in ('patient', 'counsellor', 'all'):
        g = CA[CA.role == ro] if len(CA) else CA
        ok = set(g.item[g.status == 'ok']) if len(g) else set(); bad = set(g.item[g.status != 'ok']) - ok if len(g) else set()
        L.append(f'| Clef-omni role={ro} | call | {len(ok)} | {len(bad)} | {len(wcalls - ok - bad)} (of calls with windows) |')
    L += ['', 'Role source per call (Nemotron + lexicon): ' + str(cb.role_src.value_counts().to_dict()) + '; old ft-rl-feat source: ' + str(cb.role_src_sarvam_old.value_counts().to_dict()),
          'Window roles after re-roling (window -> Nemotron speaker covering >= 60%): ' + str(winA.role.fillna('none (overlap/unclear/single)').value_counts().to_dict()), '']
    # landmark cells
    L += ['### Landmark cells (episode rows with n_calls_tT > 0; at-risk F1 = no surgery on or before day T)', '',
          '| T | label | at-risk labelled | positives | with >=1 eligible call | pos with call | Nemotron | with a non-fallback-role call | Odyssey patient | WavLM patient | e2v patient | Clef patient | Clef role-free |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|']
    lab = dfA
    for T in (3, 7, 14):
        s = f'_t{T}'
        for y in ('h14', 'h90', 'ale'):
            ar = lab[(lab.days_to_surgery.isna() | (lab.days_to_surgery > T)) & lab[y].notna()]
            # note: dfA rows are episodes with >= 1 manifest call; episodes with no call are not in this file (all engine features missing for them)
            c = ar[ar['n_calls' + s] > 0]
            L.append(f"| {T} | {y} | {len(ar)} | {int(ar[y].sum())} | {len(c)} | {int(c[y].sum())} | {int((c['n_calls_diarized' + s] > 0).sum())} | {int((c['n_calls_roleok' + s] > 0).sum())} | "
                     f"{int((c['ody_patient_n_win' + s] > 0).sum())} | {int((c['wavlm_patient_n_win' + s] > 0).sum())} | {int((c['e2v_patient_n_win' + s] > 0).sum())} | "
                     f"{int((c['clef_patient_n' + s] > 0).sum())} | {int((c['clef_all_n' + s] > 0).sum())} |")
    L += ['', 'Role-specific (patient/counsellor) columns are masked per spec section 4: only calls with role_src lexicon or lexicon_weak feed them; *_lex2 columns use lexicon only. Role-free (_all_) columns use every eligible call.',
          'At-risk counts are over the 369 D episodes that have >= 1 manifest call; for the full landmark denominator use the FTR v2 design file (episodes with no call have n_calls_tT = 0 / absent here).', '']
    # ---------------- B
    L += ['## Set B: OPD consults (125 ft-audio cohort-B D consults + 86 FT4 Ale-cohort consults not in the 125 = 211)', '', '| engine | role | consults ok | failed | missing |', '|---|---|---|---|---|']
    allc = set(dfB.consult_uid); wc = set(winB.item)
    L.append(f'| (consults with >= 1 speaker window: needs audio + Nemotron diar + roles) | - | {len(wc)} | - | {len(allc - wc)} |')
    L.append(f"| Nemotron-3 turn features (REB diar.nemotron track, ft-audio / cohortb-expand audio_feats) | - | {int(dfB.nemo_doc_talk_share.notna().sum())} | - | {int(dfB.nemo_doc_talk_share.isna().sum())} |")
    for eng, c0 in (('ody', 'valence'), ('wavlm', 'anger'), ('e2v', 'angry')):
        for ro in ('patient', 'doctor', 'all'):
            g = winB if ro == 'all' else winB[winB.role == ro]
            ok = set(g.item[g[f'{eng}__{c0}'].notna()]); has = set(g.item)
            nbad = int(g[f'{eng}__{c0}'].isna().sum())
            L.append(f'| {eng} | {ro} | {len(ok)} | {len(has - ok)} (failed windows: {nbad} of {len(g)}, in {g.item[g[f"{eng}__{c0}"].isna()].nunique()} consults) | {len(allc - has)} |')
    for ro in ('patient', 'doctor', 'all'):
        g = CB[CB.role == ro]
        ok = set(g.item[g.status == 'ok']); bad = set(g.item[g.status != 'ok']) - ok
        L.append(f'| Clef-omni | {ro} | {len(ok)} | {len(bad)} | {len(allc - ok - bad)} |')
    L += ['', 'Role source (consults): ' + str(dfB.role_src.value_counts().to_dict()) + '; diar source: ' + str(dfB.diar_src.value_counts(dropna=False).to_dict()), '']
    # Ale cohort
    fa = pd.read_parquet(f'{FTA}/features_ale.parquet'); fa = fa[fa.ale.notna()]
    m = fa[['consult_uid', 'ale']].merge(dfB, on='consult_uid', how='left')
    L += [f'### FT4 Ale cohort (features_ale.parquet rows with an Ale label: {len(fa)} patients / {int(fa.ale.sum())} positives; spec quotes 138 / 23)', '',
          '| feature | patients with data | positives with data |', '|---|---|---|']
    for col in ('nemo_doc_talk_share', 'ody_patient_n_win', 'ody_doctor_n_win', 'wavlm_patient_n_win', 'wavlm_doctor_n_win', 'e2v_patient_n_win', 'e2v_doctor_n_win',
                'clef_patient_n', 'clef_doctor_n', 'clef_all_n'):
        has = m[col].notna() if col.startswith('nemo') else (m[col] > 0)
        L.append(f'| {col} | {int(has.sum())} | {int((has & (m.ale == 1)).sum())} |')
    # split guard
    eb = pd.concat([pd.read_parquet(H('~/oc/forest-lead/ft/out/ft-cohortb-expand/base.parquet'))[['consult_uid', 'clip_key']], pd.read_parquet(f'{FTA}/base.parquet')[['consult_uid', 'clip_key']]])
    gd = guard_consults(list(dfB.consult_uid), dict(zip(eb.consult_uid, eb.clip_key)))
    dfB['guard'] = dfB.consult_uid.map(gd)
    # consults that split_guard cannot reach through linked.jsonl: fall back to the episode's split in labels.parquet (episode_id from cohortb-expand base / features_ale)
    # consults that split_guard cannot reach through linked.jsonl: run split_guard on the episode's patient cluster (labels.parquet cluster_key via episode_id)
    labs = pd.read_parquet(H('~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet')).set_index('episode_id')
    g = SG.load(lock_dir=H('~/eta-data/forest/split'), pinned_list_sha256=PIN)
    def via_cluster(ep):
        ck = labs.cluster_key.get(ep) if isinstance(ep, str) else None
        if not ck: return 'no_cluster'
        try: return g.set_of(ck)
        except SG.GuardError as e: return 'guard_' + type(e).__name__
    miss = ~dfB.guard.isin(['D', 'H'])
    dfB.loc[miss, 'guard'] = dfB.loc[miss, 'guard'] + '|guard_via_labels_cluster=' + dfB.loc[miss, 'episode_id'].map(via_cluster).astype(str)
    assert not dfB.guard.str.contains('H').any(), 'H consult in set B'
    t = dfB[['consult_uid', 'set_src', 'guard']]
    p = f'{out}/consults_split_guard.tsv'; t.to_csv(p, sep='\t', index=False); os.chmod(p, 0o600)
    L += ['', '### split_guard on set B consults (consult -> patient_key -> cluster -> split; full list in consults_split_guard.tsv)', '',
          str(t.groupby('set_src').guard.value_counts().to_dict()), '', 'The 86 Ale-extension consult_uids (all listed with their guard result in consults_split_guard.tsv): ' +
          ', '.join(sorted(t[t.set_src == 'ale-extension'].consult_uid)), '']
    open(f'{out}/COVERAGE.md', 'w').write('\n'.join(L) + '\n'); os.chmod(f'{out}/COVERAGE.md', 0o600)
    print('\n'.join(L))


if __name__ == '__main__': main(*sys.argv[1:3])
