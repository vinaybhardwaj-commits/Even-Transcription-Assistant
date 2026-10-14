#!/bin/zsh
cd /Users/vinaybhardwaj/dev/_fable || exit 1
python3 j0-coverage.py 2>&1 | tail -80
