#!/bin/zsh
T=/opt/homebrew/bin/tmux
$T capture-pane -p -t lx:1.1 | grep -v '^\s*$' | tail -14 | cut -c1-200
