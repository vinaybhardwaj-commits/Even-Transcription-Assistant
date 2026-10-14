#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
for P in split-speaker:1.1 fleet:1.1 scribe3:1.1 scribe:1.1 yoga-drain:1.1; do
  echo "═══════ $P ═══════"
  $TMUX capture-pane -p -S -34 -t "$P" 2>/dev/null | grep -v '^\s*$' | tail -n 26
  echo
done
