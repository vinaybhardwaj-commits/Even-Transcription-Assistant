#!/bin/bash
# today_loop.sh GROUP — keep one runner group draining tier C (r370/371): wait until no runner of this group is alive, re-plan (group c13 only), start it, repeat.
# GROUP: box | vl1 | c13 | c14. Stops when ~/eta-data/hist/STOP or ~/eta-data/hist-mining/STOP exists, or ~/eta-data/hist/LOOP_STOP exists.
G=$1; D=~/dev/eta-lab/studies/2026-09-24-hist-bulk; HD=~/eta-data/hist; PY=~/.venv-r2/bin/python
case $G in
  box) R=":box"; X="";;
  vl1) R=":vl1"; X="";;
  c13|c14) R=$(for k in 0 1 2 3 4; do printf ":${G}s$k,"; done | sed 's/,$//'); X="--stack-file $HD/stack_versions.json";;
  *) echo "bad group"; exit 2;;
esac
alive() { pgrep -f "[r]unner.py --tier C --routers $R( |\$)" >/dev/null; }
while [ ! -e $HD/STOP ] && [ ! -e ~/eta-data/hist-mining/STOP ] && [ ! -e $HD/LOOP_STOP ]; do
  while alive; do sleep 20; done
  [ "$G" = c13 ] && (cd $D && $PY today_plan.py --settle 20 >> $HD/today_plan.log 2>&1)
  sleep 65   # a new minute: run ids are minute-stamped
  (cd $D && nice -n 5 $PY runner.py --tier C --routers $R $X >> $HD/today_$G.log 2>&1)
  sleep 240
done
