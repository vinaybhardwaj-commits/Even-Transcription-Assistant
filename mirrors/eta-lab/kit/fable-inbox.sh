#!/bin/zsh
# usage: fable-inbox.sh
# Prints bus/for-fable.jsonl lines appended since the last call and
# advances bus/fable-inbox.cursor past them. Run this on every Fable
# check-in — pane-watch.py is the only writer of for-fable.jsonl.
LAB="$HOME/dev/eta-lab"
FILE="$LAB/bus/for-fable.jsonl"
CURSOR="$LAB/bus/fable-inbox.cursor"
# for-fable.jsonl is gitignored and pane-watch (the Mini's launchd job) is its only real writer, so a
# copy on any other machine (e.g. the box) never syncs and Fable never sees what is appended to it
# (eta-refuter-2, bus #50, 24 Sep). Refuse to run where pane-watch is not the live writer.
LOCKPID=$(cat "$LAB/bus/pane-watch.lock" 2>/dev/null)
if ! { [ -n "$LOCKPID" ] && kill -0 "$LOCKPID" 2>/dev/null; }; then
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
