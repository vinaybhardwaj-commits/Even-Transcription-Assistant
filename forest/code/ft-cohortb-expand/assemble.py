# ft-cohortb-expand: assemble out/ft-cohortb-expand/features_all.parquet (one row per recorded consult that anchors a D-split flagged-Rx episode,
# 9 Sep - 19 Oct) + COVERAGE.md. Same feature columns as ft-audio features.parquet (its assemble.py), with these differences:
#   label = labels.parquet h14 (ft-labels-base v2: final at >= 18 d, NaN younger), not ft4a; case mix = ft-labels-base features_D.parquet (per episode).
# Ids and numbers only.
import os, csv, json, collections, datetime as dt
import numpy as np, pandas as pd
H = os.path.expanduser; FT = H('~/oc/forest-lead/ft'); O = f'{FT}/out/ft-cohortb-expand'
READ = dt.date(2026, 10, 19); AGE_MIN = 18; MIN_PHASE_S = 5.0
JEV = ['f01', 'f02', 'f03', 'f05', 'f06', 'f07', 'f18']

b = pd.read_parquet(f'{O}/base.parquet')
g = collections.defaultdict(dict)
for l in open(f'{O}/jev_gapfill.jsonl'):
    r = json.loads(l); g[r['clip_key']][r['qid']] = r['p_yes']
for u, j in g.items():
    m = (b.consult_uid == u) & b.jev_src.isna()
    for q in JEV: b.loc[m, f'jev_{q}'] = j.get(q)
    b.loc[m, 'jev_src'] = 'cbx-gapfill'
a = pd.read_parquet(f'{O}/audio_feats.parquet'); b = b.merge(a, on='consult_uid', how='left')
# emotion (Odyssey): duration-weighted means per consult and phase (ft-audio rule)
e = pd.DataFrame([json.loads(l) for l in open(f'{O}/emo_scored.jsonl')]) if os.path.exists(f'{O}/emo_scored.jsonl') else pd.DataFrame()
if len(e):
    e = e[e.status == 'ok']; e['w'] = e.t1 - e.t0
    def wm(x, c): return np.average(x[c], weights=x.w) if len(x) else np.nan
    E = []
    for u, x in e.groupby('consult_uid'):
        pre, post = x[x.phase == 'pre'], x[x.phase == 'post']
        ok = pre.w.sum() >= MIN_PHASE_S and post.w.sum() >= MIN_PHASE_S
        E.append(dict(consult_uid=u, pat_valence=wm(x, 'valence'), pat_arousal=wm(x, 'arousal'), emo_speech_s=x.w.sum(),
                      val_pre=wm(pre, 'valence'), val_post=wm(post, 'valence'), aro_pre=wm(pre, 'arousal'), aro_post=wm(post, 'arousal'),
                      val_change=(wm(post, 'valence') - wm(pre, 'valence')) if ok else np.nan,
                      aro_change=(wm(post, 'arousal') - wm(pre, 'arousal')) if ok else np.nan, emo_src=x.src.iloc[0]))
    b = b.merge(pd.DataFrame(E), on='consult_uid', how='left')
sp = {r['doctor_uid']: r['specialty'] for r in csv.DictReader(open(f'{FT}/doctor_specialty.tsv'), delimiter='\t')}
b['specialty'] = b.doctor_uid.map(sp).fillna('unknown')
b['consult_date'] = pd.to_datetime(b.ist_date)
# doctor prior H14 rate (ft-audio rule): D flagged-Rx episodes matured before this consult, cohort consults excluded, Beta(5) smoothing to the pooled rate
L0 = pd.read_parquet(f'{FT}/out/ft-labels-base/labels.parquet'); L0 = L0[L0.split == 'D']; L = L0[L0.h14.notna() & ~L0.consult_uid.isin(b.consult_uid)]
A = 5.0
def prior(r):
    x = L[(L.doctor_id == r.doctor_uid) & (L.rx_date + pd.Timedelta(days=14) <= r.consult_date)]
    y = L[L.rx_date + pd.Timedelta(days=14) <= r.consult_date]
    base = y.h14.mean() if len(y) else np.nan
    return pd.Series(dict(doc_prior_n=len(x), doc_prior_rate=(x.h14.sum() + A * base) / (len(x) + A)))
b = pd.concat([b, b.apply(prior, axis=1)], axis=1)
# case mix + Pulse baseline features per episode (ft-labels-base features_D.parquet)
P = pd.read_parquet(f'{FT}/out/ft-labels-base/features_D.parquet')
pc = [c for c in json.load(open(f'{FT}/out/ft-labels-base/features_D.cols.json')) if c not in ('specialty', 'doctor_id')]
b = b.merge(P[['episode_id'] + pc].rename(columns={c: c if c in ('age_y', 'sex', 'payer', 'n_prior_rx', 'doctor_gender') else 'pulse_' + c for c in pc}),
            on='episode_id', how='left')
b['label_src'] = 'labels.parquet v2 (ft-labels-base, read 2026-10-19)'
b['jev_pitch_score'] = b[['jev_f03', 'jev_f07', 'jev_f18']].mean(axis=1)
b['eligible_h14'] = b.age_days >= AGE_MIN
# Ale label (newcat-orch, 19 Oct): 1 = attributable surgery (labels.parquet event_date, R1/R2/R4 already excluded) at any time up to READ;
# 0 = >= 14 d old with no surgery; NaN (drop) = younger than 14 d with no surgery. No 4 d billing-lag wait, so 14-17 d zeros can still flip.
ev = L0.set_index('episode_id').event_date
b['event_date'] = b.episode_id.map(ev)
b['ale_label'] = np.where(b.event_date.notna(), 1.0, np.where(b.age_days >= 14, 0.0, np.nan))
b['eligible_ale'] = b.ale_label.notna()
b.to_parquet(f'{O}/features_all.parquet', index=False); os.chmod(f'{O}/features_all.parquet', 0o600)

FEATS = [('consult_lang', 'consult language (Sarvam STT seg lang, duration-weighted)'), ('lang_en_share', 'English share of speech'),
         ('doc_talk_share', 'doctor talk-time share (Nemotron-3 diar + LLM/text-judge roles)'), ('patient_talk_share', 'patient talk-time share'),
         ('turns_per_min', 'doctor/patient-side turn changes per min'), ('doc_interrupt_per_min', 'doctor interruptions per min'),
         ('pat_interrupt_per_min', 'patient-side interruptions per min'), ('rec_t_s', 'surgery recommendation time (first doctor keyword segment)'),
         ('pat_valence', 'patient valence, Odyssey'), ('pat_arousal', 'patient arousal, Odyssey'), ('val_change', 'valence change post-pre recommendation (>= 5 s patient speech each side)'),
         ('aro_change', 'arousal change post-pre'), ('jev_f02', 'Jev f02'), ('jev_f03', 'Jev f03 procedure named'), ('jev_f05', 'Jev f05'), ('jev_f06', 'Jev f06'),
         ('jev_f07', 'Jev f07 next step (LEAKAGE: see LEAKAGE_f07.md)'), ('jev_f18', 'Jev f18 cost'), ('specialty', 'specialty (doctor_specialty.tsv)'),
         ('doc_prior_rate', 'doctor prior H14 rate (flagged Rx, time-respecting)'), ('age_y', 'age'), ('sex', 'patient sex'), ('payer', 'payer'),
         ('doctor_gender', 'doctor gender'), ('pulse_n_icd', 'Pulse baseline features (features_D, e.g. n_icd)'), ('prescription_uid', 'Rx id (label join)'), ('h14', 'H14 label'), ('ale_label', 'Ale label')]
el = b[b.eligible_h14]
def cov(df, c): return int((df[c].notna() & (df[c] != 'unknown')).sum()) if c in df else 0
def cnt(s): return {str(k): int(v) for k, v in s.value_counts(dropna=False).items()}
lines = ['# FT4 Cohort B EXPANDED feature coverage (ft-cohortb-expand, %s IST). Counts only. Split D only (H sealed, dropped on read).' % f'{dt.datetime.now():%Y-%m-%d %H:%M}', '',
         f'Cohort: every recorded consult (clip index cut + flac, or reb track store; 9 Sep - 19 Oct) whose consult_uid is the anchor of a D-split flagged-Rx episode in '
         f'labels.parquet v2: {len(b)} consults. Eligible (>= {AGE_MIN} d old at {READ}, h14 final): {len(el)} consults, {el.cluster_key.nunique()} patients, '
         f'{el.doctor_uid.nunique()} doctors. H14 positives: {int(el.h14.sum())} consults / {el[el.h14 == 1].cluster_key.nunique()} patients. Label: {b.label_src.iloc[0]}.',
         f'Overlap with ft-audio features.parquet: {int(b.in_ftaudio.sum())} consults ({int(el.in_ftaudio.sum())} eligible, {int(el[el.in_ftaudio].h14.sum())} positives); '
         f'new: {int((~b.in_ftaudio).sum())} ({int((~el.in_ftaudio).sum())} eligible, {int(el[~el.in_ftaudio].h14.sum())} positives).', '',
         '| feature | all (n=%d) | eligible (n=%d) | eligible positives (n=%d) |' % (len(b), len(el), int(el.h14.sum())), '|---|---|---|---|']
for c, name in FEATS: lines.append(f'| {name} | {cov(b, c)} | {cov(el, c)} | {cov(el[el.h14 == 1], c)} |')
ea = b[b.eligible_ale]; Ls = L0[L0.rx_date >= '2026-09-09']; La = np.where(Ls.event_date.notna(), 1.0, np.where(Ls.age_days >= 14, 0.0, np.nan))
lines += ['', '## Ale label (1 = surgery any time up to %s; 0 = >= 14 d old, no surgery; drop = < 14 d old, no surgery)' % READ,
          f'- Recorded anchor consults: {len(ea)} labelled of {len(b)}, {int(ea.ale_label.sum())} positives / {int((ea.ale_label == 0).sum())} negatives; dropped {int((~b.eligible_ale).sum())}. '
          f'Patients {ea.cluster_key.nunique()}, doctors {ea.doctor_uid.nunique()}.',
          f'- Positives by age at read: >= 18 d {int(ea[(ea.age_days >= 18)].ale_label.sum())} (of which surgery after day 14: {int(((ea.ale_label == 1) & (ea.h14 == 0)).sum())}); '
          f'14-17 d {int(ea[(ea.age_days.between(14, 17))].ale_label.sum())}; < 14 d {int(ea[ea.age_days < 14].ale_label.sum())}. Negatives aged 14-17 d (billing lag, may still flip): {int(((ea.ale_label == 0) & (ea.age_days < 18)).sum())}.',
          f'- vs ft-audio: overlap {int(ea.in_ftaudio.sum())} labelled ({int(ea[ea.in_ftaudio].ale_label.sum())} pos); new {int((~ea.in_ftaudio).sum())} ({int(ea[~ea.in_ftaudio].ale_label.sum())} pos).',
          f'- Ceiling, all D episodes with anchor Rx since 9 Sep: {len(Ls)}, labelled {int(pd.notna(La).sum())}, positives {int(np.nansum(La))}; recorded share of positives {int(ea.ale_label.sum())}/{int(np.nansum(La))}.',
          f'- Coverage among Ale-labelled (n={len(ea)}, pos={int(ea.ale_label.sum())}): Jev f07 {cov(ea, "jev_f07")} ({cov(ea[ea.ale_label == 1], "jev_f07")} pos), talk share {cov(ea, "doc_talk_share")} ({cov(ea[ea.ale_label == 1], "doc_talk_share")} pos), '
          f'valence {cov(ea, "pat_valence")} ({cov(ea[ea.ale_label == 1], "pat_valence")} pos), val_change {cov(ea, "val_change")} ({cov(ea[ea.ale_label == 1], "val_change")} pos), language {cov(ea, "consult_lang")}.']
lines += ['', f'Jev source: {cnt(b.jev_src)} (cbx-gapfill = Jev v2, same 31 questions + preamble as p2run_v2, run 19 Oct; failures in jev_gapfill_fail.jsonl: no usable English text).',
          f'Audio status: {cnt(b.audio_status)}. Role source: {cnt(b.role_src)}. Diarization source: {cnt(b.diar_src)}.',
          f'Emotion source: {cnt(b.emo_src)} (ft-audio = copied from ft-audio emo_scored.jsonl, same windows; cbx = Odyssey odyssey_wavlm_dim.v1 run here on the lab box GPU, 19 Oct).',
          f'Audio on disk: clip flac {int(b.has_flac.sum())}; tape cut (cut_caa.py) {int(b.audio_path_ok.sum() - b.has_flac.sum())}; any {int(b.audio_path_ok.sum())}.',
          f'Language mix: {cnt(b.consult_lang)}.']
open(f'{O}/COVERAGE.md', 'w').write('\n'.join(lines) + '\n'); os.chmod(f'{O}/COVERAGE.md', 0o600)
print('\n'.join(lines))
