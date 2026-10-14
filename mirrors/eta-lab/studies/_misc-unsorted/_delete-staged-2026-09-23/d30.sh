#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
RULE="LEDGER RULE UPDATE, read the new rules 3 and 7 at the top of docs/handoff/ETA-FINDINGS-LEDGER.md. Rule 7: write ONLY by appending, cat >> file <<EOF. Never read-modify-write the whole file - several of you are writing it concurrently and a read-modify-write from two panes at once silently deletes the other's lines. Rule 3 addition: when you supersede a line, also add ' ⚠ SUPERSEDED — see <pane> <date>' to the END of the old line without changing its text, so a reader who stops at the claim sees the correction. lx raised that problem and it was right."
for P in scribe3:1.1 split-speaker:1.1 yoga-drain:1.1 lx:1.1 ETA-Refuter:1.1 scribe:1.1; do
  $TMUX send-keys -t $P C-u; sleep 1
  $TMUX send-keys -t $P "$RULE"; sleep 2
  $TMUX send-keys -t $P Enter; sleep 2
  $TMUX send-keys -t $P Enter; sleep 1
  echo "sent -> $P"
done
$TMUX send-keys -t fleet:1.1 C-u; sleep 1
$TMUX send-keys -t fleet:1.1 "Your last turn was cut off by an API connection drop just before you appended - nothing of yours reached the ledger, I checked, so there is no partial write to clean up. Resume: append your nine verified findings to docs/handoff/ETA-FINDINGS-LEDGER.md. $RULE Good call dropping the route-outcome finding once you found the adapter already reads segmentation.outcome - that is exactly what the ledger is for. Confirm the line count before and after."; sleep 2
$TMUX send-keys -t fleet:1.1 Enter; sleep 2
$TMUX send-keys -t fleet:1.1 Enter; sleep 1
echo "sent -> fleet"
echo
echo "=== watchdog: last exit -9, is it alive and logging? ==="
launchctl list com.vinaybhardwaj.eta-pressure-watchdog 2>&1 | grep -E 'PID|LastExitStatus'
tail -2 /Users/vinaybhardwaj/dev/mini-pressure.jsonl | cut -c1-200
