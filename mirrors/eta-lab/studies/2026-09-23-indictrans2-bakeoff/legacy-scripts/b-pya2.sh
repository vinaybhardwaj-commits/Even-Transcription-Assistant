#!/bin/zsh
export PATH=/opt/homebrew/bin:$PATH
cd ~/dev/_fable/scratch/pyabake || exit 1
: > pya_bake.log
nohup python3 ~/dev/_fable/pya_bake.py >> pya_bake.log 2>&1 &
disown
echo "LAUNCHED PID $!"
