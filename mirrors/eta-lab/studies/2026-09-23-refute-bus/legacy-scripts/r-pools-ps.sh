#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
sleep 50
ps -axo pid,etime,command | grep -i "unittest" | grep -v grep
tail -c 700 ~/dev/_fable/r-pools3.log
