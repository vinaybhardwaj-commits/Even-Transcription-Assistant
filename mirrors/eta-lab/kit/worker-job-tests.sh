#!/bin/bash
# worker-job-tests.sh (herdr-kit, r416.0 worker kit): test procedures for mac-job.sh, air-job.sh,
# orbox-job.sh. Each function is runnable standalone on the right OS/host.
#
# ALREADY RUN by herdr-kit on the Mac Mini (macOS) this session, with real output posted to the bus
# (#3004, #3008, and the v2 rebuild per eta-refuter-2 #3021/#3026/#3027/#3029 + fleet #3028/#3031/#3038/
# #3039): mac_job_tests, air_job_tests (memory floor matrix, missing "--", integer validation on both the
# floor argument and the memory_pressure reading, air-job's pmset power-state allowlist, 0700 job dirs +
# full trap cleanup, the pgid/start/cmd 3-file contract, the 3-children STOP/CONT group test via the awk
# membership form -- never `ps -g`, per eta-refuter-2 #3029 -- concurrency-slot capping, and the runtime
# watcher's own pause/resume). Re-running here should reproduce the same results on any macOS host.
#
# NOT YET RUN by herdr-kit: orbox_job_duplicate_unit_test and orbox_job_freeze_thaw_test needed a real
# systemd --user session; eta-refuter-2 has since run both ON THE BOX (systemd 249, #3021/#3026: duplicate
# --unit fails loudly, freeze/thaw works) -- still owed: the SAME run on orbox3 itself (systemd 259) plus
# its cgroup.controllers line, from someone with shell there (fleet has none, item 93; this machine's own
# attempts to reach orbox3 were blocked by the Bash classifier this session).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------------------------------
# Shared stub helpers
# ---------------------------------------------------------------------------------------------------
_mk_stubdir() {
  local d; d=$(mktemp -d)
  printf '#!/bin/bash\necho "System-wide memory free percentage: 90%%"\n' > "$d/memory_pressure"
  printf "#!/bin/bash\necho \"Now drawing from 'AC Power'\"\n" > "$d/pmset"
  chmod +x "$d/memory_pressure" "$d/pmset"
  echo "$d"
}
_set_mp() { printf '#!/bin/bash\n%s\n' "$2" > "$1/memory_pressure"; chmod +x "$1/memory_pressure"; }
_set_pmset() { printf '#!/bin/bash\n%s\n' "$2" > "$1/pmset"; chmod +x "$1/pmset"; }

# ---------------------------------------------------------------------------------------------------
# mac-job.sh / air-job.sh share the same v2 contract; test generically by script name.
# ---------------------------------------------------------------------------------------------------
_job_common_tests() {
  local name="$1" script="$2" default_floor="$3"
  local stubdir; stubdir=$(_mk_stubdir)

  echo "=== $name: missing '--' separator -> refuse, exit 2 ==="
  PATH="$stubdir:$PATH" "$script" myjob true; echo "exit=$?"

  echo "=== $name: floor argument non-integer 'abc' -> refuse, exit 2 ==="
  PATH="$stubdir:$PATH" "$script" myjob abc -- true; echo "exit=$?"

  echo "=== $name: omitted floor, healthy reading -> default $default_floor applied, pass ==="
  PATH="$stubdir:$PATH" "$script" myjob -- true; echo "exit=$?"

  echo "=== $name: memory_pressure reading non-integer '12.5' -> refuse, exit 3 ==="
  _set_mp "$stubdir" 'echo "System-wide memory free percentage: 12.5%"'
  PATH="$stubdir:$PATH" "$script" myjob "$default_floor" -- true; echo "exit=$?"
  _set_mp "$stubdir" 'echo "System-wide memory free percentage: 90%"'

  echo "=== $name: empty memory_pressure output -> refuse, exit 3 ==="
  _set_mp "$stubdir" ':'
  PATH="$stubdir:$PATH" "$script" myjob "$default_floor" -- true; echo "exit=$?"
  _set_mp "$stubdir" 'echo "System-wide memory free percentage: 90%"'

  echo "=== $name: reading 1 below floor -> refuse; == floor -> pass ==="
  local below=$((default_floor - 1))
  _set_mp "$stubdir" "echo \"System-wide memory free percentage: ${below}%\""
  PATH="$stubdir:$PATH" "$script" myjob "$default_floor" -- true; echo "below: exit=$?"
  _set_mp "$stubdir" "echo \"System-wide memory free percentage: ${default_floor}%\""
  PATH="$stubdir:$PATH" "$script" myjob "$default_floor" -- true; echo "at-floor: exit=$?"
  _set_mp "$stubdir" 'echo "System-wide memory free percentage: 90%"'

  echo "=== $name: 0700 job dir, correct pgid/start/cmd, full trap cleanup on exit ==="
  mkdir -p "$HOME/eta-work"
  PATH="$stubdir:$PATH" "$script" filecheck -- sleep 2 &
  local wbg=$!
  sleep 0.5
  local jobdir; jobdir=$(ls -d "$HOME"/eta-work/filecheck-* 2>/dev/null | head -1)
  if [ -n "$jobdir" ]; then
    echo "perm: $(stat -f '%Lp' "$jobdir") (expect 700)"
    echo "pgid: $(cat "$jobdir/pgid")"
    echo "start: $(cat "$jobdir/start")"
    echo "cmd: $(cat "$jobdir/cmd")"
  else
    echo "job dir not found while running (unexpected)"
  fi
  wait "$wbg" 2>/dev/null
  sleep 0.3
  if ls -d "$HOME"/eta-work/filecheck-* >/dev/null 2>&1; then echo "dir STILL present (unexpected)"; else echo "dir cleaned up after exit (expected)"; fi

  rm -rf "$stubdir"
}

_job_pgid_group_test() {
  local name="$1" script="$2"
  local stubdir; stubdir=$(_mk_stubdir)
  mkdir -p "$HOME/eta-work"

  echo "=== $name: 3-children process-group STOP/CONT (awk membership form, never ps -g -- #3029) ==="
  PATH="$stubdir:$PATH" "$script" pgid3 -- bash -c 'sleep 30 & sleep 30 & sleep 30 & wait' &
  local wbg=$!
  sleep 1
  local jobdir; jobdir=$(ls -td "$HOME"/eta-work/pgid3-* | head -1)
  local pgid; pgid=$(cat "$jobdir/pgid")
  echo "pgid file: $jobdir/pgid -> $pgid"
  echo "--- before pause ---"; ps -axo pid,pgid,stat,command | awk -v g="$pgid" '$2==g'

  kill -STOP -"$pgid"; sleep 0.3
  echo "--- after SIGSTOP -$pgid (expect all state T) ---"; ps -axo pid,pgid,stat,command | awk -v g="$pgid" '$2==g'

  kill -CONT -"$pgid"; sleep 0.3
  echo "--- after SIGCONT -$pgid (expect running/sleeping) ---"; ps -axo pid,pgid,stat,command | awk -v g="$pgid" '$2==g'

  kill -TERM -"$pgid" 2>/dev/null || true
  wait "$wbg" 2>/dev/null || true
  rm -rf "$stubdir"
}

_job_runtime_watcher_test() {
  local name="$1" script="$2" env_var="$3" default_floor="$4"
  local stubdir; stubdir=$(_mk_stubdir)
  mkdir -p "$HOME/eta-work"

  echo "=== $name: runtime watcher pauses on low memory, resumes on recovery (own pgid/start check) ==="
  env "$env_var=1" PATH="$stubdir:$PATH" "$script" watchme "$default_floor" -- bash -c 'sleep 20' &
  local wbg=$!
  sleep 0.5
  local jobdir; jobdir=$(ls -d "$HOME"/eta-work/watchme-* | head -1)
  local pgid; pgid=$(cat "$jobdir/pgid")
  echo "started, pgid=$pgid"; ps -o pid,stat -p "$pgid"

  local below=$((default_floor - 1))
  _set_mp "$stubdir" "echo \"System-wide memory free percentage: ${below}%\""
  sleep 2.5
  echo "--- after memory drop (expect T) ---"; ps -o pid,stat -p "$pgid"

  _set_mp "$stubdir" 'echo "System-wide memory free percentage: 90%"'
  sleep 2.5
  echo "--- after memory recovery (expect S/R) ---"; ps -o pid,stat -p "$pgid"

  kill -TERM -"$pgid" 2>/dev/null || true
  wait "$wbg" 2>/dev/null || true
  rm -rf "$stubdir"
}

# eta-refuter-2 #3057 / fleet #3059: the critical regression test. Under `set -m`, a bare `wait $PID`
# returns early when the child is merely STOPPED, so the wrapper used to think a paused job had died,
# clean up (delete pgid/start/cmd, free the slot) while it was still alive but stopped -- orphaning it.
# This proves the job actually SURVIVES a pause/resume cycle and the wrapper exits 0, not just that the
# process shows state T at one instant.
_job_survives_pause_test() {
  local name="$1" script="$2" env_var="$3" default_floor="$4"
  local stubdir; stubdir=$(_mk_stubdir)
  mkdir -p "$HOME/eta-work"

  echo "=== $name: job SURVIVES a pause/resume cycle, finishes normally, wrapper exits 0 ==="
  env "$env_var=1" PATH="$stubdir:$PATH" "$script" survive-pause "$default_floor" -- bash -c 'echo job-start; sleep 6; echo job-finished-normally' &
  local wbg=$!
  sleep 1
  local jobdir; jobdir=$(ls -d "$HOME"/eta-work/survive-pause-* 2>/dev/null | head -1)

  local below=$((default_floor - 1))
  _set_mp "$stubdir" "echo \"System-wide memory free percentage: ${below}%\""
  sleep 2
  if [ -d "$jobdir" ]; then echo "files present during pause (expected)"; else echo "files GONE during pause (BUG)"; fi

  _set_mp "$stubdir" 'echo "System-wide memory free percentage: 90%"'
  sleep 3

  wait "$wbg"
  echo "wrapper exit=$? (expect 0)"
  if [ -d "$jobdir" ]; then echo "dir STILL present after finish (unexpected)"; else echo "dir cleaned up after real finish (expected)"; fi
  rm -rf "$stubdir"
}

# eta-refuter-2 #3065: the same survival must hold for an EXTERNAL pause (e.g. fleet sending
# kill -STOP -PGID directly), not only a pause the script's own watcher initiates -- this is the exact
# path fleet's pause playbook depends on.
_job_survives_external_stop_test() {
  local name="$1" script="$2" default_floor="$3"
  local stubdir; stubdir=$(_mk_stubdir)
  mkdir -p "$HOME/eta-work"

  echo "=== $name: job SURVIVES an EXTERNAL kill -STOP -PGID (fleet's path), finishes normally, exit 0 ==="
  PATH="$stubdir:$PATH" "$script" survive-extstop "$default_floor" -- bash -c 'echo job-start; sleep 6; echo job-finished-normally' &
  local wbg=$!
  sleep 1
  local jobdir; jobdir=$(ls -d "$HOME"/eta-work/survive-extstop-* 2>/dev/null | head -1)
  local pgid; pgid=$(cat "$jobdir/pgid" 2>/dev/null)

  echo "-- external kill -STOP -$pgid (t=1s) --"
  kill -STOP -"$pgid"
  sleep 2
  ps -o pid,stat -p "$pgid" 2>/dev/null
  if [ -d "$jobdir" ]; then echo "files present during external stop (expected)"; else echo "files GONE during external stop (BUG)"; fi

  echo "-- external kill -CONT -$pgid (t=3s) --"
  kill -CONT -"$pgid"

  wait "$wbg"
  echo "wrapper exit=$? (expect 0)"
  if [ -d "$jobdir" ]; then echo "dir STILL present after finish (unexpected)"; else echo "dir cleaned up after real finish (expected)"; fi
  rm -rf "$stubdir"
}

_job_concurrency_test() {
  local name="$1" script="$2" cap="$3" slotdir_name="$4"
  local stubdir; stubdir=$(_mk_stubdir)
  rm -rf "$HOME/eta-work/$slotdir_name"

  echo "=== $name: concurrency cap $cap, $((cap + 1)) dummies -> exactly one refused ==="
  local pids=() i n=$((cap + 1))
  for ((i = 1; i <= n; i++)); do
    PATH="$stubdir:$PATH" "$script" "conc-$i" -- sleep 2 > "/tmp/${name}-conc-$i.out" 2>&1 &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p"; echo "pid $p exit=$?"; done
  for ((i = 1; i <= n; i++)); do echo "--- conc-$i ---"; cat "/tmp/${name}-conc-$i.out"; rm -f "/tmp/${name}-conc-$i.out"; done
  rm -rf "$stubdir"
}

mac_job_tests() {
  _job_common_tests mac-job "$HERE/mac-job.sh" 20
  echo; _job_pgid_group_test mac-job "$HERE/mac-job.sh"
  echo; _job_runtime_watcher_test mac-job "$HERE/mac-job.sh" MACJOB_WATCH_INTERVAL 20
  echo; _job_survives_pause_test mac-job "$HERE/mac-job.sh" MACJOB_WATCH_INTERVAL 20
  echo; _job_survives_external_stop_test mac-job "$HERE/mac-job.sh" 20
  echo; _job_concurrency_test mac-job "$HERE/mac-job.sh" 4 .slots-mac-job
}

air_job_tests() {
  _job_common_tests air-job "$HERE/air-job.sh" 25
  echo; _job_pgid_group_test air-job "$HERE/air-job.sh"
  echo; _job_runtime_watcher_test air-job "$HERE/air-job.sh" AIRJOB_WATCH_INTERVAL 25
  echo; _job_survives_pause_test air-job "$HERE/air-job.sh" AIRJOB_WATCH_INTERVAL 25
  echo; _job_survives_external_stop_test air-job "$HERE/air-job.sh" 25
  echo; _job_concurrency_test air-job "$HERE/air-job.sh" 3 .slots-air-job

  echo "=== air-job: on battery -> refuse, exit 4 ==="
  local stubdir; stubdir=$(_mk_stubdir)
  _set_pmset "$stubdir" "echo \"Now drawing from 'Battery Power'\""
  PATH="$stubdir:$PATH" "$HERE/air-job.sh" myjob -- true; echo "exit=$?"

  echo "=== air-job: garbled pmset output -> refuse, exit 4 (fail closed, not 'assume AC') ==="
  _set_pmset "$stubdir" 'echo "some unrelated output"'
  PATH="$stubdir:$PATH" "$HERE/air-job.sh" myjob -- true; echo "exit=$?"
  rm -rf "$stubdir"
}

# --- Linux/systemd tests: run by eta-refuter-2 on the box (systemd 249, #3021/#3026) -- PASS. Still owed:
# --- the same run on orbox3 itself (systemd 259) with its cgroup.controllers line.

orbox_job_duplicate_unit_test() {
  local script="$HERE/orbox-job.sh"
  echo "=== orbox-job: fixed --unit collision fails loudly; missing '--' refused; same-description jobs don't clash ==="
  echo "--- missing '--' separator ---"
  "$script" mydesc sleep 5; echo "exit=$?"
  systemd-run --user --scope --unit="eta-collision-test" --collect -- sleep 30 &
  sleep 0.3
  echo "--- duplicate fixed unit name, expect systemd-run to error ---"
  systemd-run --user --scope --unit="eta-collision-test" --collect -- sleep 30; echo "exit=$?"
  echo "--- normal orbox-job invocations never collide (PID-suffixed unit names) ---"
  "$script" "same description" -- sleep 5 &
  "$script" "same description" -- sleep 5 &
  sleep 1
  systemctl --user list-units --plain --no-legend 'eta-same-description-*'
  systemctl --user stop eta-collision-test.scope 2>/dev/null || true
}

orbox_job_freeze_thaw_test() {
  local script="$HERE/orbox-job.sh"
  echo "=== orbox-job: freeze/thaw pause semantics (fleet #2971/#2972) ==="
  "$script" freeze-thaw-dummy -- sleep 60 &
  sleep 1
  local unit; unit=$(systemctl --user list-units --plain --no-legend 'eta-freeze-thaw-dummy-*' | awk '{print $1}')
  echo "unit: $unit"
  systemctl --user freeze "$unit"
  echo "--- FreezerState after freeze (expect frozen) ---"; systemctl --user show -p FreezerState "$unit"
  systemctl --user thaw "$unit"
  echo "--- FreezerState after thaw (expect running/not frozen) ---"; systemctl --user show -p FreezerState "$unit"
  systemctl --user stop "$unit" 2>/dev/null || true
}

case "${1:-}" in
  mac) mac_job_tests ;;
  air) air_job_tests ;;
  orbox) orbox_job_duplicate_unit_test; echo; orbox_job_freeze_thaw_test ;;
  all) mac_job_tests; echo; air_job_tests; echo; orbox_job_duplicate_unit_test; echo; orbox_job_freeze_thaw_test ;;
  *) echo "usage: $0 {mac|air|orbox|all}" >&2; exit 1 ;;
esac
