#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
nohup zsh /Users/vinaybhardwaj/dev/_fable/b-jevfix-12-typecheck.sh > ~/dev/_fable/scratch/jev-typecheck-nohup.log 2>&1 &
echo "launched pid=$!"
