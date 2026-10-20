# FT3 features (ft-labels-base, 19 Oct 2026). D split ONLY: H rows are dropped before any feature is joined.
# Sources: labels.parquet; f1-s5 (flag_proc_names, consult time); 10.tsv + clusters (prior flagged Rx in cluster);
# optional pulls if present: data/ft5a.tsv (age_y sex payer_appt payer_bill n_prior_rx), data/ft3b.tsv (ICD, investigations, doctor_gender).
import os,sys,glob,re,json,datetime as dt
import pandas as pd, numpy as np
H=os.path.expanduser; sys.path.insert(0,H('~/oc/forest-lead/ft')); import ftio
OD=H('~/oc/forest-lead/ft/out/ft-labels-base'); DATA=H('~/oc/forest-lead/data')
L=pd.read_parquet(f'{OD}/labels.parquet'); L=L[L.split=='D'].copy()
s5={}
for f in sorted(glob.glob(H('~/wt/forest-funnel-join/.bc/out/f1-s5-*.tsv'))):
    for r in ftio.read_export(f): s5.setdefault(r['prescription_uid'],r)
PROC=[('anorectal',r'hemorrhoid|haemorrhoid|piles|fissur|fistula|sphincterotomy|pilonidal|anal|perian'),
      ('hernia',r'hernia|hernioplasty'),('gallbladder',r'cholecyst'),('circumcision',r'circumc|preputio|frenul'),
      ('ent',r'septo|turbin|fess|sinus surgery|tonsil|adenoid|tympano|myringo|mastoid|polypectomy - nasal|nasal'),
      ('joint_replacement',r'knee replacement|hip replacement|arthroplasty|\btkr\b|\bthr\b'),
      ('ortho_other',r'arthroscop|acl|menisc|orif|fixation|plating|nailing|k-?wire|carpal|trigger|tendon|disc|spine|implant'),
      ('uro_stone',r'\burs\b|rirs|pcnl|lithotr|stone|calcul'),('uro_other',r'turp|cystoscop|stent|prostat|urethr|hydrocel|varicocel|orchi|vasect'),
      ('gyn_major',r'hysterectomy|myomectomy|endometriosis|ovarian|cystectomy|salping|tubal|laparoscop.*(gyn|diagnostic)'),
      ('gyn_minor',r'hysteroscop|d ?& ?c|dilatation and curettage|mirena|polypectomy|cervical|colposcop|leep'),
      ('maternity',r'deliver|lscs|caesar|cesar'),('scopy_diag',r'endoscop|colonoscop|angiogra|biopsy|gastroscop|bronchoscop|sigmoidoscop'),
      ('minor_skin',r'incision|drain|excision|lipoma|sebaceous|cyst|prp|injection|wart|mole|laser hair|abscess|corn'),
      ('vascular',r'varicose|evla|rfa|venous|angioplast|stent(?!.*remov)')]
def procs(r):
    names=[n.lower() for n in re.findall(r'"name":\s*"([^"]*)"',(r or {}).get('flag_proc_names','') or '')]
    cls=next((c for c,p in PROC for n in names if re.search(p,n)),'none' if not names else 'other')
    return cls,len(names)
L['proc_class'],L['n_procs']=zip(*[procs(s5.get(u)) for u in L.prescription_uid])
L['month']=L.rx_date.dt.month; L['month_idx']=(L.rx_date.dt.year-2025)*12+L.rx_date.dt.month-12  # Dec 2025 = 0
L['weekday']=L.rx_date.dt.weekday
# prior flagged Rx of the same cluster since Dec 2025, strictly before this anchor Rx (pre-Rx information only)
pk={r['prescription_uid']:r['patient_key'] for _,r in pd.read_csv(H('~/eta-data/forest/split-input/10.tsv'),sep='\t',dtype=str).iterrows()}
cl=pd.read_csv(H('~/eta-data/forest/split/clusters-2026-10-18.tsv'),sep='\t',dtype=str).set_index('patient_key').cluster_key.to_dict()
allrx=pd.DataFrame([(cl.get(pk.get(u),pk.get(u)),r['consult_ist']) for u,r in s5.items() if u in pk],columns=['cluster_key','ts'])
allrx=allrx[allrx.cluster_key.isin(set(L.cluster_key))]
g=allrx.groupby('cluster_key').ts.apply(sorted).to_dict()
L['n_prior_flagged']=[sum(t<ts for t in g.get(c,[])) for c,ts in zip(L.cluster_key,L.consult_ist)]
avail=['specialty','doctor_id','proc_class','n_procs','month_idx','n_prior_flagged']
# optional pulls
f5=f'{DATA}/ft5a.tsv'
if os.path.exists(f5):
    A=pd.DataFrame(ftio.read_export(f5)).drop_duplicates('prescription_uid')
    A['age_y']=pd.to_numeric(A.age_y,errors='coerce'); A['n_prior_rx']=pd.to_numeric(A.n_prior_rx,errors='coerce')
    A['sex']=A.sex.str.lower().map(lambda s:'f' if s.startswith('f') else 'm' if s.startswith('m') else 'unk')
    A['payer']=A.payer_appt.replace('',np.nan).fillna(A.payer_bill.replace('',np.nan)).fillna('unk')
    L=L.merge(A[['prescription_uid','age_y','sex','payer','n_prior_rx']],on='prescription_uid',how='left')
    L['sex']=L.sex.fillna('unk'); L['payer']=L.payer.fillna('unk'); avail+=['age_y','sex','payer','n_prior_rx']
CH=[('ch_infect','A00','B99'),('ch_neoplasm','C00','D49'),('ch_blood','D50','D89'),('ch_endo','E00','E89'),('ch_mental','F01','F99'),
    ('ch_nervous','G00','G99'),('ch_eye','H00','H59'),('ch_ear','H60','H95'),('ch_circ','I00','I99'),('ch_resp','J00','J99'),
    ('ch_digest','K00','K95'),('ch_skin','L00','L99'),('ch_musc','M00','M99'),('ch_gu','N00','N99'),('ch_preg','O00','O9A'),
    ('ch_symptom','R00','R99'),('ch_injury','S00','T88'),('ch_factors','Z00','Z99')]
def chap(code):
    c=code.strip().upper().replace('.','')[:3]
    return next((n for n,a,b in CH if a<=c<=b),'ch_other') if re.match(r'^[A-Z]\d',c) else None
f3=f'{DATA}/ft3b.tsv'
if os.path.exists(f3):
    B=pd.DataFrame(ftio.read_export(f3)).drop_duplicates('prescription_uid')
    rows=[]
    for _,r in B.iterrows():
        codes=[c for c in set((r.dx_icd or '').split('|')+(r.imp_icd or '').split('|')) if c.strip()]
        d={'prescription_uid':r.prescription_uid,'n_icd':len(codes),'icd_missing':int(not codes)}
        for c in codes:
            k=chap(c)
            if k: d[k]=d.get(k,0)+1
        ni=pd.to_numeric(r.n_inv_uids,errors='coerce'); nf=pd.to_numeric(r.n_further_inv,errors='coerce'); nn=pd.to_numeric(r.num_investigations,errors='coerce')
        tot=np.nansum([ni,nf]); d['inv_missing']=int(not (tot>0 or nn>0)); d['n_inv']=max(tot,0 if np.isnan(nn) else nn)
        g_=(r.doctor_gender or '').lower(); d['doctor_gender']='f' if g_.startswith('f') else 'm' if g_.startswith('m') else 'unk'
        rows.append(d)
    B=pd.DataFrame(rows); chs=[c for c in B.columns if c.startswith('ch_') and (B[c].fillna(0)>0).sum()>=20]
    B[chs]=B[chs].fillna(0); L=L.merge(B[['prescription_uid','n_icd','icd_missing','n_inv','inv_missing','doctor_gender']+chs],on='prescription_uid',how='left')
    L['doctor_gender']=L.doctor_gender.fillna('unk'); avail+=['n_icd','icd_missing','n_inv','inv_missing','doctor_gender']+chs
f4=f'{DATA}/ft3d.tsv'
if os.path.exists(f4):  # non-leaky payer: last appointment strictly before the Rx day
    P=pd.DataFrame(ftio.read_export(f4)).drop_duplicates('prescription_uid')
    P['payer_prior']=P.payer_prior.replace('',np.nan).fillna('none'); P['days_since_prior_appt']=pd.to_numeric(P.days_since_prior_appt,errors='coerce')
    L=L.merge(P[['prescription_uid','payer_prior','days_since_prior_appt']],on='prescription_uid',how='left'); L['payer_prior']=L.payer_prior.fillna('none')
    avail+=['payer_prior','days_since_prior_appt']
f5c=f'{DATA}/ft3c.tsv'
if os.path.exists(f5c):
    U=pd.DataFrame(ftio.read_export(f5c)).drop_duplicates('prescription_uid'); L=L.merge(U[['prescription_uid','has_uhid']],on='prescription_uid',how='left')
    nu=int((L.has_uhid!='1').sum()); print('D anchors without UHID (excluded_no_uhid):',nu); L=L[L.has_uhid=='1'].drop(columns='has_uhid')
L.attrs={}
L.to_parquet(f'{OD}/features_D.parquet',index=False)
json.dump(avail,open(f'{OD}/features_D.cols.json','w'))
print('D rows',len(L),'features',avail); print(L.proc_class.value_counts().to_dict())
