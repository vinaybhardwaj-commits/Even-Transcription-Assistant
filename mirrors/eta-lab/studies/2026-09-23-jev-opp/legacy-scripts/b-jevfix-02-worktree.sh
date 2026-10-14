#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
set -x
cd ~/dev/Even-Transcription-Assistant
git fetch origin vinay/eta-qwen-out
echo "---local branches---"
git branch -a | grep -i eta-qwen-out
echo "---origin commit---"
git log -1 --oneline origin/vinay/eta-qwen-out
echo "---does ~/dev/qo-wt exist---"
ls -la ~/dev/qo-wt 2>&1 | head -5
echo "---worktree add---"
if [ -d ~/dev/qo-wt ]; then
  echo "qo-wt already exists, will pull instead"
else
  git worktree add ~/dev/qo-wt vinay/eta-qwen-out 2>&1 || git worktree add -b vinay/eta-qwen-out ~/dev/qo-wt origin/vinay/eta-qwen-out 2>&1
fi
