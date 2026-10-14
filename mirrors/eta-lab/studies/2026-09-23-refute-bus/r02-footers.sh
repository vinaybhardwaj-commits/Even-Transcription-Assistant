export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
ls -la@ /Users/vinaybhardwaj/.claude/settings.json
stat -f 'mtime=%Sm' /Users/vinaybhardwaj/.claude/settings.json
ls -la /Users/vinaybhardwaj/.claude/backups 2>/dev/null | tail -5
grep -n "model" /Users/vinaybhardwaj/dev/_fable/scratch/herdr-ctl.log | tail -20
for n in eta-refuter fleet lx scribe scribe3 split-speaker yoga-drain minibot minibot-2 refuter-gate eta-assistant; do
  echo "===== $n"
  herdr agent read "$n" --source visible --lines 6 2>&1 | tail -6
done
echo "===== wD:p2"
herdr pane read wD:p2 --source visible --lines 6 2>&1 | tail -6
