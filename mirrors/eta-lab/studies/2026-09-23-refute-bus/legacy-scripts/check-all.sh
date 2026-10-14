#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
L=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant/docs/handoff/ETA-FINDINGS-LEDGER.md
echo "=== LEDGER: lines, header intact, sections ==="
wc -l < $L; head -1 $L; grep -c '^## ' $L; grep '^## ' $L
echo "--- lines added by panes (not from seed) ---"
grep -E '^- 2026-09-21 (fleet|lx|scribe |scribe3|yoga-drain|split-speaker|ETA-Refuter)' $L | wc -l
tail -4 $L | cut -c1-160
echo
for P in fleet:1.1 scribe:1.1 scribe3:1.1 split-speaker:1.1 ETA-Refuter:1.1 yoga-drain:1.1 lx:1.1; do
  echo "══════ $P"
  $TMUX capture-pane -p -S -12 -t "$P" 2>/dev/null | grep -v '^\s*$' | grep -v 'auto mode on' | grep -v '^─' | tail -n 6
done
echo
echo "══════ drain / launchd"
launchctl list | grep -i -E 'night-drain|pressure' 
ps -axo pid,etime,ppid,command | grep night-drain.mjs | grep -v grep | head -3
