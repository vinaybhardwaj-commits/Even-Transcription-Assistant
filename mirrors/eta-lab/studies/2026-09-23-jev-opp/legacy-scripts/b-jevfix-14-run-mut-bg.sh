#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
nohup zsh /Users/vinaybhardwaj/dev/_fable/r-jevfix-mut.sh > ~/dev/_fable/scratch/jevfix-mut-nohup.log 2>&1 &
echo "launched pid=$!"
