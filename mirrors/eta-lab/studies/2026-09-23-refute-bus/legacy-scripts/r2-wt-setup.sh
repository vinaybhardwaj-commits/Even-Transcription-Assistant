#!/bin/zsh
REPO=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow
F=/Users/vinaybhardwaj/dev/_fable
cd $REPO || exit 9
{
echo "--- branches BEFORE (must not change):"
git rev-parse vinay/s1-auto-drain vinay/vad-starvation fable-premerge-vad
git worktree remove --force $F/wt-fix 2>/dev/null
git worktree remove --force $F/wt-pre 2>/dev/null
rm -rf $F/wt-fix $F/wt-pre
git worktree add --detach $F/wt-fix 135d33e
git worktree add --detach $F/wt-pre 8d6b6e8
ln -s $REPO/node_modules $F/wt-fix/node_modules
ln -s $REPO/node_modules $F/wt-pre/node_modules
echo "--- branches AFTER (must be identical):"
git rev-parse vinay/s1-auto-drain vinay/vad-starvation fable-premerge-vad
echo "--- worktrees:"; git worktree list
} 2>&1
