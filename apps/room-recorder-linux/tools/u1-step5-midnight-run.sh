#!/bin/bash
# U1 step 5 acceptance: record real room audio across an INJECTED IST midnight with a TAPE_TEST_HOOKS build.
# CLOCK_REALTIME is made to read 20 s before the next IST midnight at startup; the run then crosses it, with a starved
# writer (ring_overflow) at 35 s and an injected device loss (device_lost/resumed, a new capture session) at 45 s.
# Build first: docker run --rm -v "$PWD":/w -w /w eta-u1-build swift build -c release --static-swift-stdlib \
#                -Xswiftc -DTAPE_TEST_HOOKS --build-path .build-hooks
# usage: tools/u1-step5-midnight-run.sh TAPEDIR      (writes TAPEDIR and TAPEDIR.summary.json; never inside the repo)
set -eu
tape=$1
here=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$tape" "$tape.summary.json"
origin=$(python3 -c "
import time
now = time.time_ns(); off = 19800 * 10**9; day = 86400 * 10**9
print(((now + off) // day + 1) * day - off - 20 * 10**9)")
echo "injected wall origin $origin (20 s before an IST midnight)"
"$here/.build-hooks/release/room-recorder" record --device hw:CARD=sofhdadsp,DEV=6 --tape "$tape" --seconds 60 \
    --test-wall-origin-ns "$origin" --starve-writer-at 35 --starve-writer-for 1.5 \
    --inject-device-lost-at 45 --inject-device-lost-for 2 > "$tape.summary.json"
python3 "$here/tools/check_tape_invariant.py" "$tape" --expect-stopped yes
