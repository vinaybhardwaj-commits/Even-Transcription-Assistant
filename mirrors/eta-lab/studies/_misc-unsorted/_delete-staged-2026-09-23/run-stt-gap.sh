#!/bin/zsh
chmod +x /Users/vinaybhardwaj/dev/_fable/*.sh 2>/dev/null
cd /Users/vinaybhardwaj/dev/_fable || exit 1
python3 stt-gap.py 2>&1 | tail -90
