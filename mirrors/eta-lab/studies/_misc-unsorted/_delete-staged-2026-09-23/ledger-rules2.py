import os
P='/Users/vinaybhardwaj/dev/Even-Transcription-Assistant/docs/handoff/ETA-FINDINGS-LEDGER.md'
if not os.path.exists(P):
    P=os.path.expanduser('~/mnt/MiniDev/Even-Transcription-Assistant/docs/handoff/ETA-FINDINGS-LEDGER.md')
s=open(P).read(); st=os.stat(P)
old2="""2. **Append one line per finding** under the right heading: what was measured, the number, and the
   evidence path. Nothing longer. If it needs a paragraph, it belongs in a handoff doc — link to it."""
new2="""2. **Append one line per finding** at the END of the file (rule 7 wins over placement): what was measured,
   the number, and the evidence path. Start the finding with its topic in brackets, e.g. `[speech]`,
   `[voiceprints]`. Nothing longer. If it needs a paragraph, it belongs in a handoff doc — link to it."""
old3="""`SUPERSEDES <date> <pane>` and why. The history is the point. **Also** add ` ⚠ SUPERSEDED — see <pane> <date>`
   to the END of the old line, changing none of its text — so a reader who stops at the claim sees the correction."""
new3="""`SUPERSEDES <date> <pane> "<first words of the old line>"` and why. The history is the point. **Only Fable**
   then adds ` ⚠ SUPERSEDED — see <pane> <date>` to the end of the old line. Panes never edit mid-file."""
assert s.count(old2)==1 and s.count(old3)==1, 'header changed; abort'
s2=s.replace(old2,new2).replace(old3,new3)
lines=s2.split('\n')
hit=[i for i,l in enumerate(lines) if l.startswith('- 2026-09-20 scribe3 — Named long turns hold 0.9–5.5 s')]
assert len(hit)==1
if 'SUPERSEDED' not in lines[hit[0]]: lines[hit[0]]+=' ⚠ SUPERSEDED — see scribe3 2026-09-21'
s2='\n'.join(lines)
tmp=P+'.fable.tmp'; open(tmp,'w').write(s2)
st2=os.stat(P)
assert (st2.st_size,st2.st_mtime_ns)==(st.st_size,st.st_mtime_ns), 'file moved under us; abort'
os.replace(tmp,P); print('ok', len(s.splitlines()), '->', len(s2.splitlines()))
