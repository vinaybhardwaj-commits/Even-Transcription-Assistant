# FT1 timing: p3a_counts rules (convert-lead sha 490f5dc17bd3, copied verbatim for R1/R2/R4 + episode logic) on the refreshed f1-s5 chunks.
# Episode key = RD-0 cluster key (via 10.tsv prescription_uid -> patient_key -> clusters), not per-chunk patient_grp. Counts only on stdout.
import csv,re,collections,datetime as dt,glob,os,sys
R1=re.compile(r'LSCS|caesarean|cesarean|vaginal delivery|\bNVD\b|delivery|cerclage|evacuation|ERPC|RPOC|abortion|products of conception|MTP',re.I)
R2=re.compile(r'dressing|injection|suture removal|I ?& ?D under LA|wart|foreign body',re.I)
R4=re.compile(r'stent removal|removal of .*stent|DJ stent|check URS|re-?look|implant removal|second stage',re.I)
nz=lambda v: v not in ('',None,'None','NULL')
READ=dt.date.fromisoformat(sys.argv[1]) if len(sys.argv)>1 else dt.date(2026,10,19)
H=os.path.expanduser
pk={r['prescription_uid']:r['patient_key'] for r in csv.DictReader(open(H('~/eta-data/forest/split-input/10.tsv')),delimiter='\t')}
cl={r['patient_key']:r['cluster_key'] for r in csv.DictReader(open(H('~/eta-data/forest/split/clusters-2026-10-18.tsv')),delimiter='\t')}
spec={}
if os.path.exists(H('~/oc/forest-lead/ft/doctor_specialty.tsv')):
    spec={r['doctor_uid']:r['specialty'] for r in csv.DictReader(open(H('~/oc/forest-lead/ft/doctor_specialty.tsv')),delimiter='\t')}
START=re.compile(r'^[A-Za-z0-9]{20}\t')
def read_s5(f):
    # gating-lead CSV exports carry unescaped newlines/quotes in free-text fields: rebuild records by uid start
    lines=open(f,encoding='utf-8',errors='replace').read().split('\n'); hdr=lines[0].split('\t'); recs=[]
    for ln in lines[1:]:
        if not ln: continue
        if START.match(ln) or not recs: recs.append(ln)
        else: recs[-1]+=' '+ln
    for r in recs:
        p=[x.strip('"') for x in r.split('\t')]
        if len(p)==len(hdr): yield dict(zip(hdr,p))
rows={}
for f in sorted(glob.glob(H('~/wt/forest-funnel-join/.bc/out/f1-s5-*.tsv'))):
    for r in read_s5(f): rows.setdefault(r['prescription_uid'],r)
out=[];nokey=0
for r in rows.values():
    d=dt.date.fromisoformat(r['consult_ist'][:10])
    if d<dt.date(2025,12,1): continue
    k=pk.get(r['prescription_uid'])
    if not k: nokey+=1; continue
    ds=[r[x] for x in ('first_ot_date','first_bill_date') if nz(r[x])]
    ev=min(ds)[:10] if ds else None
    name=(r['first_surgery_name'] or '')+' | '+(r['first_bill_items'] or '')
    excl=None
    if ev:
        if R1.search(name) or r['first_adm_type']=='Maternity': excl='R1'
        elif R4.search(name): excl='R4'
        elif R2.search(r['first_surgery_name'] or '') or (r['first_bill_date'][:10]==r['consult_ist'][:10] if nz(r['first_bill_date']) else False) and not nz(r['first_ot_date']) and (r['first_adm_date'] or '')[:10]!=r['consult_ist'][:10]: excl='R2'
    out.append(dict(r=r,d=d,ev=ev,excl=excl,el=(READ-d).days,c=cl.get(k,k),sp=spec.get(r['doctor_uid'],'unknown')))
eps={}
for o in sorted(out,key=lambda o:o['d']):
    if o['ev'] and not o['excl']:
        key=(o['c'],o['ev'])
        if key not in eps: eps[key]=o
mat=[o for o in out if o['el']>=94]
me=[o for o in eps.values() if o['el']>=94]
print(f"read {READ} rx_since_dec {len(out)} no_key {nokey} matured_rx {len(mat)} matured_clusters {len({o['c'] for o in mat})} matured_pos_episodes {len(me)} rate_per_matured_rx {len(me)/len(mat):.3f}")
def cum(eplist,label):
    lags=sorted((dt.date.fromisoformat(o['ev'])-o['d']).days for o in eplist); n=len(lags)
    if not n: print(label,'n 0'); return
    cs=' '.join(f"d{t}:{sum(l<=t for l in lags)/n:.0%}" for t in (0,3,7,14,21,30,60,90))
    print(f"{label} n_pos {n} median_lag {lags[n//2]} | {cs}")
cum(me,'ALL')
by=collections.defaultdict(list)
for o in me: by[o['sp']].append(o)
nmat=collections.Counter(o['sp'] for o in mat)
for s,l in sorted(by.items(),key=lambda x:-len(x[1])):
    if len(l)>=10: cum(l,f"SPEC[{s}] matured_rx {nmat[s]}")
small=sum(len(l) for s,l in by.items() if len(l)<10); print('specialties with <10 positives pooled:',small)
# H14 false negatives: H90 positives with lag > 14
fn=sum(1 for o in me if (dt.date.fromisoformat(o['ev'])-o['d']).days>14)
print(f"H14 misses among matured H90 positives: {fn}/{len(me)} = {fn/len(me):.1%}")
