#!/bin/zsh
for N in fix pre; do
  L=/Users/vinaybhardwaj/dev/_fable/r2-wt-$N.log
  [ -f $L ] || continue
  echo "===== wt-$N ====="
  if grep -q '^rc=' $L; then echo "DONE $(grep '^rc=' $L|tail -1)"; else echo "RUNNING"; fi
  grep -E "^ Test Files |^      Tests  |^   Duration |^ FAIL |error TS" $L | tail -14
done
