#!/bin/zsh
# usage: fable-inbox.sh
# Prints bus/for-fable.jsonl lines appended since the last call and
# advances bus/fable-inbox.cursor past them. Run this on every Fable
# check-in — pane-watch.py is the only writer of for-fable.jsonl.
LAB="${FABLE_INBOX_LAB:-$HOME/dev/eta-lab}"   # override: tests only
FILE="$LAB/bus/for-fable.jsonl"
CURSOR="$LAB/bus/fable-inbox.cursor"
# for-fable.jsonl is gitignored and pane-watch (the Mini's launchd job) is its only real writer, so a
# copy on any other machine (e.g. the box) never syncs and Fable never sees what is appended to it
# (eta-refuter-2, bus #50, 24 Sep). Refuse to run where pane-watch is not the live writer.
# Liveness = "can I take the lock?", not "is the pid in the file alive?" (Fable ruling 139; eta-refuter #409). pane-watch.py
# holds a kernel flock on this file for its whole life (fcntl.flock LOCK_EX|LOCK_NB), released by the OS when it dies. A pid
# check has two holes: a crashed pane-watch leaves its pid behind and the OS can hand that number to an unrelated process
# (then a dead writer looks alive), and it is not atomic. Here: if a non-blocking lock attempt FAILS, someone holds it, so
# pane-watch is alive; if it SUCCEEDS, nobody does, so it is dead. A missing lock file is dead too. (The lock is taken and
# released at once; pane-watch starting in that instant retries under launchd KeepAlive.)
if ! /usr/bin/python3 - "$LAB/bus/pane-watch.lock" <<'PY'
import fcntl, sys
try:
    f = open(sys.argv[1], "r")          # read-only: never creates the file, never truncates it
except OSError:
    sys.exit(1)                          # no lock file: no live pane-watch
try:
    fcntl.flock(f.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(0)                          # held by someone (pane-watch's LOCK_EX): alive. The ONE real "held" answer.
except OSError:
    sys.exit(1)                          # any other error means "cannot tell" (eta-refuter #481): refuse, never read it as alive
sys.exit(1)                              # we got it, so nobody holds it: dead
PY
then
  echo "fable-inbox.sh: refusing to run -- no live pane-watch.py on this machine ($(hostname -s)), so $FILE is not the file Fable reads. Nothing was read or advanced." >&2
  exit 2
fi
[ -f "$FILE" ] || exit 0
TOTAL=$(wc -l < "$FILE" | tr -d ' ')
LAST=$(cat "$CURSOR" 2>/dev/null || echo 0)
case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac
if [ "$LAST" -ge "$TOTAL" ]; then
  exit 0
fi
tail -n "+$((LAST + 1))" "$FILE"
echo "$TOTAL" > "$CURSOR"
