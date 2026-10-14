#!/bin/zsh
cd /Users/vinaybhardwaj/dev/_fable || exit 1
python3 jev-j4-probe.py 2>&1 | tail -200
