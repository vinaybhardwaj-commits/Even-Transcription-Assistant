#!/bin/zsh
D=/Users/vinaybhardwaj/dev/_fable/test-vad.done
L=/Users/vinaybhardwaj/dev/_fable/test-vad.log
if [ -f "$D" ]; then echo "DONE rc=$(cat $D)"; else echo "RUNNING"; fi
echo "--- summary ---"
grep -E "Test Files|Tests  |Duration|FAIL |✗ |error TS" "$L" 2>/dev/null | tail -30
echo "--- progress ---"
grep -c "^ ✓ tests/" "$L" 2>/dev/null
