#!/bin/bash
sleep 55
if [ -f /Users/vinaybhardwaj/dev/_fable/full_test_run.done ]; then
  echo "DONE"
  tail -150 /Users/vinaybhardwaj/dev/_fable/full_test_run.log
else
  echo "NOT_DONE"
  tail -20 /Users/vinaybhardwaj/dev/_fable/full_test_run.log 2>/dev/null
fi
