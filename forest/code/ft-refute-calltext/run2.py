import sys,os,json; exec(open('work/model.py').read())
if os.environ.get('PAYER')=='1':
    c5=pd.read_csv('~/oc/forest-lead/data/ft5a.tsv',sep='\t',dtype=str).drop_duplicates('prescription_uid').set_index('prescription_uid')
    u=D.prescription_uid; p=u.map(c5.payer_appt).replace('',np.nan).fillna(u.map(c5.payer_bill).replace('',np.nan)).fillna('unk').str.lower()
    for k in ('cash','credit','other'): X['payer_'+k]=(p==k).astype(float).values
    print('payer',p.value_counts().to_dict())
seed=int(os.environ.get('SEED','0')); out=[]
for name in sys.argv[1:]:
    H,c,d=name.split('-'); Tl=int(d[2:]); coh=P; E=coh[coh[H].notna()&~(coh.days_to_surgery<=Tl)]
    F,w=callfeats(E,0,lambda E:pd.Series(Tl,index=E.episode_id))
    out.append(run(E,E[H].values,F,seed=seed,tag=name+f' payer={os.environ.get("PAYER","0")} seed={seed}'))
json.dump(out,open(f'work/res2_{os.environ.get("PAYER","0")}_{seed}_{"_".join(sys.argv[1:])}.json','w'),indent=1)
