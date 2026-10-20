"""ft-calltext join (lane ft-calltext, 19 Oct 2026).
D-split episodes (labels.parquet v2) -> every flagged Rx of the RD-0 cluster -> t1a Runo calls (rh_surgery_leads -> contact_hash ->
rh_runo_call_log, funnel T1 pull) -> t1b db13 summaries (latest summary_ts per call_id).
Prediction-time window per episode: rx_date <= call_day <= rx_date + 14, and call_day < event_date (surgery day) when there is an event.
Day-level only (t1a has a call day, no time), so a same-day-as-surgery call is dropped.
Ambiguity = funnel F1 rule: a lead whose contact_hash maps to >1 patient (f1-s23-s4 n_distinct_patients_per_contact_hash > 1) or a cluster with a
patient_key in the 10e2 shared-phone set. Ambiguous episodes are kept in the table with ambiguous=True; models/rates drop them.
H rows are never loaded past the split filter.
Outputs (0600): out/ft-calltext/calls_D.parquet (one row per episode x call in window) and episodes_D.parquet (D episodes + amb flags)."""
import glob, os, re, sys
import pandas as pd
sys.path.insert(0, '~/oc/forest-lead/ft')
import ftio

OUT = '~/oc/forest-lead/ft/out/ft-calltext'
WIN = 14
lab = pd.read_parquet('~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet')
lab = lab[lab.split == 'D'].copy()
lab['rx_day'] = pd.to_datetime(lab.rx_date).dt.normalize()
lab['ev_day'] = pd.to_datetime(lab.event_date)

coh = pd.read_csv('~/eta-data/forest/split-input/10.tsv', sep='\t', dtype=str)
clu = pd.read_csv('~/eta-data/forest/split/clusters-2026-10-18.tsv', sep='\t', dtype=str)
coh = coh.merge(clu, on='patient_key', how='left')
coh = coh[coh.cluster_key.isin(lab.cluster_key)]

s23 = pd.read_csv('~/wt/forest-funnel-join/.bc/out/f1-s23-s4.tsv', sep='\t', dtype=str, keep_default_na=False)
s23['nh'] = pd.to_numeric(s23.n_distinct_patients_per_contact_hash, errors='coerce').fillna(0)
hash_shared_rx = set(s23.loc[s23.nh > 1, 'prescription_uid']) - {''}
phone_keys = set(pd.read_csv('~/oc/forest-lead/funnel/in/f1-10e2-keys.tsv', sep='\t', dtype=str).patient_key)
amb_phone_ck = set(coh.loc[coh.patient_key.isin(phone_keys), 'cluster_key']) | (set(lab.cluster_key) & phone_keys)

t1a = pd.read_csv('~/oc/forest-lead/funnel/in/t1a-call-ids.tsv', sep='\t', dtype=str)
t1a['call_day'] = pd.to_datetime(t1a.call_day)
t1a['duration'] = pd.to_numeric(t1a.duration, errors='coerce').fillna(0)
t1a['has_recording'] = t1a.has_recording.eq('true')
t1a = t1a.merge(coh[['prescription_uid', 'cluster_key']], on='prescription_uid', how='inner')
t1a['hash_shared'] = t1a.prescription_uid.isin(hash_shared_rx)

recs = []
for f in sorted(glob.glob('~/oc/forest-lead/funnel/in/t1b*.tsv')):
    e = ftio.read_export(f, start=re.compile(r'^[0-9a-f]{24}\t'))
    assert e.bad == 0, f
    recs += e
summ = pd.DataFrame(recs).sort_values('summary_ts').groupby('call_id').tail(1)[['call_id', 'summary_ts', 'summary']]

# episode x call, inside the prediction window
m = lab[['episode_id', 'cluster_key', 'rx_day', 'ev_day']].merge(t1a, on='cluster_key')
d = (m.call_day - m.rx_day).dt.days
keep = (d >= 0) & (d <= WIN) & (m.ev_day.isna() | (m.call_day < m.ev_day))
m = m[keep].assign(day_from_rx=d[keep])
# a call can hang off >1 Rx of the cluster: one row per (episode, call); hash_shared if any lead carrying it is shared
m = (m.groupby(['episode_id', 'call_id'], as_index=False)
       .agg(call_day=('call_day', 'first'), day_from_rx=('day_from_rx', 'first'), duration=('duration', 'max'),
            has_recording=('has_recording', 'max'), hash_shared=('hash_shared', 'max')))
m = m.merge(summ, on='call_id', how='left')

ep_hash = m.groupby('episode_id').hash_shared.max()
# also flag episodes whose cluster has a shared-hash lead at all (even if its calls fall outside the window), as F1 does via credited leads
ck_hash = set(coh.loc[coh.prescription_uid.isin(hash_shared_rx), 'cluster_key'])
lab['amb_hash'] = lab.episode_id.map(ep_hash).fillna(False).astype(bool) | lab.cluster_key.isin(ck_hash)
lab['amb_phone'] = lab.cluster_key.isin(amb_phone_ck)
lab['ambiguous'] = lab.amb_hash | lab.amb_phone
lab['has_lead_rx'] = lab.cluster_key.isin(set(coh.loc[coh.prescription_uid.isin(set(s23.prescription_uid) - {''}), 'cluster_key']))

os.makedirs(OUT, exist_ok=True)
for name, df in (('calls_D.parquet', m), ('episodes_D.parquet', lab.drop(columns=['rx_day', 'ev_day']))):
    p = os.path.join(OUT, name); df.to_parquet(p, index=False); os.chmod(p, 0o600)

print('D episodes', len(lab), 'h14 final', lab.h14.notna().sum(), 'pos', int(lab.h14.sum()), '| h90 final', lab.h90.notna().sum(), 'pos', int(lab.h90.sum()))
print('ambiguous', int(lab.ambiguous.sum()), 'hash', int(lab.amb_hash.sum()), 'phone', int(lab.amb_phone.sum()))
print('window calls', len(m), 'episodes with >=1 window call', m.episode_id.nunique(), 'with summary', int(m.summary.notna().sum()),
      'connected(dur>0)', int((m.duration > 0).sum()))
na = lab[~lab.ambiguous]
w = set(m.episode_id)
for h in ('h14', 'h90'):
    s = na[na[h].notna()]
    print(h, 'non-amb final', len(s), 'pos', int(s[h].sum()), 'with window call', int(s.episode_id.isin(w).sum()),
          'with window summary', int(s.episode_id.isin(set(m.loc[m.summary.notna(), 'episode_id'])).sum()))
