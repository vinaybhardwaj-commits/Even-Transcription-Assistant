#!/bin/zsh
D=/Users/vinaybhardwaj/dev/_fable/test-vad.done
L=/Users/vinaybhardwaj/dev/_fable/test-vad.log
for i in $(seq 1 9); do
  [ -f "$D" ] && break
  sleep 5
done
if [ -f "$D" ]; then echo "DONE rc=$(cat $D)"; else echo "STILL RUNNING after 45s ($(grep -c '^ ✓ tests/' "$L") files green)"; fi
echo "--- summary ---"
grep -E "Test Files|Tests  |Duration|error TS" "$L" 2>/dev/null | tail -20
echo "--- failures ---"
grep -E "^ ❯|✗ |FAIL " "$L" 2>/dev/null | head -20
