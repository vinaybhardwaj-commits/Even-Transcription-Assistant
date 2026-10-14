#!/bin/zsh
export PATH=/opt/homebrew/bin:$PATH
cd ~/dev/Even-Transcription-Assistant
git worktree remove --force /tmp/refute-rel && git worktree prune && echo WT_REMOVED
ls /tmp/refute-rel 2>&1 | head -2
git merge-tree --write-tree origin/vinay/s1-auto-drain origin/vinay/eta-qwen-out >/dev/null && echo MERGE_CLEAN
git merge-base --is-ancestor origin/vinay/s1-auto-drain origin/vinay/eta-qwen-out && echo FAST_FORWARD
git status --short | head -5
