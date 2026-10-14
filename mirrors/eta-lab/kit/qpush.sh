#!/bin/zsh
# usage: qpush.sh <agent> <order-file>
# Enqueues <order-file> for <agent>'s next transition to done/idle:
# copies it to orders/queue/<agent>/NNN-<basename>, NNN = the next unused
# 3-digit sequence number for that agent's queue. pane-watch.py sends the
# lowest-numbered file the moment <agent> goes working -> done/idle, then
# moves it to orders/queue/<agent>/sent/.
set -e
AGENT="$1"; FILE="$2"
if [ -z "$AGENT" ] || [ -z "$FILE" ]; then
  echo "usage: qpush.sh <agent> <order-file>" >&2
  exit 2
fi
if [ ! -f "$FILE" ]; then
  echo "not a file: $FILE" >&2
  exit 2
fi
LAB="$HOME/dev/eta-lab"
QDIR="$LAB/orders/queue/$AGENT"
mkdir -p "$QDIR" "$QDIR/sent"
LAST=$(ls "$QDIR" 2>/dev/null | grep -E '^[0-9]{3}-' | sed -E 's/^([0-9]{3})-.*/\1/' | sort -n | tail -1)
NEXT=$(printf "%03d" $((${LAST:-0} + 1)))
BASENAME=$(basename "$FILE")
DEST="$QDIR/$NEXT-$BASENAME"
cp "$FILE" "$DEST"
echo "queued: $DEST"
