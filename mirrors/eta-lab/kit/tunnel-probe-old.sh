#!/bin/bash
# Live "is this credential still accepted?" probe for a tunnel (refuter-2 #1603/#1609/#1920, ruling 295 condition 2).
#
#   printf '%s' "$TOKEN" | kit/tunnel-probe-old.sh <tunnel-id> <probe-host-alias>
#
# Runs a real `cloudflared tunnel run` with the token on STDIN, on a NON-production host (not gcp-l4, a hist clone, the box or
# e2e-ci), for at most ~MAXSECS seconds, while polling the API connector count. The token goes ssh stdin -> the remote shell's
# ENVIRONMENT (TUNNEL_TOKEN); never argv, never disk, never printed.
# TIME LIMIT (measured 25 Sep, corrects an earlier false claim): cloudflared IGNORES SIGALRM, so a remote alarm never ends it, and
# a refused credential keeps retrying. The limit is therefore enforced HERE: when the window ends (or the credential registers)
# the probe ACTIVELY terminates its own remote process through its pid file (SIGTERM, then SIGKILL if it is still alive after
# KILL9_AFTER seconds), and then polls the probe host until no cloudflared is left (up to SETTLE_SECS = 60) before judging.
# The kill targets ONLY the pid in its own pid file, and only if `ps -p <pid> -o comm=` still names cloudflared (guards against pid
# reuse on the probe host); never a pattern kill (pkill/killall) there.
# Exit codes:
#   0  REJECTED     ONLY when ALL hold: the remote process really started (marker), the log carries the server-side refusal
#                   ("Unauthorized" AND "Invalid tunnel secret"), the API was polled cleanly (no failed poll, >= MIN good polls),
#                   the count never rose above the baseline, and NO cloudflared is left on the probe host after the settle.
#   3  ACCEPTED     the count rose: the credential STILL REGISTERS. The probe process is terminated at once.
#   4  INCONCLUSIVE anything else (host unreachable, dial/QUIC error, no refusal text, failed polls, a process that will not die, ...).
#                   Never read INCONCLUSIVE as "rejected".
# Run it ONLY after `tunnel_rotate.py rotated` says the secret changed.
# Test hooks (env): TUNNEL_PROBE_ROT (count command), PROBE_POLL_SECS (4), PROBE_MIN_POLLS (10), PROBE_MAX_SECS (70),
# PROBE_SETTLE_SECS (60, ruling 351), PROBE_SETTLE_POLL (2), PROBE_KILL9_AFTER (10). `ssh` is taken from PATH. Defaults = production behaviour.
set -uo pipefail
case "$-" in *x*) echo "REFUSED: run without xtrace."; exit 2 ;; esac
KITDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROT="${TUNNEL_PROBE_ROT:-python3 $KITDIR/tunnel_rotate.py}"
POLL="${PROBE_POLL_SECS:-4}"; MINPOLLS="${PROBE_MIN_POLLS:-10}"; MAXSECS="${PROBE_MAX_SECS:-70}"
SETTLE="${PROBE_SETTLE_SECS:-60}"; SPOLL="${PROBE_SETTLE_POLL:-2}"; KILL9="${PROBE_KILL9_AFTER:-10}"
TID="${1:-}"; HOST="${2:-}"
[ -n "$TID" ] && [ -n "$HOST" ] || { echo "usage: printf %s \"\$TOKEN\" | kit/tunnel-probe-old.sh <tunnel-id> <probe-host-alias>"; exit 2; }
case "$HOST" in gcp-l4|box|hist-*|e2e-ci) echo "REFUSED: $HOST is a production or hist host; use a non-production host."; exit 2 ;; esac
IFS= read -r TOKEN || true
[ -n "$TOKEN" ] || { echo "no token on stdin"; exit 2; }

cnt() { $ROT count "$TID" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(int(d["connectors"]))'; }
BASE="$(cnt)" || { echo "cannot read the connector count, nothing started"; exit 4; }
LOG="$(mktemp)"; PIDF="/tmp/tunnel-probe-$$.pid"
SSHO=(-o BatchMode=yes -o ConnectTimeout=10)
rprocs() { ssh "${SSHO[@]}" "$HOST" 'pgrep -x cloudflared | wc -l | tr -d " "' 2>/dev/null || echo '?'; }
echo "probe host $HOST | tunnel ${TID:0:8} | baseline connectors $BASE | window <= ${MAXSECS}s, then active kill + settle <= ${SETTLE}s"

REMOTE='IFS= read -r T; export TUNNEL_TOKEN="$T"; unset T; echo $$ > '"$PIDF"'; echo PROBE-STARTED; CF=$(command -v cloudflared || echo /opt/homebrew/bin/cloudflared); exec "$CF" --no-autoupdate tunnel run 2>&1'
printf '%s\n' "$TOKEN" | ssh "${SSHO[@]}" "$HOST" "$REMOTE" > "$LOG" 2>&1 &
SSHPID=$!
MAX="$BASE"; ACCEPTED=0; GOOD=0; BAD=0; t0=$SECONDS
while kill -0 "$SSHPID" 2>/dev/null && [ $((SECONDS - t0)) -lt "$MAXSECS" ]; do
  sleep "$POLL"
  if c="$(cnt 2>/dev/null)" && [[ "$c" =~ ^[0-9]+$ ]]; then
    GOOD=$((GOOD+1)); [ "$c" -gt "$MAX" ] && MAX="$c"
    if [ "$c" -gt "$BASE" ]; then ACCEPTED=1; break; fi     # registered: stop watching, terminate below
  else
    BAD=$((BAD+1))    # an API read that FAILED is not "no rise"
  fi
done
kill "$SSHPID" 2>/dev/null; wait "$SSHPID" 2>/dev/null; RC=$?

# ACTIVE termination of the remote probe process (any verdict): SIGTERM through the pid file, SIGKILL if it lingers.
# pid-reuse guard (refuter-2 #1981): signal the pid ONLY if it still belongs to cloudflared, so a recycled pid on the probe host
# (V's Air) can never make us hit an unrelated process.
ssh "${SSHO[@]}" "$HOST" "p=\$(cat $PIDF 2>/dev/null); [ -n \"\$p\" ] && ps -p \"\$p\" -o comm= 2>/dev/null | grep -q cloudflared && kill \"\$p\"" >/dev/null 2>&1
KILLED=TERM; RPROCS="?"; ts=$SECONDS
while :; do
  RPROCS="$(rprocs)"
  [ "$RPROCS" = 0 ] && break
  [ $((SECONDS - ts)) -ge "$SETTLE" ] && break
  if [ "$KILLED" = TERM ] && [ $((SECONDS - ts)) -ge "$KILL9" ]; then
    ssh "${SSHO[@]}" "$HOST" "p=\$(cat $PIDF 2>/dev/null); [ -n \"\$p\" ] && ps -p \"\$p\" -o comm= 2>/dev/null | grep -q cloudflared && kill -9 \"\$p\"" >/dev/null 2>&1; KILLED=KILL
  fi
  sleep "$SPOLL"
done
SETTLED=$((SECONDS - ts))
ssh "${SSHO[@]}" "$HOST" "rm -f $PIDF" >/dev/null 2>&1
FINAL="$(cnt 2>/dev/null || echo '?')"

STARTED=0; grep -q 'PROBE-STARTED' "$LOG" && STARTED=1
REFUSED=0; grep -q 'Unauthorized' "$LOG" && grep -q 'Invalid tunnel secret' "$LOG" && REFUSED=1
[ "$ACCEPTED" = 1 ] && CLASS=registered || { [ "$REFUSED" = 1 ] && CLASS=auth-refused || CLASS=no-refusal-seen; }
echo "probe exit code $RC | started=$STARTED | log class: $CLASS | connectors: baseline $BASE, max seen $MAX, after $FINAL | polls good $GOOD, failed $BAD | cloudflared left on $HOST: $RPROCS (ended by ${KILLED}, settled in ${SETTLED}s)"
echo "--- refusal line seen (redacted):"; grep -m1 'Invalid tunnel secret' "$LOG" | sed -E 's/[A-Za-z0-9+\/=_-]{60,}/<redacted>/g' | cut -c1-200
echo "--- last log lines (redacted):"; tail -n 3 "$LOG" | sed -E 's/[A-Za-z0-9+\/=_-]{60,}/<redacted>/g' | cut -c1-200
rm -f "$LOG"

if [ "$ACCEPTED" = 1 ]; then echo "VERDICT: ACCEPTED: this credential STILL REGISTERS (connectors rose above $BASE). Probe terminated."; exit 3; fi
WHY=""
[ "$BAD" -gt 0 ] && WHY="$WHY failed API polls ($BAD);"
[ "$GOOD" -lt "$MINPOLLS" ] && WHY="$WHY only $GOOD good polls (need $MINPOLLS);"
[ "$STARTED" = 1 ] || WHY="$WHY the remote probe never started;"
[ "$REFUSED" = 1 ] || WHY="$WHY no server-side refusal ('Unauthorized' + 'Invalid tunnel secret') in the log;"
[ "$FINAL" = "$BASE" ] || WHY="$WHY final count $FINAL differs from baseline $BASE;"
[ "$RPROCS" = 0 ] || WHY="$WHY cloudflared processes left on the probe host after the kill and ${SETTLED}s settle: $RPROCS;"
if [ -n "$WHY" ]; then echo "VERDICT: INCONCLUSIVE (NOT a rejection):$WHY"; exit 4; fi
echo "VERDICT: REJECTED: the credential was presented and refused by the server ('Unauthorized: Invalid tunnel secret'), the count stayed $BASE over $GOOD clean polls, and no cloudflared is left on $HOST."
exit 0
