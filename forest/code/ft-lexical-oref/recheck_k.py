import sys,collections
sys.path.insert(0,'~/oc/forest-lead/ft/out/ft-lexical/code'); import common as C, lex
its=C.items(); U=C.units(); L=C.label_map(U,'ale','consult')
weak={i['item_id'] for i in its if i['corpus']=='K' and i['feat_role_src']=='caa-weak'}
print('caa-weak consults', len(weak), 'ale-labelled', sum(1 for u in weak if u in L), 'conv', sum(L.get(u,0) for u in weak))
its2=[i for i in its if i['item_id'] not in weak]
for nm,II in (('lane',its),('no caa-weak',its2)):
    UT=lex.unit_terms(II,'K','doctor',False); df,(n,npos)=lex.one(UT,L)
    print(nm,n,npos,len(df)); print(df[df.term.isin(['day','and if you','weeks','the first'])][['term','n_unit_conv','n_unit_non','p']].to_string())
