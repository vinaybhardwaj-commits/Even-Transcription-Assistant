#!/bin/zsh
T=/opt/homebrew/bin/tmux
for p in scribe split-speaker lx ETA-Refuter; do echo "== $p"; $T capture-pane -p -t $p:1.1 | grep -v '^\s*$' | tail -4 | cut -c1-160; done
