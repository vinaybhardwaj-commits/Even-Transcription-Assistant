#!/bin/bash
sleep 55
if [ -f /Users/vinaybhardwaj/dev/_fable/measure_baseline.done ]; then
  echo "DONE"
else
  echo "NOT_DONE"
fi
cat /Users/vinaybhardwaj/dev/_fable/measure_baseline.log 2>/dev/null
