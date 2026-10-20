import pandas as pd, csv, re
csv.field_size_limit(10**8)
b = pd.read_csv('~/eta-data/forest/ft8/bolna/bolna-d.tsv', sep='\t', dtype=str, quoting=csv.QUOTE_NONE, keep_default_na=False)
print('offsets', b.call_created_at.str.extract(r'([+-]\d\d:\d\d)$')[0].fillna('none').value_counts().to_dict())
off = b.call_created_at.str.contains(r'[+-]\d\d:\d\d$')
utc = pd.to_datetime(b.call_created_at, utc=True, format='ISO8601')  # naive -> UTC
b['t_utc'] = utc
# hour histograms UTC
print('hour hist offset rows', b[off].t_utc.dt.hour.value_counts().sort_index().to_dict())
print('hour hist naive rows(as UTC)', b[~off].t_utc.dt.hour.value_counts().sort_index().to_dict())
l = pd.read_parquet('~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet', columns=['split','prescription_uid','episode_id','rx_date','event_date'])
l = l[l.split=='D'].drop(columns='split')
def win(naive_as):
    t = utc.copy()
    if naive_as == 'IST':
        t[~off] = pd.to_datetime(b.call_created_at[~off].str[:19]).dt.tz_localize('Asia/Kolkata').dt.tz_convert('UTC')
    d = b.assign(day=t.dt.tz_convert('Asia/Kolkata').dt.tz_localize(None).dt.normalize()).merge(l, on='prescription_uid')
    d['dfr'] = (d.day - d.rx_date.dt.normalize()).dt.days
    ev = pd.to_datetime(d.event_date)
    k = d[(d.dfr >= 0) & (d.dfr <= 14) & (ev.isna() | (d.day < ev))].drop_duplicates(['episode_id', 'bolna_id'])
    allw = d[(d.dfr >= 0) & (d.dfr <= 14)].drop_duplicates(['episode_id', 'bolna_id'])
    return k, allw, d
for na in ('UTC', 'IST'):
    k, allw, d = win(na)
    print(na, 'rows', len(k), 'calls', k.bolna_id.nunique(), 'eps', k.episode_id.nunique(), '| window before surgery filter calls', allw.bolna_id.nunique(),
          '| dfr<3', k[k.dfr<3].bolna_id.nunique(), '<7', k[k.dfr<7].bolna_id.nunique(), 'day0', k[k.dfr==0].bolna_id.nunique(),
          '| dfr dist', k.dfr.value_counts().sort_index().to_dict(), '| days_from_rx disagree', int((pd.to_numeric(d.days_from_rx)!=d.dfr).sum()))
    if na=='UTC': K=k
K[['episode_id','bolna_id','dfr']].to_csv('own_window.csv', index=False)
