#!/bin/zsh
export PATH=/opt/homebrew/bin:$PATH
R=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant
O=/Users/vinaybhardwaj/dev/_fable/scratch/status.out
echo "=== time" > $O
date '+%H:%M IST %d-%b' >> $O
echo "=== prod branch head (origin/vinay/s1-auto-drain)" >> $O
git -C $R log --oneline -8 origin/vinay/s1-auto-drain >> $O 2>&1
echo "=== local head" >> $O
git -C $R log --oneline -3 vinay/s1-auto-drain >> $O 2>&1
echo "=== ahead/behind" >> $O
git -C $R rev-list --left-right --count origin/vinay/s1-auto-drain...vinay/s1-auto-drain >> $O 2>&1
echo "=== recent branches" >> $O
git -C $R for-each-ref --sort=-committerdate --format='%(committerdate:short) %(refname:short) %(objectname:short)' refs/heads/ >> $O 2>&1 | head -20
echo "=== night-drain" >> $O
grep -c '"event":"window"' /Users/vinaybhardwaj/night-drain/night-drain.log >> $O 2>&1
tail -2 /Users/vinaybhardwaj/night-drain/night-drain.log >> $O 2>&1
echo "=== infra" >> $O
uptime >> $O
tail -1 /Users/vinaybhardwaj/dev/mini-pressure.jsonl >> $O
echo "=== new refuter docs" >> $O
ls -t $R/docs/handoff/ >> $O 2>&1
