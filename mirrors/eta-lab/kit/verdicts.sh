#!/bin/zsh
export PATH=/opt/homebrew/bin:$PATH
D=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant/docs/handoff
O=/Users/vinaybhardwaj/dev/_fable/scratch/verdicts.out
: > $O
for f in ETA-SMOOTHER-BRIDGING-REFUTER-VERDICT-23-SEP-2026.md ETA-SMOOTHER-BRIDGING-REFUTER-RECHECK-23-SEP-2026.md ETA-ENCOUNTER-CLOCK-R6-REFUTER-RECHECK-23-SEP-2026.md ETA-ROUTEDCHAT-DEADLINE-R3-REFUTER-RECHECK-23-SEP-2026.md ETA-ROUTER-NUMBERS-R3-REFUTER-RECHECK-23-SEP-2026.md; do
  echo "########## $f" >> $O
  head -45 $D/$f >> $O 2>&1
  echo "" >> $O
done
echo "########## segments-route survivors mention" >> $O
grep -rl "segments-route" $D/*23-SEP*.md >> $O 2>&1
