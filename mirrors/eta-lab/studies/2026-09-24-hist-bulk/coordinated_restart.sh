#!/bin/bash
echo "RETIRED: the HIST nodes were deleted on 25 Sep 06:25 (Fable/V); this script must not run" >&2; exit 1
# coordinated_restart.sh — drain the running non-Mini runner processes (STOP file, no kill), reserve the Mini's slice, then start 4 claim-sharing processes.
set -u
HD=$HOME/eta-data/hist; DIR=$HOME/dev/eta-lab/studies/2026-09-24-hist-bulk; PY=$HOME/.venv-r2/bin/python
nonmini() { pgrep -af 'python.*runner.py' | grep -v -- '--routers :mini' | grep -v pgrep | grep -c 'venv-r2/bin/python'; }
touch $HD/STOP; echo "$(date +%T) STOP touched; non-Mini runners alive: $(nonmini)"
for i in $(seq 1 180); do [ "$(nonmini)" = "0" ] && break; sleep 10; done
echo "$(date +%T) non-Mini runners alive: $(nonmini)"; [ "$(nonmini)" = "0" ] || { echo "drain timed out; leaving STOP in place"; exit 1; }
$PY $DIR/runner.py --preclaim-tail 30 --preclaim-owner mini-preclaim
rm -f $HD/STOP
cd $DIR
nohup $PY runner.py --remaining-frac 0:0.31    --steal rev --allow-miner-routers --routers :30100,:30101,:30102,:30103,:30104,:30200,:30201,:30202,:30203,:30204 > $HD/run12.log 2>&1 & sleep 8
nohup $PY runner.py --remaining-frac 0.31:0.62 --steal rev --routers :30300,:30301,:30302,:30303,:30304,:30400,:30401,:30402,:30403,:30404 > $HD/run13.log 2>&1 & sleep 8
nohup $PY runner.py --remaining-frac 0.62:0.93 --steal rev --routers :30500,:30501,:30502,:30503,:30504,:30600,:30601,:30602,:30603,:30604 > $HD/run14.log 2>&1 & sleep 8
nohup $PY runner.py --remaining-frac 0.93:1    --steal rev --routers :38083,:48083 > $HD/run15.log 2>&1 & sleep 8
if [ -z "$(pgrep -af 'python.*runner.py' | grep -- '--routers :mini')" ]; then
  nohup $PY runner.py --tier-slice=-30: --preclaim-owner mini-preclaim --routers :mini > $HD/run16.log 2>&1 &
  echo "$(date +%T) Mini process restarted"
fi
echo "$(date +%T) restart done"
