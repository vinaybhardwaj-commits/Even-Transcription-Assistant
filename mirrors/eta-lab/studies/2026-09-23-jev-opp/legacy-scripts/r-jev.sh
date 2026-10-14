#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd ~/dev/Even-Transcription-Assistant || exit 1
git worktree remove --force /tmp/refute-jev && echo removed
git worktree list | grep refute-jev || echo "no refute worktree"
