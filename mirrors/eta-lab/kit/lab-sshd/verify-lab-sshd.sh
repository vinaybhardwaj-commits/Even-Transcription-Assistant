#!/bin/bash
# verify-lab-sshd.sh (herdr-kit, ruling 129): run ON THE MINI. Checks the three things the ruling asks for.
#   1. N concurrent "ssh mini" from the box (default 50, each held 6 s so they overlap) all succeed, N times over R runs (default 3)
#   2. the system sshd's launchd instance count (children of pid 1) versus its cap of 42, and the lab sshd's children
#   3. the last lines of the probe log
# Usage: kit/lab-sshd/verify-lab-sshd.sh [N] [RUNS]     (needs ssh e2e-lab-ts; opens no session on the system sshd)
N="${1:-50}"; RUNS="${2:-3}"
LAB=$(pgrep -f "sshd -D -e -f $HOME/.ssh/lab-sshd/sshd_config" | head -1)
count() { ps -axo pid,ppid,command | awk -v lab="$LAB" '/sshd-session: [a-z]+ \[priv\]/ { if ($2==1) sys++; else if ($2==lab) l++ } END{printf "system_instances=%d (cap 42) lab_children=%d", sys, l}'; }
echo "lab sshd pid: ${LAB:-NOT RUNNING}"; echo "before: $(count)"
fail=0
for r in $(seq 1 "$RUNS"); do
  out=$(ssh -o ConnectTimeout=10 e2e-lab-ts "seq $N | xargs -P $N -I{} sh -c 'timeout 40 ssh -o BatchMode=yes -o ControlPath=none -o ConnectTimeout=20 mini \"sleep 6; echo ok\" 2>/dev/null | grep -q ok && echo OK || echo FAIL' | sort | uniq -c | tr -s ' ' | tr '\n' ';'")
  echo "run $r, $N concurrent: $out"; case "$out" in *FAIL*) fail=1;; esac; sleep 2
done
echo "after: $(count)"; echo "probe log tail:"; tail -3 "$HOME/dev/eta-lab/bus/ssh-mini-probe.log" 2>/dev/null
[ "$fail" = 0 ] && echo "RESULT ok" || echo "RESULT concurrency_failed"; exit "$fail"
