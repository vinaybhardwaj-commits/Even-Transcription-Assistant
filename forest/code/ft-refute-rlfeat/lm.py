import pandas as pd, numpy as np, os
H=os.path.expanduser
P=pd.read_parquet(H('~/oc/forest-lead/ft/out/ft-rl-feat/call_audio_feats.parquet'))
L=pd.read_parquet(H('~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet'))[['episode_id','days_to_surgery']]
P=P.merge(L,on='episode_id')
C=pd.read_parquet(H('~/eta-data/forest/rl/feat/calls_basic.parquet')); S=pd.read_parquet('S.parquet'); keep=set(S[S.keep].key_id)
for T in (3,7,14):
    w=P[P[f'n_calls_t{T}']>0]
    pre=w.days_to_surgery<T
    pos=w.h14==1
    print(f'T={T}: h14 pos {int(pos.sum())}, of which event day < T {int((pos&pre).sum())}; at-risk set (no event before T): eps {int((~pre).sum())}, h14 {int(w[~pre].h14.sum())}/{int(w[~pre].h14.notna().sum())}, h90 {int(w[~pre].h90.sum())}/{int(w[~pre].h90.notna().sum())}')
    print('   mean n_calls: pre-event pos',round(w[pre][f'n_calls_t{T}'].mean(),2),' at-risk pos',round(w[~pre&pos][f'n_calls_t{T}'].mean(),2),' neg',round(w[w.h14==0][f'n_calls_t{T}'].mean(),2))
    k=C[C.call_id.isin(keep)&(C.day_from_rx<T)].groupby('episode_id').agg(m=('audio_dur_s','sum'),ps=('patient_talk_share','mean'),sp=('speech_s','sum'))
    j=P.set_index('episode_id').join(k,how='inner')
    print('   minutes vs sum(audio_dur)/60 agree',int(np.isclose(j[f'minutes_t{T}'],j.m/60,rtol=.01).sum()),'/',len(j),
          ' speech_min agree',int(np.isclose(j[f'speech_min_t{T}'],j.sp/60,rtol=.01).sum()),
          ' patient_talk_share(mean of calls) agree',int((np.isclose(j[f'patient_talk_share_t{T}'],j.ps,rtol=.01)|(j.ps.isna()&j[f'patient_talk_share_t{T}'].isna())).sum()))
