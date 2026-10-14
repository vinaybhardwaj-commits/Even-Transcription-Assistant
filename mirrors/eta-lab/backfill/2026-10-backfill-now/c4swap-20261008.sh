#!/bin/bash
# c4 wrapper swap (C4-STACK-2 PASS, eta-refuter-2 15:51): stop old loop between chunks, restart on run_c4.sh ee03f886.
D=/home/eta/oc/backfill-now; L=$D/c4swap-20261008.log
exec >> $L 2>&1
echo "$(date) swap start; old loop 51168"
[ "$(sha256sum $D/run_c4.sh | cut -c1-8)" = ee03f886 ] || { echo "REFUSED: run_c4.sh not ee03f886"; exit 3; }
touch $D/STOP-c4
for i in $(seq 1 480); do kill -0 51168 2>/dev/null || break; sleep 15; done
if kill -0 51168 2>/dev/null; then echo "$(date) old loop still alive after 2 h; leaving STOP-c4 in place, not restarting"; exit 4; fi
mv -n $D/STOP-c4 $D/_STOP-c4.used-$(date +%H%M)
cd $D && CHUNK=3 bash run_c4.sh --bg --remaining-frac 0:1
echo "$(date) swap done"
