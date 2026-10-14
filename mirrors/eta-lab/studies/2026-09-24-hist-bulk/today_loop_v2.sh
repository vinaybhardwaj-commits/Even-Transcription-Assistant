#!/bin/bash
# today_loop_v2.sh GROUP — keep one runner group draining tier C (r370/371). v2 (refuter-2 #2264 items 3+5): stops on HALT.<router> (failure-rate halt) or a non-zero runner exit,
# re-plans when windows_tierC.json is older than 15 min (any group, under a flock), and logs a failed plan instead of silently keeping a stale one.
# GROUP: box | vl1 | c13 | c14. Stops when ~/eta-data/hist/STOP, ~/eta-data/hist-mining/STOP or ~/eta-data/hist/LOOP_STOP[.GROUP] exists.
G=$1; D=~/dev/eta-lab/studies/2026-09-24-hist-bulk; HD=~/eta-data/hist; PY=~/.venv-r2/bin/python
case $G in
  box) R=":box"; X="";;
  vl1) R=":vl1"; X="";;
  c13|c14) R=$(for k in 0 1 2 3 4; do printf ":${G}s$k,"; done | sed 's/,$//'); X="--stack-file $HD/stack_versions.json";;
  *) echo "bad group"; exit 2;;
esac
FIRST=${R%%,*}
alive() { pgrep -f "[r]unner.py --tier C --routers $R( |\$)" >/dev/null; }
stopped() { [ -e $HD/STOP ] || [ -e ~/eta-data/hist-mining/STOP ] || [ -e $HD/LOOP_STOP ] || [ -e $HD/LOOP_STOP.$G ] || [ -e $HD/HALT.$FIRST ]; }
while ! stopped; do
  while alive; do sleep 20; done
  if [ -z "$(find $HD/windows_tierC.json -mmin -15 2>/dev/null)" ]; then
    (flock -n 9 || exit 0; cd $D && $PY today_plan.py --settle 20 >> $HD/today_plan.log 2>&1 || echo "$(date +%T) PLAN FAILED (keeping the old plan)" >> $HD/today_plan.log) 9>$HD/.today_plan.lock
  fi
  sleep 65   # a new minute: run ids are minute-stamped
  stopped && break
  (cd $D && nice -n 5 $PY runner.py --tier C --routers $R $X >> $HD/today_$G.log 2>&1) || { echo "$(date +%T) runner exited non-zero: loop $G stops" >> $HD/today_loop.log; break; }
  sleep 240
done
echo "$(date +%T) loop $G ended" >> $HD/today_loop.log
