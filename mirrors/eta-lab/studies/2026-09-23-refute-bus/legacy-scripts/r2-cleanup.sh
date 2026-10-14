#!/bin/zsh
REPO=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow
F=/Users/vinaybhardwaj/dev/_fable
cd $REPO || exit 9
git worktree remove --force $F/wt-fix 2>&1
git worktree remove --force $F/wt-pre 2>&1
rm -rf $F/r2tree $F/r2base $F/r2mut
echo "--- branches after cleanup (must be unchanged):"
git rev-parse vinay/s1-auto-drain vinay/vad-starvation fable-premerge-vad
echo "--- repo status:"; git status --porcelain | head
echo "--- worktrees remaining under _fable:"; git worktree list | grep _fable || echo "none"
