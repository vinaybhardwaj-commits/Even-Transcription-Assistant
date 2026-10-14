#!/bin/zsh
for N in tree base; do
  L=/Users/vinaybhardwaj/dev/_fable/r2-$N.log
  [ -f $L ] || continue
  echo "===== r2$N ====="
  if grep -q '^rc=' $L; then echo "DONE $(grep '^rc=' $L | tail -1)"; else echo "RUNNING"; fi
  grep -E "^ Test Files |^      Tests  |^   Duration |^ FAIL " $L | tail -12
done
