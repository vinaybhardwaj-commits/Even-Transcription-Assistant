#!/bin/zsh
# kit/lab-run.sh -- pick a free GPU/CPU lab machine and run a batch job there,
# detached on the remote so a dropped connection costs the view, not the run.
# orders/LANES.md L10 (herdr-kit). Machines + rules: orders/RULING-MINI-NIGHT-LAB.md.
#
# Usage:
#   lab-run.sh <pane-name> --gpu|--cpu [--machine <name>] -- <command...>
#
# <command...> is joined into ONE string and handed to `eval` remotely: pass
# one already-quoted command (e.g. a single script invocation), not several
# words you expect argv-separated -- `-- python x.py "a b"` runs as
# `python x.py a b`, not one two-word argument.
#
# Without --machine: tries each candidate for the given kind, in priority order,
# picks the first one that is BOTH inside its allowed window right now (or, for
# `air`, on AC power) AND not locked, and runs there. With --machine: targets
# that one machine directly, still checks its window/lock and refuses rather
# than run out of window or steal a held lock.
#
# Exit codes follow sysexits(1), matching what macOS's own `lockf` already
# uses, so both lock styles agree: 75 (EX_TEMPFAIL) = lock was busy, 69
# (EX_UNAVAILABLE) = outside window / on battery / no free candidate, 64
# (EX_USAGE) = bad arguments. Anything else is the job's OWN exit code.
#
# THE RUN ITSELF IS DETACHED (Refuter R2, 23 Sep): the remote launch command
# backgrounds a subshell with `nohup ... & disown` and returns immediately --
# it does not hold the ssh channel open for the job's whole lifetime. That
# subshell holds the lock (flock fd, or lockf wrapping the job directly) for
# as long as IT runs, and writes the job's real exit code to `<log>.rc` when
# done. This script then tails the log from a SEPARATE ssh call and
# reconnects that tail if it drops -- a dropped connection re-attaches to the
# same log, it does not kill the job (the old version's `ssh ... | tee`
# design did: closing the ssh channel sent tee a SIGPIPE, which killed the
# whole pipeline including the job).
#
# Locking: real `flock` on Linux (eta-lab-t4, gcp-l4, orbox3). macOS (Mini,
# ehrc-audiometry, air) uses `/usr/bin/lockf -k -t 0` -- confirmed present and
# kernel-backed (same die-with-the-process guarantee as flock), unlike the
# mkdir-directory lock the first version used, which nothing else on those
# hosts would ever respect and which a SIGKILL/OOM/power-loss could leave
# behind forever (Refuter R4).
set -u

# --- machine table -------------------------------------------------------
# name        alias        kind lock_style lock_path                    workdir_tpl                          window (IST HHMM-HHMM, empty=always, "AC"=pmset-gated)  nice
machine_row() {
  case "$1" in
    eta-lab-t4) echo "eta-lab-t4|eta-lab-t4|gpu|flock|/home/eta/gpu.lock|/home/eta/eta-lab-night/__PANE__|/home/eta/eta-lab-night/__PANE__/logs||0" ;;
    gcp-l4)     echo "gcp-l4|gcp-l4|gpu|flock|/home/vinay_bhardwaj/gpu.lock|/home/vinay_bhardwaj/eta-lab-night/__PANE__|/home/vinay_bhardwaj/eta-lab-night/__PANE__/logs||0" ;;
    mini)       echo "mini|localhost|gpu|lockf|/tmp/mini-lab.lock|/Volumes/Air Drive/eta-lab-night/__PANE__|/Volumes/Air Drive/eta-lab-night/__PANE__/logs|2000-1000|0" ;;
    audiometry) echo "audiometry|audiometry|gpu|lockf|/Users/ehrc-audiometry/eta-lab-night/lab-run.lock|/Users/ehrc-audiometry/eta-lab-night/__PANE__|/Users/ehrc-audiometry/eta-lab-night/logs|2030-0730|19" ;;
    orbox3)     echo "orbox3|orbox3|cpu|flock|/tmp/eta-lab-night.lock|/home/orbox3/eta-lab-night/__PANE__|/home/orbox3/eta-lab-night/__PANE__/logs|2015-0645|19" ;;
    air)        echo "air|air|cpu|lockf|/tmp/air-lab.lock|/tmp/eta-lab-night/__PANE__|/tmp/eta-lab-night/__PANE__/logs|AC|19" ;;
  esac
}
GPU_CANDIDATES=(eta-lab-t4 gcp-l4 mini audiometry)
CPU_CANDIDATES=(orbox3 air)
# Refuter R3: the memory guard the ruling requires for macOS hosts (>=30% free
# to start, self-stop below 15%) -- Linux hosts have their own GPU/CI locks
# and no memory_pressure equivalent is asked for there.
MEMORY_GUARD_HOSTS=(mini audiometry)
# air's rule is <=3 cores, not enforced mechanically (no taskset on macOS) --
# document only, per the order.

log() { print -r -- "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2; }

# --- window check: current IST HHMM inside [start,end), wrapping past midnight.
# spec="AC" means: no clock window, gated on AC power instead (checked on $2).
# Also returns the number of seconds left in the window on stdout (empty for
# "always"/AC, since those have no fixed end) -- used for the hard-stop timeout.
in_window() {
  local spec="$1" alias="${2:-}"
  [ -z "$spec" ] && { echo ""; return 0; }
  if [ "$spec" = "AC" ]; then
    echo ""
    timeout 8 ssh -o BatchMode=yes -o ConnectTimeout=5 "$alias" \
      "pmset -g batt | head -1 | grep -q 'AC Power'" 2>/dev/null
    return $?
  fi
  local start="${spec%-*}" end="${spec#*-}"
  local now; now=$(TZ=Asia/Kolkata date +%H%M)
  local now_s end_s
  now_s=$(( ${now:0:2} * 3600 + ${now:2:2} * 60 ))
  end_s=$(( ${end:0:2} * 3600 + ${end:2:2} * 60 ))
  if [ "$start" -le "$end" ]; then
    if [ "$now" -ge "$start" ] && [ "$now" -lt "$end" ]; then
      echo $(( end_s - now_s )); return 0
    fi
  else
    if [ "$now" -ge "$start" ] || [ "$now" -lt "$end" ]; then
      [ "$now" -ge "$start" ] && end_s=$(( end_s + 86400 ))
      echo $(( end_s - now_s )); return 0
    fi
  fi
  echo ""; return 1
}

# --- memory_pressure free% on a macOS host, over ssh (or locally for the Mini itself)
mem_free_pct() {
  if [ "$1" = "localhost" ]; then
    memory_pressure 2>/dev/null | tail -1 | grep -oE '[0-9]+' | head -1
  else
    timeout 8 ssh -o BatchMode=yes -o ConnectTimeout=5 "$1" \
      "memory_pressure | tail -1" 2>/dev/null | grep -oE '[0-9]+' | head -1
  fi
}

has_memory_guard() { [[ " ${MEMORY_GUARD_HOSTS[*]} " == *" $1 "* ]]; }

# --- non-blocking remote lock probe: rc 0 = free right now, 1 = busy, 2 = host unreachable
# (ssh itself failed -- rc 255, or timed out: 124). eta-refuter-2 L3: unreachable used to read as "lock held".
is_free() {
  local alias="$1" style="$2" lockpath="$3"
  local ssh_target=""
  [ "$alias" != "localhost" ] && ssh_target="$alias"
  local probe
  if [ "$style" = "flock" ]; then
    probe="exec 9>'$lockpath'; flock -n 9 && flock -u 9"
  else
    probe="lockf -k -t 0 '$lockpath' true"
  fi
  local rc
  if [ -n "$ssh_target" ]; then
    timeout 8 ssh -o BatchMode=yes -o ConnectTimeout=5 "$ssh_target" "$probe" >/dev/null 2>&1; rc=$?
    [ $rc -eq 255 ] || [ $rc -eq 124 ] && return 2
  else
    eval "$probe" >/dev/null 2>&1; rc=$?
  fi
  [ $rc -eq 0 ] && return 0
  return 1
}

pick_machine() {
  local kind="$1" name row alias style lockpath window
  local -a candidates
  [ "$kind" = "gpu" ] && candidates=($GPU_CANDIDATES) || candidates=($CPU_CANDIDATES)
  for name in $candidates; do
    row=$(machine_row "$name")
    IFS='|' read -r _ alias _ style lockpath _ _ window _ <<< "$row"
    if [ -n "$window" ] && has_memory_guard "$name"; then
      local free; free=$(mem_free_pct "$alias")
      if [ -z "$free" ] || [ "$free" -lt 30 ]; then
        log "skip $name: memory guard (free=${free:-unknown}%, need >=30%)"; continue
      fi
    fi
    if in_window "$window" "$alias" >/dev/null; then
      is_free "$alias" "$style" "$lockpath"; local fr=$?
      if [ $fr -eq 0 ]; then echo "$name"; return 0; fi
      log "skip $name: $([ $fr -eq 2 ] && echo 'unreachable' || echo 'in window but locked')"
    else
      log "skip $name: outside window/on battery"
    fi
  done
  return 1
}

# --- args ------------------------------------------------------------------
PANE="${1:?usage: lab-run.sh <pane-name> --gpu|--cpu [--machine <name>] -- <command...>}"; shift
case "$PANE" in *"'"*|*/*) echo "pane name must not contain ' or /: $PANE" >&2; exit 64 ;; esac
KIND=""; MACHINE_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --gpu) KIND="gpu"; shift ;;
    --cpu) KIND="cpu"; shift ;;
    --machine) MACHINE_OVERRIDE="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "unknown arg: $1 (did you forget --?)" >&2; exit 64 ;;
  esac
done
[ -z "$KIND" ] && { echo "need --gpu or --cpu" >&2; exit 64; }
[ $# -eq 0 ] && { echo "need a command after --" >&2; exit 64; }
CMD="$*"

if [ -n "$MACHINE_OVERRIDE" ]; then
  MACHINE="$MACHINE_OVERRIDE"
  row=$(machine_row "$MACHINE")
  [ -z "$row" ] && { echo "unknown machine: $MACHINE" >&2; exit 64; }
  IFS='|' read -r _ alias _ style lockpath _ _ window _ <<< "$row"
  if has_memory_guard "$MACHINE"; then
    free=$(mem_free_pct "$alias")
    if [ -z "$free" ] || [ "$free" -lt 30 ]; then
      echo "BLOCKED: $MACHINE memory guard (free=${free:-unknown}%, need >=30%)" >&2; exit 69
    fi
  fi
  WINDOW_SECS=$(in_window "$window" "$alias") || { echo "BLOCKED: $MACHINE is outside its window/power state ($window)" >&2; exit 69; }
  is_free "$alias" "$style" "$lockpath"; fr=$?
  [ $fr -eq 2 ] && { echo "BLOCKED: $MACHINE is unreachable over ssh from here" >&2; exit 69; }
  [ $fr -ne 0 ] && { echo "BLOCKED: $MACHINE's lock is held" >&2; exit 75; }
else
  MACHINE=$(pick_machine "$KIND") || { echo "BLOCKED: no free $KIND machine right now (all in-window candidates are locked or memory-guarded, or all candidates are outside their window)" >&2; exit 69; }
  row=$(machine_row "$MACHINE")
  IFS='|' read -r _ alias _ style lockpath _ _ window _ <<< "$row"
  WINDOW_SECS=$(in_window "$window" "$alias")
fi

# Test hook only: force a short hard-stop so the watchdog can be exercised on a host with no window (air).
[ -n "${LAB_RUN_TEST_WINDOW_SECS:-}" ] && WINDOW_SECS="$LAB_RUN_TEST_WINDOW_SECS"

row=$(machine_row "$MACHINE")
IFS='|' read -r _ alias _ style lockpath workdir_tpl logdir_tpl window nice_level <<< "$row"
workdir="${workdir_tpl//__PANE__/$PANE}"
logdir="${logdir_tpl//__PANE__/$PANE}"
ts=$(date -u +%Y%m%dT%H%M%SZ)
logfile="$logdir/${PANE}-${ts}.log"
rcfile="${logfile}.rc"

log "picked $MACHINE for $PANE ($KIND) -- workdir=$workdir log=$logfile"

# The job is written to a script file (base64 over the wire, so no quoting layer -- local shell, ssh,
# eval, lockf's bash -c -- can touch it) and run as `bash <file>`. Prefixing the raw command with
# `nice`/`timeout` broke shell builtins and compound commands: `-- "exit 3"` returned 127 (herdr-kit
# self-test, 24 Sep), because nice cannot exec `exit`.
jobfile="$workdir/.lab-run-job-${ts}.sh"
B64=$(printf '%s\n' "$CMD" | base64 | tr -d '\n')
RUN_CMD="bash '$jobfile'"
[ "$nice_level" != "0" ] && RUN_CMD="nice -n $nice_level $RUN_CMD"

# --- background watchdogs run INSIDE the same detached subshell as the job,
# so they die naturally when it exits; they kill the job's process group by
# matching $workdir the same way yoga-ci-remote.sh's CI watchdog does.
KILLFN='killtree() { for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill -9 "$1" 2>/dev/null; };'
timeoutmark="${rcfile}.timeout"
WATCHDOG=""
if [ -n "$WINDOW_SECS" ]; then
  # Hard stop at the window end, in plain sh: no dependency on timeout/gtimeout (absent on audiometry's
  # non-interactive PATH, eta-refuter-2 L2). Marker file makes the final rc 124, like timeout(1).
  WATCHDOG="$WATCHDOG
( s=0; while kill -0 \$JOB_PID 2>/dev/null; do
    if [ \$s -ge $WINDOW_SECS ]; then
      echo '=== hard stop: window ended, killing job' >> '$logfile'
      : > '$timeoutmark'
      killtree \$JOB_PID
      break
    fi
    sleep 5; s=\$((s+5))
  done ) &"
fi
if has_memory_guard "$MACHINE"; then
  WATCHDOG="$WATCHDOG
( while kill -0 \$JOB_PID 2>/dev/null; do
    free=\$(memory_pressure | tail -1 | grep -oE '[0-9]+' | head -1)
    if [ -n \"\$free\" ] && [ \"\$free\" -lt 15 ]; then
      echo \"=== memory guard: free=\${free}% < 15%, killing job\" >> '$logfile'
      killtree \$JOB_PID
      break
    fi
    sleep 15
  done ) &"
fi
if [ "$window" = "AC" ]; then
  WATCHDOG="$WATCHDOG
( while kill -0 \$JOB_PID 2>/dev/null; do
    pmset -g batt | head -1 | grep -q 'AC Power' || {
      echo '=== AC guard: switched to battery, killing job' >> '$logfile'
      killtree \$JOB_PID
      break
    }
    sleep 15
  done ) &"
fi

# A lock lost between the probe and here must still leave an .rc (75), or the client waits forever
# (eta-refuter-2 L1). The final rc is 124 if the hard-stop watchdog fired.
FINISH="wait \$JOB_PID; RC=\$?; [ -f '$timeoutmark' ] && RC=124; echo \$RC > '$rcfile'"
if [ "$style" = "flock" ]; then
  LAUNCH="( $KILLFN exec 9>'$lockpath'; flock -n 9 || { echo 75 > '$rcfile'; exit 75; }; cd '$workdir' && eval \"$RUN_CMD\" & JOB_PID=\$!; $WATCHDOG $FINISH ) > '$logfile' 2>&1 < /dev/null & disown; echo LAUNCHED"
else
  LAUNCH="( $KILLFN lockf -k -t 0 '$lockpath' bash -c \"cd '$workdir' && eval \\\"$RUN_CMD\\\"\" & JOB_PID=\$!; $WATCHDOG $FINISH ) > '$logfile' 2>&1 < /dev/null & disown; echo LAUNCHED"
fi
SETUP="mkdir -p '$workdir' '$logdir'; rm -f '$rcfile' '$timeoutmark'; printf %s '$B64' | { base64 -d 2>/dev/null || base64 -D; } > '$jobfile'"

if [ "$alias" = "localhost" ]; then
  eval "$SETUP"
  eval "$LAUNCH"
else
  ssh -o BatchMode=yes "$alias" "$SETUP; $LAUNCH"
fi

log "launched on $MACHINE, tailing $logfile until $rcfile appears (a dropped connection reconnects, it does not stop the job)"

# --- reconnecting tail: watch the log until the job's .rc file appears.
rc_exists() {
  if [ "$alias" = "localhost" ]; then [ -f "$rcfile" ]
  else timeout 8 ssh -o BatchMode=yes -o ConnectTimeout=5 "$alias" "[ -f '$rcfile' ]" 2>/dev/null
  fi
}
TAILED=0
while ! rc_exists; do
  TAILED=1
  if [ "$alias" = "localhost" ]; then
    tail -f "$logfile" 2>/dev/null &
    TAILPID=$!
    while ! rc_exists && kill -0 $TAILPID 2>/dev/null; do sleep 1; done
    kill $TAILPID 2>/dev/null
  else
    timeout 21600 ssh -o BatchMode=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 "$alias" \
      "tail -f -n +1 '$logfile' & TAILPID=\$!; while [ ! -f '$rcfile' ] && kill -0 \$TAILPID 2>/dev/null; do sleep 1; done; kill \$TAILPID 2>/dev/null; true"
  fi
  rc_exists || { log "connection dropped, reconnecting..."; sleep 2; }
done

# A job that finishes before the first tail starts would otherwise print nothing at all.
if [ "$TAILED" = "0" ]; then
  if [ "$alias" = "localhost" ]; then cat "$logfile" 2>/dev/null
  else timeout 20 ssh -o BatchMode=yes "$alias" "cat '$logfile'" 2>/dev/null; fi
fi

if [ "$alias" = "localhost" ]; then RC=$(cat "$rcfile" 2>/dev/null)
else RC=$(timeout 8 ssh -o BatchMode=yes "$alias" "cat '$rcfile'" 2>/dev/null)
fi
RC="${RC:-70}"  # EX_SOFTWARE if the .rc file vanished/was unreadable -- should not happen

if [ "$RC" = "75" ]; then
  log "$MACHINE's lock was taken between the probe and the real run (race) -- re-run to retry, or pass a different --machine"
fi
log "done: machine=$MACHINE rc=$RC log=$logfile"
exit "$RC"
