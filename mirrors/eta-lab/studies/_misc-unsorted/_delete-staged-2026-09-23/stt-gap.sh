#!/bin/zsh
cd /Users/vinaybhardwaj/dev/_fable || exit 1
python3 stt-gap.py 2>&1 | tail -80
