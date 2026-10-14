#!/bin/zsh
REPO=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow
F=/Users/vinaybhardwaj/dev/_fable
cd $REPO || exit 9
for W in fix pre mut; do
  git worktree remove --force $F/wt3-$W 2>/dev/null
  rm -rf $F/wt3-$W
done
git worktree prune
echo "--- branch pointers after cleanup (must be unchanged):"
git rev-parse vinay/s1-auto-drain vinay/fuse-jev-reachable
echo "--- repo status:"; git status --porcelain | head -6
echo "--- worktrees left under _fable:"; git worktree list | grep _fable || echo "none"
echo "--- disk:"; df -h / | tail -1
