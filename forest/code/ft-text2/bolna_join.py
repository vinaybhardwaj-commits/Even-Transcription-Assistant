"""ft-text2 Bolna join. Input: gating-lead's FT8 pull the lab box ~/eta-data/forest/ft8/bolna/bolna-d.tsv (sql ft8-bolna.sql; phone linked inside db13).
- Episode = labels.parquet D row with that prescription_uid (H never loaded past the split filter).
- Call time -> IST. Rows with an offset are converted. Rows without one are read as UTC (in db13 their hour histogram matches the +00:00 rows).
- day_from_rx = IST call day - Rx day (calendar days, as ft-calltext). Window: 0 <= day_from_rx <= 14 and call day < event_date (surgery day).
- Flags: shared_phone (n_uhid_on_phone > 1: records, not people) and the episode's ft-calltext ambiguity flags.
- Language: script counts per transcript (code only; no text printed).
Output (0600): out/ft-text2/bolna_calls.parquet (one row per episode x call in window; transcript kept for the tagger, the lab box only). Counts to stdout."""
import csv, os, re, sys
import pandas as pd
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ft2common as C

SRC = os.path.expanduser('~/eta-data/forest/ft8/bolna/bolna-d.tsv')
csv.field_size_limit(10**8)
b = pd.read_csv(SRC, sep='\t', dtype=str, quoting=csv.QUOTE_NONE, keep_default_na=False)
print('input rows', len(b), 'calls', b.bolna_id.nunique(), 'rx', b.prescription_uid.nunique())
lab = pd.read_parquet(f'{C.HOME}/oc/forest-lead/ft/out/ft-labels-base/labels.parquet')
lab = lab[lab.split == 'D']
ep = pd.read_parquet(f'{C.FTC}/episodes_D.parquet')[['episode_id', 'amb_hash', 'amb_phone', 'ambiguous']]
assert set(b.prescription_uid) <= set(lab.prescription_uid), 'non-D Rx in the Bolna pull'


def ist(s):
    if re.search(r'[+-]\d\d:?\d\d$', s):   # +05:30 or +0530
        return pd.Timestamp(s).tz_convert('Asia/Kolkata').tz_localize(None)
    return pd.Timestamp(s[:19]).tz_localize('UTC').tz_convert('Asia/Kolkata').tz_localize(None)


b['call_ist'] = b.call_created_at.map(ist)
b['call_day'] = b.call_ist.dt.normalize()
m = b.merge(lab[['prescription_uid', 'episode_id', 'rx_date', 'event_date', 'consult_ist']], on='prescription_uid')
m['day_from_rx'] = (m.call_day - pd.to_datetime(m.rx_date).dt.normalize()).dt.days
ev = pd.to_datetime(m.event_date)
print('day_from_rx: <0', int((m.day_from_rx < 0).sum()), '0..14', int(m.day_from_rx.between(0, 14).sum()), '>14', int((m.day_from_rx > 14).sum()),
      '| gating-lead days_from_rx differs from calendar day in', int((pd.to_numeric(m.days_from_rx) != m.day_from_rx).sum()), 'rows')
keep = m.day_from_rx.between(0, 14) & (ev.isna() | (m.call_day < ev))
print('in [0,14]', int(m.day_from_rx.between(0, 14).sum()), 'of which on/after surgery day (dropped)', int((m.day_from_rx.between(0, 14) & ~keep).sum()))
w = m[keep].copy()
w['before_consult_day0'] = (w.day_from_rx == 0) & w.consult_ist.notna() & (w.call_ist < pd.to_datetime(w.consult_ist))
w['shared_phone'] = pd.to_numeric(w.n_uhid_on_phone) > 1
w['conv_duration_s'] = pd.to_numeric(w.conv_duration_s, errors='coerce')
w = w.merge(ep, on='episode_id', how='left')
SCR = {'latin': r'[A-Za-z]', 'devanagari': r'[\u0900-\u097F]', 'kannada': r'[\u0C80-\u0CFF]', 'telugu': r'[\u0C00-\u0C7F]', 'tamil': r'[\u0B80-\u0BFF]'}
for k, rx in SCR.items():
    w[f'chars_{k}'] = w.transcript.str.count(rx)
w['script'] = w[[f'chars_{k}' for k in SCR]].idxmax(axis=1).str[6:]
w['n_chars'] = w.transcript.str.len()
w['n_assistant_lbl'] = w.transcript.str.count(r'(?i)\bassistant\s*:'); w['n_user_lbl'] = w.transcript.str.count(r'(?i)\buser\s*:')
cols = ['episode_id', 'prescription_uid', 'bolna_id', 'call_ist', 'call_day', 'day_from_rx', 'before_consult_day0', 'conv_duration_s', 'status', 'n_uhid_on_phone',
        'shared_phone', 'amb_hash', 'amb_phone', 'ambiguous', 'script', 'n_chars', 'n_assistant_lbl', 'n_user_lbl'] + [f'chars_{k}' for k in SCR] + ['transcript']
nd = int(w.duplicated(['episode_id', 'bolna_id']).sum())
w = w[cols].sort_values(['episode_id', 'call_ist']).drop_duplicates(['episode_id', 'bolna_id'])   # the pull repeats a call once per matching phone record
print('duplicate episode x call rows dropped', nd)
p = f'{C.OUT}/bolna_calls.parquet'; w.to_parquet(p, index=False); os.chmod(p, 0o600)
print('window rows', len(w), 'calls', w.bolna_id.nunique(), 'episodes', w.episode_id.nunique(), '| shared_phone rows', int(w.shared_phone.sum()),
      '| ambiguous episodes', int(w.drop_duplicates('episode_id').ambiguous.sum()), '| day0 before consult', int(w.before_consult_day0.sum()))
print('script', w.drop_duplicates('bolna_id').script.value_counts().to_dict(), '| non-latin chars total',
      int(w.drop_duplicates('bolna_id')[[f'chars_{k}' for k in SCR if k != 'latin']].sum().sum()), 'latin', int(w.drop_duplicates('bolna_id').chars_latin.sum()))
print('speaker labels: calls with assistant:', int((w.drop_duplicates('bolna_id').n_assistant_lbl > 0).sum()), 'user:', int((w.drop_duplicates('bolna_id').n_user_lbl > 0).sum()))
print('day_from_rx', w.day_from_rx.value_counts().sort_index().to_dict(), '| status', w.drop_duplicates('bolna_id').status.value_counts().to_dict())
print('conv_duration_s median', w.drop_duplicates('bolna_id').conv_duration_s.median(), '| n_chars median', w.drop_duplicates('bolna_id').n_chars.median())
