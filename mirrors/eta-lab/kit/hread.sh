#!/bin/zsh
# usage: hread.sh [lines] [agents...]  -> writes ~/dev/eta-lab/scratch/hread.out
export PATH=/opt/homebrew/bin:$PATH
N=${1:-12}; shift
if [ $# -gt 0 ]; then A=("$@"); else A=(eta-refuter scribe scribe3 split-speaker lx fleet yoga-drain); fi
O=/Users/vinaybhardwaj/dev/eta-lab/scratch/hread.out
: > $O
# PANES-TO-E2E move (23 Sep 2026): moved panes live in a separate herdr
# "machine" namespace — list both so nothing moved silently disappears
# from this view.
KNOWN_MACHINES=(eta-lab-t4)
herdr agent list 2>/dev/null | python3 -c "
import json,sys
for a in json.load(sys.stdin)['result']['agents']:
    print(a.get('name','(unnamed)'), a.get('agent_status','?'))" >> $O 2>&1
for m in $KNOWN_MACHINES; do
  herdr --machine "$m" agent list 2>/dev/null | python3 -c "
import json,sys
for a in json.load(sys.stdin)['result']['agents']:
    print(a.get('name','(unnamed)'), a.get('agent_status','?'), '[$m]')" >> $O 2>&1
done
for a in $A; do
  echo "=== $a" >> $O
  HFLAGS=()
  if ! herdr agent list 2>/dev/null | grep -q "\"name\":\"$a\""; then
    for m in $KNOWN_MACHINES; do
      if herdr --machine "$m" agent list 2>/dev/null | grep -q "\"name\":\"$a\""; then
        HFLAGS=(--machine "$m"); break
      fi
    done
  fi
  herdr "${HFLAGS[@]}" agent read $a --source recent --lines 200 2>&1 | grep -v '^[[:space:]]*$' | grep -v '────' | tail -$N | cut -c1-170 >> $O
done
