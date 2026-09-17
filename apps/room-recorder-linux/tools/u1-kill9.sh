#!/bin/bash
# U1 step 3 acceptance: kill -9 the recorder at pseudo-random moments, then check the index/PCM invariant on each tape.
# usage: tools/u1-kill9.sh RUNS OUTDIR   (tapes hold real audio: keep OUTDIR outside the repository)
set -u
runs=$1; out=$2
here=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$out"
RANDOM=314159
for i in $(seq 1 "$runs"); do
  tape="$out/kill-$i"; rm -rf "$tape"
  # between 0.3 s and 8.2 s after launch
  delay=$(printf '0.%03d' $((RANDOM % 1000))); delay=$(echo "$delay + $((RANDOM % 8)) + 0.3" | bc)
  "$here/.build/release/room-recorder" record --device hw:CARD=sofhdadsp,DEV=6 --tape "$tape" --seconds 60 > /dev/null 2>&1 &
  pid=$!
  sleep "$delay"
  kill -9 "$pid"; wait "$pid" 2>/dev/null
  echo "run $i killed after ${delay}s: $(python3 "$here/tools/check_tape_invariant.py" "$tape" --expect-stopped no)"
done
