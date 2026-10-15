#!/usr/bin/env bash
# Deploy step for the Mini: copies this tree's Mini files to the live layout under GUARDIAN_HOME (the same mapping check-deployed.sh checks), writes
# app/SOURCE-SHA from this tree's git HEAD, then runs check-deployed.sh. Every file it replaces is first copied to backup-src/deploy-<stamp>/ (no deletes).
# It restarts NOTHING: restart only the launchd job whose code changed, by hand (router for router/*.py, subscriber for subscriber/*.py, pgdump runs from cron-like calendar).
# Usage: ops/deploy.sh            (GUARDIAN_HOME overrides the live root; default ~/oc/fleet-access/guardian)
set -euo pipefail
MINI="$(cd "$(dirname "$0")/.." && pwd)"
LIVE="${GUARDIAN_HOME:-$HOME/oc/fleet-access/guardian}"
STAMP="$(date +%Y%m%d-%H%M%S)-$$"           # seconds plus the pid: two deploys in one second never share a backup folder
BK="$LIVE/backup-src/deploy-$STAMP"
map=()
for f in alert_router run_router ubus_bus router_relay relay_watcher; do map+=("router/$f.py:app/router/$f.py"); done
for f in subscriber run_subscriber consult_hold start_day; do map+=("subscriber/$f.py:app/subscriber/$f.py"); done
for f in test_router test_subscriber test_r2 test_control_contract test_dprime; do map+=("tests/$f.py:app/tests/$f.py"); done
for f in run-pipe add-key grant-admin init-schema pipe-ssh run-postgres outbound-check; do map+=("pipe/$f.sh:scripts/$f.sh"); done
map+=("ops/pgdump.sh:scripts/pgdump.sh" "ops/backup-case.py:scripts/backup-case.py")
for f in fake-room selftest selftest2 selftest3; do map+=("tests/selftest/$f.py:scripts/$f.py"); done
# Pre-check EVERY source before anything is copied, so a missing file can never leave a partial deploy.
missing=0
for pair in "${map[@]}"; do
  [ -f "$MINI/${pair%%:*}" ] || { echo "deploy: missing $MINI/${pair%%:*}" >&2; missing=$((missing + 1)); }
done
[ "$missing" = 0 ] || { echo "deploy: $missing source file(s) missing; nothing was copied" >&2; exit 1; }
changed=0
for pair in "${map[@]}"; do
  src="$MINI/${pair%%:*}"; dst="$LIVE/${pair##*:}"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then continue; fi
  mkdir -p "$(dirname "$dst")"
  if [ -f "$dst" ]; then mkdir -p "$BK/$(dirname "${pair##*:}")"; cp -p "$dst" "$BK/${pair##*:}"; fi
  cp -p "$src" "$dst"; echo "deploy: updated ${pair##*:}"; changed=$((changed + 1))
done
sha="$(git -C "$MINI" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
if [ "$sha" != unknown ] && [ -n "$(git -C "$MINI" status --porcelain -- . 2>/dev/null)" ]; then sha="$sha+dirty"; fi
mkdir -p "$LIVE/app"
printf '%s tools/room-guardian/mini\n' "$sha" > "$LIVE/app/SOURCE-SHA"
echo "deploy: $changed file(s) updated, app/SOURCE-SHA = $sha; no job restarted"
"$MINI/ops/check-deployed.sh"
