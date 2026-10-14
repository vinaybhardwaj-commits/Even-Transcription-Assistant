#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
for P in scribe3:1.1 split-speaker:1.1 scribe:1.1 ETA-Refuter:1.1; do
  echo "══════ $P"
  $TMUX capture-pane -p -S -16 -t "$P" 2>/dev/null | grep -v '^\s*$' | tail -n 13
  echo
done
echo "══════ drain process?"
ps -axo pid,etime,command | grep -i -E 'night-drain|drain' | grep -v grep | grep -v tmux | head -4
echo "══════ watchdog"
tail -1 /Users/vinaybhardwaj/dev/mini-pressure.jsonl | head -c 260
