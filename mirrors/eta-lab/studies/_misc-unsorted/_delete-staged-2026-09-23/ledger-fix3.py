import os
P='/Users/vinaybhardwaj/dev/Even-Transcription-Assistant/docs/handoff/ETA-FINDINGS-LEDGER.md'
s=open(P).read(); st=os.stat(P); L=s.split('\n'); n=0
for i,l in enumerate(L):
    if l.startswith('- 2026-09-21 scribe3 — [infra] `swift test` passed on this Mini') and 'SUPERSEDED' not in l:
        L[i]=l+' ⚠ SUPERSEDED — see scribe3 2026-09-21'; n+=1
    elif l.startswith('- 2026-09-21 scribe3 — [infra] SUPERSEDES 2026-09-21 scribe3 "`swift test` passed on this Mini"') and 'SUPERSEDED —' not in l:
        L[i]=l+' ⚠ SUPERSEDED — see scribe3 2026-09-21 (counts updated)'; n+=1
st2=os.stat(P); assert (st2.st_size,st2.st_mtime_ns)==(st.st_size,st.st_mtime_ns)
open(P+'.t','w').write('\n'.join(L)); os.replace(P+'.t',P); print('marked',n)
