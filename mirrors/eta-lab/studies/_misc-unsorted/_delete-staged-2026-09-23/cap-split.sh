#!/bin/zsh
/opt/homebrew/bin/tmux capture-pane -p -S -200 -t split-speaker:1.1 2>&1 || /usr/local/bin/tmux capture-pane -p -S -200 -t split-speaker:1.1 2>&1
