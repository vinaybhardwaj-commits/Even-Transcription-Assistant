#!/bin/bash
sleep 50
if [ -f /Users/vinaybhardwaj/dev/_fable/c2_clean_run.done ]; then
  echo "DONE"
else
  echo "NOT_DONE"
fi
cat /Users/vinaybhardwaj/dev/_fable/c2_clean_run.log 2>/dev/null
