#!/bin/zsh
R=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant
git -C $R worktree list | cut -c1-150
git -C $R for-each-ref --sort=-committerdate --count=8 --format='%(refname:short) %(objectname:short) %(committerdate:relative) %(subject)' refs/heads | cut -c1-140
ls -t $R/docs/handoff | head -8
T=/opt/homebrew/bin/tmux
for p in scribe split-speaker lx ETA-Refuter; do echo "== $p $($T display-message -p -t $p:1.1 '#{pane_current_path}')"; done
