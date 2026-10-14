#!/usr/bin/env bash
# Compares the live Mini copy under ~/oc/fleet-access/guardian/{app,scripts} with this tree. Exit 1 on any difference or missing file.
# Live layout: app/router = mini/router, app/subscriber = mini/subscriber, app/tests = mini/tests (test files),
#              scripts/*.sh = mini/pipe/*.sh and mini/ops/*.sh, scripts/*.py = mini/ops/backup-case.py and mini/tests/selftest/*.py.
set -uo pipefail
MINI="$(cd "$(dirname "$0")/.." && pwd)"
LIVE="${GUARDIAN_HOME:-$HOME/oc/fleet-access/guardian}"
rc=0
cmpf() { if ! cmp -s "$1" "$2"; then echo "DIFF  $2  vs  $1"; rc=1; fi; }
for f in alert_router run_router ubus_bus router_relay relay_watcher; do cmpf "$MINI/router/$f.py" "$LIVE/app/router/$f.py"; done 2>/dev/null
for f in subscriber run_subscriber; do cmpf "$MINI/subscriber/$f.py" "$LIVE/app/subscriber/$f.py"; done
for f in test_router test_subscriber test_r2; do cmpf "$MINI/tests/$f.py" "$LIVE/app/tests/$f.py"; done
for f in run-pipe add-key grant-admin init-schema pipe-ssh run-postgres outbound-check; do cmpf "$MINI/pipe/$f.sh" "$LIVE/scripts/$f.sh"; done
cmpf "$MINI/ops/pgdump.sh" "$LIVE/scripts/pgdump.sh"; cmpf "$MINI/ops/backup-case.py" "$LIVE/scripts/backup-case.py"
for f in fake-room selftest selftest2 selftest3; do cmpf "$MINI/tests/selftest/$f.py" "$LIVE/scripts/$f.py"; done
[ "$rc" = 0 ] && echo "deployed copy matches"
exit "$rc"
