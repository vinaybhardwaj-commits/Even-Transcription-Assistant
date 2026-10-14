#!/bin/bash
sleep 55
if [ -f /Users/vinaybhardwaj/dev/_fable/final_full_run.done ]; then
  echo "DONE"
else
  echo "NOT_DONE"
fi
cat /Users/vinaybhardwaj/dev/_fable/final_full_run.log 2>/dev/null
