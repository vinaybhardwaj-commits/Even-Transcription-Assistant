#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
set -x
cd ~/dev/Even-Transcription-Assistant
git worktree list
echo "---"
ls -la ~/dev | grep -E "qo-wt|eta-qwen-out-wt|Even-Transcription"
echo "---"
if [ -d ~/dev/qo-wt ]; then
  echo "found qo-wt"
  WT=~/dev/qo-wt
elif [ -d ~/dev/eta-qwen-out-wt ]; then
  echo "found eta-qwen-out-wt"
  WT=~/dev/eta-qwen-out-wt
else
  echo "no worktree found"
  WT=""
fi
echo "WT=$WT"
if [ -n "$WT" ]; then
  cd "$WT"
  git status
  echo "---branch---"
  git branch --show-current
  echo "---remote---"
  git remote -v
fi
