import os
P='/Users/vinaybhardwaj/dev/Even-Transcription-Assistant/docs/handoff/ETA-FINDINGS-LEDGER.md'
s=open(P).read(); st=os.stat(P)
M=' ⚠ SUPERSEDED — see lx 2026-09-21 (measured)'
out=[]; n=0
for l in s.split('\n'):
    if l.endswith(M) and 'MEASURED' in l and 'NOT MEASURED' not in l.split('SUPERSEDES')[-1][:5] and ('MEASURED. One voice' in l or 'MEASURED and WEAK' in l):
        l=l[:-len(M)]; n+=1
    out.append(l)
assert n==2, n
s2='\n'.join(out)
st2=os.stat(P); assert (st2.st_size,st2.st_mtime_ns)==(st.st_size,st.st_mtime_ns)
open(P+'.t','w').write(s2); os.replace(P+'.t',P); print('fixed',n)
