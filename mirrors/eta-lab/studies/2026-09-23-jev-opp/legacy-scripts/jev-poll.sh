#!/bin/zsh
D=/Users/vinaybhardwaj/dev/_fable/jev-run.done
L=/Users/vinaybhardwaj/dev/_fable/jev-run.log
if [ -f "$D" ]; then echo "DONE rc=$(cat $D)"; else echo "RUNNING"; fi
echo "--- tail ---"
tail -n 80 "$L" 2>/dev/null
