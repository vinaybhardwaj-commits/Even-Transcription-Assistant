#!/bin/zsh
D=/Users/vinaybhardwaj/dev/_fable/full-test.done
L=/Users/vinaybhardwaj/dev/_fable/full-test.log
if [ -f "$D" ]; then echo "DONE rc=$(cat $D)"; else echo "RUNNING"; fi
echo "--- tail ---"
tail -n 120 "$L" 2>/dev/null
echo "--- fail grep ---"
grep -E "FAIL |failed|Test Files|Tests  |Duration|error TS" "$L" 2>/dev/null | tail -40
