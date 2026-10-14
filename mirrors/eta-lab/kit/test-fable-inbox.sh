#!/bin/zsh
# test-fable-inbox.sh: the liveness check in fable-inbox.sh is a flock attempt, not a pid check (Fable ruling 139).
# Runs against a temp directory via FABLE_INBOX_LAB; never touches the real cursor. Exit 0 = all pass.
F="$(cd "$(dirname "$0")" && pwd)/fable-inbox.sh"; T=$(mktemp -d); mkdir -p $T/bus; printf 'l1\nl2\n' > $T/bus/for-fable.jsonl; bad=0
run() { FABLE_INBOX_LAB=$T zsh $F >$T/o 2>$T/e; echo $?; }
chk() { [ "$2" = "$3" ] && echo "PASS $1" || { echo "FAIL $1 (exit $2, wanted $3)"; bad=1; }; rm -f $T/bus/fable-inbox.cursor; }
chk "no lock file -> refuse" "$(run)" 2
echo "$$" > $T/bus/pane-watch.lock
chk "pid of a live unrelated process, nobody holds the flock (pid reuse) -> refuse" "$(run)" 2
python3 -c "
import fcntl,time
f=open('$T/bus/pane-watch.lock','a+'); fcntl.flock(f.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB); time.sleep(6)" & HP=$!; sleep 1.5
chk "flock held by another process (live writer) -> run" "$(run)" 0
kill $HP 2>/dev/null; wait 2>/dev/null; rm -rf $T; exit $bad
