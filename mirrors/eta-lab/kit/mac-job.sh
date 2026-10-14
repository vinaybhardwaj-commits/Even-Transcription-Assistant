#!/bin/bash
# mac-job (herdr-kit rebuild; contract per eta-refuter-2 #3021/#3026/#3027/#3029 + fleet #3028/#3031/
# #3038/#3039 "v3.2"): the ONLY way our jobs should start on a macOS room recorder machine (ehrc-
# audiometry, later the ICU Mac).
#
# Safety contract (v3.2): each job gets ~/eta-work/<slug>-<pid>/ holding exactly three files while it
# runs -- pgid (group leader's pid), start (LC_ALL=C `ps -o lstart= -p $PID` immediately after spawn, so
# it can't be fooled by the job exec-replacing the leader), and cmd (the job's argv at spawn). All three
# removed by an EXIT trap. Anyone pausing by pgid (fleet, or this script's own watcher) must confirm the
# leader is alive, its live lstart EQUALS <dir>/start byte-for-byte (LC_ALL=C, no time parsing -- a
# reused pid essentially never gets the same second-exact start), and a member's command carries <dir>/
# cmd's prefix, before signalling. A bare pgid file is never enough (a -9-killed job's pgid can be reused
# by an unrelated process -- a clinician's app on this room Mac).
#
# Also: floor validated as an integer (both the CALLER'S argument and memory_pressure's READING -- a non-
# numeric floor or a "12.5"/garbled reading used to fail OPEN); a background watcher pauses/resumes the
# job's own group as memory crosses the floor at runtime, not just at start; a 4-slot concurrency cap
# (r416b: audiometry <= 4) via atomic slot directories with stale-slot reclaim; job dirs are 0700; "--"
# is a required, checked separator, not silently optional.
#
# Fixed per eta-refuter-2 #3057 / fleet #3059 (live-tested proof: the first memory pause silently killed
# the job): under `set -m`, bash's `wait $PID` returns (128+signal) not just on exit but also when the
# child STOPS -- a single `wait` here made the wrapper think a paused job had died, run its EXIT trap
# (deleting pgid/start/cmd, freeing the slot) while the job was still alive but stopped and now orphaned.
# Fixed with a loop that keeps waiting until the process is ACTUALLY gone (`kill -0` fails), not merely
# stopped -- this is the fix fleet's own pause depends on too, not just this script's own watcher.
# Also per #3057's judgment call (explicitly left to herdr-kit, recorded here): an UNMEASURED reading
# during the runtime watch now PAUSES the job (fail-safe, same posture as refusing to START on unmeasured)
# rather than silently doing nothing and leaving it running unchecked on a clinical room Mac.
#
# usage: mac-job <description> [min_free_pct] -- <command> [args...]
#   e.g. mac-job stt-run 20 -- opencode run ...      (min_free_pct defaults to 20 if omitted)
set -u
MAXCONC=4

[ $# -ge 1 ] || { echo "mac-job: missing description (usage: mac-job <description> [min_free_pct] -- <command> [args...])" >&2; exit 2; }
DESC="$1"; shift

if [ "${1:-}" = "--" ]; then
  MINFREE=20
  shift
else
  case "${1:-}" in
    ''|*[!0-9]*)
      echo "mac-job: expected '--' or an integer min_free_pct next, got '${1:-}' (usage: mac-job <description> [min_free_pct] -- <command> [args...])" >&2
      exit 2
      ;;
  esac
  if [ "${2:-}" != "--" ]; then
    echo "mac-job: missing '--' separator after min_free_pct" >&2
    exit 2
  fi
  MINFREE="$1"
  shift 2
fi
[ $# -ge 1 ] || { echo "mac-job: no command given after '--'" >&2; exit 2; }

free_pct() { memory_pressure 2>/dev/null | awk '/System-wide memory free percentage/ {gsub("%","",$NF); print $NF}'; }

PCT=$(free_pct)
case "$PCT" in
  ''|*[!0-9]*)
    echo "mac-job: refusing to start, memory_pressure gave no usable integer reading (got '${PCT}')" >&2
    exit 3
    ;;
esac
if [ "$PCT" -lt "$MINFREE" ]; then
  echo "mac-job: refusing to start, free memory ${PCT}% < ${MINFREE}% floor" >&2
  exit 3
fi

# concurrency cap: atomic mkdir slot claim, stale-slot reclaim if the recorded owner pid is gone
SLOTDIR="$HOME/eta-work/.slots-mac-job"
mkdir -m 700 -p "$SLOTDIR"
SLOT=""
i=1
while [ "$i" -le "$MAXCONC" ]; do
  d="$SLOTDIR/$i"
  if mkdir "$d" 2>/dev/null; then
    echo "$$" > "$d/pid"; SLOT="$d"; break
  fi
  if [ -f "$d/pid" ]; then
    owner=$(cat "$d/pid" 2>/dev/null || echo "")
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      rm -rf "$d" 2>/dev/null
      if mkdir "$d" 2>/dev/null; then echo "$$" > "$d/pid"; SLOT="$d"; break; fi
    fi
  fi
  i=$((i + 1))
done
if [ -z "$SLOT" ]; then
  echo "mac-job: refusing to start, all $MAXCONC concurrency slots in use" >&2
  exit 5
fi

SLUG=$(printf '%s' "$DESC" | tr -c 'A-Za-z0-9' '-' | sed 's/-\{2,\}/-/g; s/^-//; s/-$//')
[ -n "$SLUG" ] || SLUG="job"
JOBDIR="$HOME/eta-work/${SLUG}-$$"
mkdir -m 700 -p "$JOBDIR"
printf '%s' "$*" > "$JOBDIR/cmd"

cleanup() {
  kill "${WATCHER_PID:-0}" 2>/dev/null || true
  rm -f "$JOBDIR/pgid" "$JOBDIR/start" "$JOBDIR/cmd"
  rmdir "$JOBDIR" 2>/dev/null || true
  rm -rf "$SLOT" 2>/dev/null || true
}
trap cleanup EXIT

set -m
nice -n 15 taskpolicy -b "$@" &
PID=$!
echo "$PID" > "$JOBDIR/pgid"
LC_ALL=C ps -o lstart= -p "$PID" > "$JOBDIR/start"

# runtime watcher: pause/resume THIS job's own group as memory crosses the floor. Verifies its own
# recorded pgid/start before signalling, same rule an external pauser must follow.
watch_and_pause() {
  local paused=0
  while kill -0 "$PID" 2>/dev/null; do
    sleep "${MACJOB_WATCH_INTERVAL:-30}"
    kill -0 "$PID" 2>/dev/null || break
    live_start=$(LC_ALL=C ps -o lstart= -p "$PID" 2>/dev/null)
    [ "$live_start" = "$(cat "$JOBDIR/start" 2>/dev/null)" ] || break
    pct=$(free_pct)
    case "$pct" in
      ''|*[!0-9]*)
        if [ "$paused" -eq 0 ]; then
          kill -STOP -"$PID" 2>/dev/null && paused=1 && echo "mac-job: paused $DESC (memory_pressure unmeasured, failing safe)" >&2
        fi
        continue
        ;;
    esac
    if [ "$pct" -lt "$MINFREE" ] && [ "$paused" -eq 0 ]; then
      kill -STOP -"$PID" 2>/dev/null && paused=1 && echo "mac-job: paused $DESC (memory ${pct}% < ${MINFREE}%)" >&2
    elif [ "$pct" -ge "$MINFREE" ] && [ "$paused" -eq 1 ]; then
      kill -CONT -"$PID" 2>/dev/null && paused=0 && echo "mac-job: resumed $DESC (memory ${pct}%)" >&2
    fi
  done
}
watch_and_pause &
WATCHER_PID=$!

# eta-refuter-2 #3057 / fleet #3059: `wait` alone returns early when the child is merely STOPPED (SIGSTOP,
# whether from our own watcher above or an external pauser), not just on real exit. Loop until the process
# is actually gone before treating the job as finished and letting the EXIT trap clean anything up.
while :; do
  wait "$PID"
  STATUS=$?
  kill -0 "$PID" 2>/dev/null || break
done
exit "$STATUS"
