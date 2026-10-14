#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
$TMUX capture-pane -p -S -40 -t split-speaker:1.1 | grep -v '^\s*$' | tail -n 32
