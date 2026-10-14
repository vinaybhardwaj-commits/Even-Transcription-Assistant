#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
$TMUX capture-pane -p -S -46 -t lx:1.1 | grep -v '^\s*$' | tail -n 40
