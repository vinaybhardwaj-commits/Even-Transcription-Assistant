"""Own FT3 features (ft-refute-base, Opus 5.5). D only. Everything is known at/before the Rx."""
import sys; sys.path.insert(0,'~/oc/forest-lead/ft')
from ftio import read_export
import pandas as pd, numpy as np, glob, re
DD='~/oc/forest-lead/data/'
E=pd.read_pickle('work/eps_all.pkl'); E=E[E.split=='D'].copy(); assert set(E.split)=={'D'}
recs=[]
for f in sorted(glob.glob('~/eta-data/forest/funnel/s5-clean/f1-s5-*.tsv')): recs+=read_export(f)
s5=pd.DataFrame(recs).drop_duplicates('prescription_uid').set_index('prescription_uid')
def rd(n):
    e=read_export(DD+n); print(n,'rows',len(e),'bad',e.bad); return pd.DataFrame(e).drop_duplicates('prescription_uid').set_index('prescription_uid')
b,c,d,a=rd('ft3b.tsv'),rd('ft3c.tsv'),rd('ft3d.tsv'),rd('ft5a.tsv')
ds=pd.read_csv('~/oc/forest-lead/ft/doctor_specialty.tsv',sep='\t',dtype=str).set_index('doctor_uid').specialty
F=E[['prescription_uid','cluster_key','rx_date','consult_ist','doctor_uid','h14','h90','days_to_surgery']].copy().set_index('prescription_uid')
u=F.index
print('missing b/c/d/a',(~u.isin(b.index)).sum(),(~u.isin(c.index)).sum(),(~u.isin(d.index)).sum(),(~u.isin(a.index)).sum())
sp=F.doctor_uid.map(ds).fillna('Unknown')
MAP={'General Surgery':'GS','GI Surgery':'GS','Gynaecology':'Gyn','Orthopaedics':'Ortho','Urology':'Uro','ENT':'ENT'}
F['spec_raw']=sp; F['spec']=sp.map(MAP).fillna('Other')
names=s5.loc[u,'flag_proc_names'].map(lambda v: ' | '.join(re.findall(r"'name': '([^']*)'",str(v))).lower())
F['n_procs']=names.map(lambda s: 0 if not s else s.count(' | ')+1)
RULES=[('none',r'^$'),('anorectal',r'hemorrh|haemorrh|fissur|sphincter|fistul|pilonidal|perianal|\beua'),('hernia',r'hernia'),
 ('gallbladder',r'cholecyst'),('joint_repl',r'knee replacement|hip replacement|\btkr|\bthr'),('arthroscopy',r'arthroscop|acl|meniscus|meniscal|rotator|bankart|labral'),
 ('ent',r'septo|turbino|tympano|mastoid|tonsil|fess|adenoid|tongue tie'),('gyn_major',r'hysterectomy|myomectomy|ovarian|endometriosis|salping|\bbso|laparoscop.*gyn|diagnostic lap'),
 ('gyn_minor',r'hysteroscop|mirena|merina|d&c|mtp|delivery|lscs|cerclage'),('circumcision',r'circumcis|frenulo'),
 ('uro_endo',r'\burs\b|rirs|turp|cystoscop|holep|prostat|stent|oiu|urethr|varicocele|hydrocel'),('scope_dx',r'colonoscop|endoscopy|angiogra'),
 ('vascular',r'evlt|varicose|sclero|perforator'),('cosmetic',r'prp|liposuc|laser ec|rhinoplasty|mole'),
 ('minor_excision',r'lipoma|cyst|excision|biopsy|incision|drain|wart|nail|debridement|swelling|cauteris'),('ortho_other',r'orif|reduction|cast|implant|manipulation')]
def pc(s):
    for k,r in RULES:
        if re.search(r,s): return k
    return 'other'
F['proc']=names.map(pc)
print(F.proc.value_counts().to_dict())
icd=(b.loc[u,'dx_icd'].fillna('')+'|'+b.loc[u,'imp_icd'].fillna('')).map(lambda s:[x for x in s.split('|') if x])
F['n_icd']=icd.map(len); F['icd_ch']=icd.map(lambda l: l[0][0].upper() if l else 'none')
num=lambda s: pd.to_numeric(s.replace({'':np.nan,'None':np.nan}),errors='coerce')
F['n_inv']=num(b.loc[u,'num_investigations']); F['n_inv_uids']=num(b.loc[u,'n_inv_uids']); F['n_further_inv']=num(b.loc[u,'n_further_inv'])
F['inv_missing']=F.n_inv.isna().astype(int)
F['doc_gender']=b.loc[u,'doctor_gender'].replace('','unk').fillna('unk')
F['has_uhid']=num(c.loc[u,'has_uhid'])
F['payer_prior']=d.loc[u,'payer_prior'].replace('','none').fillna('none'); F['days_prior_appt']=num(d.loc[u,'days_since_prior_appt'])
F['payer_sameday']=a.loc[u,'payer_appt'].replace('','none').fillna('none')  # LEAKY, never in primary
F['age']=num(a.loc[u,'age_y']); F['sex']=a.loc[u,'sex'].replace('','unk').fillna('unk'); F['n_prior_rx']=num(a.loc[u,'n_prior_rx'])
ts=pd.to_datetime(F.consult_ist.str[:19]); F['dow']=ts.dt.dayofweek; F['hour']=ts.dt.hour
for col in ['n_icd','n_inv','n_further_inv','doc_gender','has_uhid','payer_prior','days_prior_appt','age','sex','n_prior_rx','payer_sameday']:
    v=F[col]; fill=(v.notna()&~v.isin(['none','unk'])).mean() if v.dtype==object else v.notna().mean()
    print(f'fill {col} {fill:.2f}')
F.to_pickle('work/feat_D.pkl')
print(F.shape, F.spec.value_counts().to_dict())
