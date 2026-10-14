#!/bin/bash
sleep 50
if [ -f /Users/vinaybhardwaj/dev/_fable/baseline_docker_check.done ]; then
  echo "DONE"
else
  echo "NOT_DONE"
fi
cat /Users/vinaybhardwaj/dev/_fable/baseline_docker_check.log 2>/dev/null
