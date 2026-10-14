#!/bin/bash
# air-job (herdr-kit rebuild; same v3.2 contract as mac-job -- eta-refuter-2 #3021/#3026/#3027/#3029 +
# fleet #3028/#3031/#3038/#3039): the ONLY way our BATCH jobs should start on V's MacBook Air.
#
# Same pgid+start+cmd contract, integer-validated floor (caller arg AND memory_pressure's reading),
# runtime watcher, 0700 job dirs, checked "--" separator, concurrency cap (r415i: <=3 on AC) as mac-job --
# see mac-job.sh's header for the full reasoning, not repeated here. air-job-specific: refuses to even
# start on battery, using an ALLOWLIST of pmset's own wording ("AC Power" required to proceed; "Battery
# Power" refuses; anything else unrecognised also refuses -- garbled/unexpected pmset output used to
# fail open as AC). The runtime watcher also pauses if AC is lost mid-job, not just at start.
#
# Fixed per eta-refuter-2 #3057 / fleet #3059 (same bug, same code as mac-job): `wait $PID` under `set -m`
# returns early when the child is merely STOPPED, not just on exit -- the first pause silently orphaned
# the job. Fixed with a wait loop that only stops once the process is actually gone. Also, same judgment
# call as mac-job (left to herdr-kit by #3057, recorded here): an unmeasured memory reading during the
# runtime watch now pauses the job (fail-safe) rather than being silently ignored while still on AC.
#
# usage: air-job <description> [min_free_pct] -- <command> [args...]
set -u
MAXCONC=3

[ $# -ge 1 ] || { echo "air-job: missing description (usage: air-job <description> [min_free_pct] -- <command> [args...])" >&2; exit 2; }
DESC="$1"; shift

if [ "${1:-}" = "--" ]; then
  MINFREE=25
  shift
else
  case "${1:-}" in
    ''|*[!0-9]*)
      echo "air-job: expected '--' or an integer min_free_pct next, got '${1:-}' (usage: air-job <description> [min_free_pct] -- <command> [args...])" >&2
      exit 2
      ;;
  esac
  if [ "${2:-}" != "--" ]; then
    echo "air-job: missing '--' separator after min_free_pct" >&2
    exit 2
  fi
  MINFREE="$1"
  shift 2
fi
[ $# -ge 1 ] || { echo "air-job: no command given after '--'" >&2; exit 2; }

power_state() {
  local line; line=$(pmset -g batt 2>/dev/null | head -1)
  case "$line" in
    *"AC Power"*) echo "AC" ;;
    *"Battery Power"*) echo "BATTERY" ;;
    *) echo "UNKNOWN" ;;
  esac
}

PSTATE=$(power_state)
case "$PSTATE" in
  AC) : ;;
  BATTERY) echo "air-job: refusing to start, on battery (r415i: no batch jobs on battery)" >&2; exit 4 ;;
  *) echo "air-job: refusing to start, pmset power state not recognised (got neither 'AC Power' nor 'Battery Power')" >&2; exit 4 ;;
esac

free_pct() { memory_pressure 2>/dev/null | awk '/System-wide memory free percentage/ {gsub("%","",$NF); print $NF}'; }

PCT=$(free_pct)
case "$PCT" in
  ''|*[!0-9]*)
    echo "air-job: refusing to start, memory_pressure gave no usable integer reading (got '${PCT}')" >&2
    exit 3
    ;;
esac
if [ "$PCT" -lt "$MINFREE" ]; then
  echo "air-job: refusing to start, free memory ${PCT}% < ${MINFREE}% floor" >&2
  exit 3
fi

SLOTDIR="$HOME/eta-work/.slots-air-job"
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
  echo "air-job: refusing to start, all $MAXCONC concurrency slots in use" >&2
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

# unmeasured (empty/non-integer) counts as "low" for pausing, and is never "ok" for resuming -- fail safe.
_low_or_unmeasured() { case "$1" in ''|*[!0-9]*) return 0 ;; *) [ "$1" -lt "$MINFREE" ] ;; esac; }
_ok_reading()         { case "$1" in ''|*[!0-9]*) return 1 ;; *) [ "$1" -ge "$MINFREE" ] ;; esac; }

watch_and_pause() {
  local paused=0
  while kill -0 "$PID" 2>/dev/null; do
    sleep "${AIRJOB_WATCH_INTERVAL:-30}"
    kill -0 "$PID" 2>/dev/null || break
    live_start=$(LC_ALL=C ps -o lstart= -p "$PID" 2>/dev/null)
    [ "$live_start" = "$(cat "$JOBDIR/start" 2>/dev/null)" ] || break
    pct=$(free_pct)
    pstate=$(power_state)
    if { [ "$pstate" != "AC" ] || _low_or_unmeasured "$pct"; } && [ "$paused" -eq 0 ]; then
      pct_display="${pct:-unmeasured}"; [ -n "$pct" ] && pct_display="${pct}%"
      kill -STOP -"$PID" 2>/dev/null && paused=1 && echo "air-job: paused $DESC (power=$pstate memory=${pct_display})" >&2
    elif [ "$pstate" = "AC" ] && _ok_reading "$pct" && [ "$paused" -eq 1 ]; then
      kill -CONT -"$PID" 2>/dev/null && paused=0 && echo "air-job: resumed $DESC (memory ${pct}%)" >&2
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
