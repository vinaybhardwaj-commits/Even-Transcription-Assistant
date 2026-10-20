import json,glob,os,random,collections,sys
sys.path.insert(0,'/nonexistent')
H=os.path.expanduser; R=H('~/oc/palimpsest/ft6/run1')
C=[json.load(open(f)) for f in sorted(glob.glob(R+'/consult-*.json'))]
REF=("<native-redacted>","<native-redacted>","<native-redacted> ","<native-redacted>","<native-redacted>","<native-redacted>","<native-redacted>","<native-redacted>","<native-redacted>","<native-redacted>")
neg=lambda s:any(k in s for k in REF)
J=[(c,j) for c in C for j in c['judged']]
P=[]
P.append(f"judged with refusal term {sum(neg(j['native']) for c,j in J)}/160; all turns {sum(neg(t['native']) for c in C for t in c['turns'])}/{sum(len(c['turns']) for c in C)}")
for h in (True,False):
  s=[j['judge']['scores_by_arm'] for c,j in J if neg(j['native'])==h]
  P.append(f"refusal={h} n={len(s)} mean CUR {sum(x['CUR'] for x in s)/len(s):.2f} S {sum(x['S'] for x in s)/len(s):.2f} M {sum(x['M'] for x in s)/len(s):.2f} CURflips {sum(any(f['arm']=='CUR' for f in j['judge']['flips']) for c,j in J if neg(j['native'])==h)}")
P.append(f"CUR flip native quotes with refusal term {sum(neg(f['native_quote']) for c,j in J for f in j['judge']['flips'] if f['arm']=='CUR')}/20")
# my classification of the 20 CUR flips in dump order: C=clean CUR reversal, O=judge over-call, T=STT/garbled-plausible
cls="TTTOCOTCTCTOCTTOCCCC"
k=0; tag={}
for c in C:
  for j in c['judged']:
    for f in j['judge']['flips']:
      if f['arm']=='CUR': tag[(c['uid'],j['index'])]=cls[k]; k+=1
P.append('my class '+str(dict(collections.Counter(cls))))
def rate(cs,want):
  n=sum(len(c['judged']) for c in cs); return sum(tag.get((c['uid'],j['index']),'-') in want for c in cs for j in c['judged'])/n
rng=random.Random(7); B=10000
for want,nm in (('C','clean only'),('CT','clean+STT-plausible')):
  v=sorted(rate([rng.choice(C) for _ in C],want) for _ in range(B))
  P.append(f"{nm}: point {rate(C,want):.4f} 95%CI {v[250]:.4f} {v[9749]:.4f}")
# M-CUR gap excluding judged turns whose native looks garbled? skip; gap excluding the 20 CUR-flip turns
s=[j['judge']['scores_by_arm'] for c,j in J if not any(f['arm']=='CUR' for f in j['judge']['flips'])]
P.append(f"M-CUR gap excluding CUR-flip turns n={len(s)}: {sum(x['M']-x['CUR'] for x in s)/len(s):.3f}")
P.append(f"CUR flips on turns <=1.5s: {sum(1 for c,j in J for f in j['judge']['flips'] if f['arm']=='CUR' and (c['turns'][j['index']]['t1']-c['turns'][j['index']]['t0'])<=1500)}")
P.append(f"M scored 2 when CUR flip: {sum(j['judge']['scores_by_arm']['M']==2 for c,j in J if any(f['arm']=='CUR' for f in j['judge']['flips']))}/20")
P.append(f"consults by #first48: n/a; affect top value share: turns with affect>=8 {sum(j['affect']>=8 for c,j in J)}")
open('OWN-NUMBERS.txt','a').write('\n# selection / STT-bias\n'+'\n'.join(P)+'\n'); print('\n'.join(P))
