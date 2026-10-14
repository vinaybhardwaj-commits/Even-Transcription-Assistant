#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd ~/dev/Even-Transcription-Assistant
git fetch origin vinay/eta-qwen-out > ~/dev/_fable/scratch/wt-setup.log 2>&1
git branch -a >> ~/dev/_fable/scratch/wt-setup.log 2>&1
git log -1 --oneline origin/vinay/eta-qwen-out >> ~/dev/_fable/scratch/wt-setup.log 2>&1
git worktree add ~/dev/qo-wt vinay/eta-qwen-out >> ~/dev/_fable/scratch/wt-setup.log 2>&1
echo "exit=$?" >> ~/dev/_fable/scratch/wt-setup.log
