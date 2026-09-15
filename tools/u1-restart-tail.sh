#!/bin/bash
# U1 step 4: surviving_tail_bytes is measured, not a constant. Record, SIGKILL after DELAY seconds, then — before any
# restart touches the tape — measure tape.pcm with stat and read the last committed record's byte_offset. Restart the
# tape and compare the restart record's previous_byte_offset / surviving_tail_bytes with those measurements.
# usage: tools/u1-restart-tail.sh TAPEDIR DELAY
set -u
tape=$1; delay=$2
here=$(cd "$(dirname "$0")/.." && pwd)
bin="$here/.build/release/room-recorder"
rm -rf "$tape"
"$bin" record --device hw:CARD=sofhdadsp,DEV=6 --tape "$tape" --seconds 600 > /dev/null 2>&1 &
pid=$!
sleep "$delay"; kill -9 $pid; wait $pid 2>/dev/null
pcm_bytes=$(stat -c %s "$tape/tape.pcm")
last_offset=$(python3 -c "
import json; lines=open('$tape/tape.idx','rb').read().split(b'\n')
print([json.loads(l)['byte_offset'] for l in lines if l.strip()][-1])")
echo "after SIGKILL at ${delay}s: stat tape.pcm = $pcm_bytes bytes; last committed record byte_offset = $last_offset; difference = $((pcm_bytes - last_offset))"
"$bin" record --device hw:CARD=sofhdadsp,DEV=6 --tape "$tape" --seconds 3 > "$tape.restart.json" 2>&1
python3 - "$tape" <<'EOF'
import json, sys
t = sys.argv[1]
r = next(json.loads(l) for l in open(t + "/tape.idx") if '"discontinuity":"restart"' in l)
print("restart record: byte_offset", r["byte_offset"], "previous_byte_offset", r["previous_byte_offset"], "surviving_tail_bytes", r["surviving_tail_bytes"],
      "| keys", sorted(r))
EOF
