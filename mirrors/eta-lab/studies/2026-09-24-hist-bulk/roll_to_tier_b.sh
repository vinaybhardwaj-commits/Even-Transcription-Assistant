#!/bin/bash
echo "RETIRED: the HIST nodes were deleted on 25 Sep 06:25 (Fable/V); this script must not run" >&2; exit 1
# roll_to_tier_b.sh — ruling 271: when a Tier A process exits (its queue is empty: it steals everything), start the Tier B process on the SAME routers (claims + steal keep the processes disjoint).
HD=$HOME/eta-data/hist; DIR=$HOME/dev/eta-lab/studies/2026-09-24-hist-bulk; PY=$HOME/.venv-r2/bin/python
roll() {  # $1 = first router key of the Tier A process, $2.. = the Tier B command tail
  first="$1"; shift
  ( while pgrep -f "python runner.py.*--routers ${first}[, ]?" >/dev/null || pgrep -f "python runner.py .*--routers ${first}\$" >/dev/null; do sleep 15; done
    cd $DIR; echo "$(date +%T) Tier A process on ${first} exited; starting Tier B" >> $HD/roll.log
    nohup $PY runner.py --tier B "$@" > $HD/runB_${first//:/}.log 2>&1 & ) &
}
CPU12=:30100,:30101,:30102,:30103,:30104,:30200,:30201,:30202,:30203,:30204
CPU34=:30300,:30301,:30302,:30303,:30304,:30400,:30401,:30402,:30403,:30404
CPU56=:30500,:30501,:30502,:30503,:30504,:30600,:30601,:30602,:30603,:30604
roll :30100 --remaining-frac 0:0.31    --steal rev --allow-miner-routers --routers $CPU12
roll :30300 --remaining-frac 0.31:0.62 --steal rev --routers $CPU34
roll :30500 --remaining-frac 0.62:0.93 --steal rev --routers $CPU56
roll :38083 --remaining-frac 0.93:1    --steal rev --routers :38083,:48083
roll :mini  --tier-slice=-30: --steal rev --routers :mini
wait
