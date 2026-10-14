#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
echo "probe start" > ~/dev/_fable/scratch/probe.log
date >> ~/dev/_fable/scratch/probe.log
whoami >> ~/dev/_fable/scratch/probe.log
pwd >> ~/dev/_fable/scratch/probe.log
echo "probe end" >> ~/dev/_fable/scratch/probe.log
