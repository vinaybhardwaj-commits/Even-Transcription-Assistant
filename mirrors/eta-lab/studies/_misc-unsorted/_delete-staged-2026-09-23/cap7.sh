#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
for P in scribe3:1.1 scribe:1.1 yoga-drain:1.1; do
  echo "══════ $P"
  $TMUX capture-pane -p -S -30 -t "$P" 2>/dev/null | grep -v '^\s*$' | tail -n 24
  echo
done
