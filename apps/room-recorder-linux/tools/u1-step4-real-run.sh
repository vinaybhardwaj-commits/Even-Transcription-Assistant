#!/bin/bash
# U1 step 4 acceptance tape, independent of when the device is cycled.
#   Session A (hooks build, tee): starve the writer at 10 s for 1 s (ring_overflow), then record until a REAL device
#   loss and return appear in the index (someone runs `sudo tools/u1-device-cycle.sh 5`), keep 15 s more, then
#   SIGKILL — so the tape ends without `stopped` and has a surviving tail.
#   Session B: restart the same tape, record 20 s, stop cleanly.
# usage: tools/u1-step4-real-run.sh TAPEDIR TEEDIR
set -u
tape=$1; tees=$2
here=$(cd "$(dirname "$0")/.." && pwd)
bin="$here/.build-hooks/release/room-recorder"
dev=hw:CARD=sofhdadsp,DEV=6
mkdir -p "$tees"; rm -rf "$tape"
# stay clear of IST midnight: record at most until 23:50 IST
now=$(date +%s); midnight=$(( ( (now + 19800) / 86400 + 1) * 86400 - 19800 )); cap=$(( midnight - now - 600 - 120 ))
echo "$(date +%T) session A starting, cap ${cap}s"
"$bin" record --device $dev --tape "$tape" --seconds $cap --ring-frames 12000 --starve-writer-at 10 --starve-writer-for 1 \
    --tee-input "$tees/teeA.raw" > "$tees/A.json" 2>&1 &
pid=$!
until grep -q '"discontinuity":"resumed"' "$tape/tape.idx" 2>/dev/null; do
    kill -0 $pid 2>/dev/null || { echo "session A ended before a device loss was seen"; exit 1; }
    sleep 1
done
echo "$(date +%T) device_lost and resumed recorded; 15 s more, then SIGKILL"
sleep 15
kill -9 $pid; wait $pid 2>/dev/null
echo "$(date +%T) session A killed"
"$bin" record --device $dev --tape "$tape" --seconds 20 --tee-input "$tees/teeB.raw" > "$tees/B.json" 2>&1
echo "$(date +%T) session B exit=$?"
echo DONE
