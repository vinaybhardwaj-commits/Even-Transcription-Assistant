#!/bin/bash
# U3 fix 1 end to end: set_audio_input from the (stub) Bench -> room-bench writes config.json -> room-recorder re-pins
# itself -> room-bench acks what the capture confirmed. Real processes, real HTTP, real tape; synthetic capture devices
# (a tone generator described by a JSON file), so there is no sound card and no room audio. Needs test-hook builds:
#   docker run --rm -v "$PWD":/w -w /w eta-u1-build swift build -c release --static-swift-stdlib \
#       -Xswiftc -DTAPE_TEST_HOOKS --scratch-path .build-hooks --product room-recorder
#   docker run --rm -v "$PWD":/w -w /w eta-u1-build swift build -c release --static-swift-stdlib \
#       -Xswiftc -DBENCH_TEST_HOOKS --scratch-path .build-bench-hooks --product room-bench
# usage: tools/u3-repin-dry-run.sh WORKDIR VERIFY-RUNNER
#   VERIFY-RUNNER runs deploy/u2-acceptance-verify.sh's python body on a tape directory without the root gate.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
recorder="$here/.build-hooks/release/room-recorder"
bench="$here/.build-bench-hooks/release/room-bench"
work=$1
verify=$2
port=${PORT:-18644}
rm -rf "$work"; mkdir -p "$work/root" "$work/stub"; chmod 750 "$work/root"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
devices() { printf '%s' "$1" > "$work/devices.json.tmp" && mv "$work/devices.json.tmp" "$work/devices.json"; }
devices '[{"stable_name":"hw:CARD=SynthA,DEV=0","usbid":"dead:0001","channels":1},{"stable_name":"hw:CARD=SynthB,DEV=0","usbid":"dead:0002","channels":2},{"stable_name":"hw:CARD=SynthC,DEV=0","usbid":"dead:0003","channels":1,"busy":true}]'

python3 "$here/tools/bench-stub.py" "$port" "$work/stub" & pids+=($!)
sleep 1
stub() { curl -s -X POST "http://127.0.0.1:$port/_stub/$1" -H 'Content-Type: application/json' -d "$2" > /dev/null; }
state() { curl -s "http://127.0.0.1:$port/_stub/state"; }
ackbody() { state | python3 -c "import json,sys; s=json.load(sys.stdin); a=[x for x in s['acks'] if x['id']=='$1' and x['landed']]; print(json.dumps(a[-1]['body'], sort_keys=True) if a else '')"; }
waitack() {
    for _ in $(seq 1 120); do [ -n "$(ackbody "$1")" ] && return 0; sleep 0.5; done
    echo "TIMED OUT waiting for the ack of $1" >&2; return 1
}
check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; exit 1; fi; }
uid_in_config() { python3 -c "import json; print(json.load(open('$work/root/config.json'))['device_uid'])"; }
status_field() { python3 -c "import json; print(json.load(open('$work/root/capture-device.json'))['$1'])"; }

echo "BOOT-DRY-RUN" > "$work/token"
"$bench" enrol --origin "http://127.0.0.1:$port" --token-file "$work/token" --device-uid usb:0d8c:0134 --root "$work/root" > /dev/null
python3 - "$work/root/config.json" "$work/tape" <<'PY'
import json, os, sys
p, tape = sys.argv[1], sys.argv[2]
c = json.load(open(p)); c["tape_dir"] = tape; c["device_uid"] = "usb:dead:0001"
tmp = p + ".tmp"; fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.write(fd, json.dumps(c, indent=2, sort_keys=True).encode()); os.close(fd); os.rename(tmp, p)
PY

"$recorder" record --device-config "$work/root/config.json" --tape "$work/tape" --test-synthetic-devices "$work/devices.json" \
    > "$work/recorder.out" 2> "$work/recorder.err" & recorder_pid=$!; pids+=($recorder_pid)
"$bench" serve --root "$work/root" --test-synthetic-devices "$work/devices.json" 2> "$work/bench.err" & bench_pid=$!; pids+=($bench_pid)
sleep 4
check "capture started on usb:dead:0001" '[ "$(status_field outcome)" = started ] && [ "$(status_field device_uid)" = usb:dead:0001 ]'

echo "== set_audio_input to a device the Bench cannot see"
stub enqueue '{"id":"a_absent","kind":"set_audio_input","args":{"device_uid":"usb:dead:0009"}}'
waitack a_absent
check "acked device_not_present" '[ "$(ackbody a_absent | python3 -c "import json,sys; print(json.load(sys.stdin)[\"error\"])")" = device_not_present ]'
check "config.json never changed" '[ "$(uid_in_config)" = usb:dead:0001 ]'

echo "== the device vanishes between room-bench's check and the capture's (config written directly)"
python3 - "$work/root/config.json" <<'PY'
import json, os, sys
p = sys.argv[1]; c = json.load(open(p)); c["device_uid"] = "usb:dead:0007"
tmp = p + ".t"; fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.write(fd, json.dumps(c).encode()); os.close(fd); os.rename(tmp, p)
PY
sleep 3
check "capture refused it and kept recording the old device" '[ "$(status_field outcome)" = refused_absent ] && [ "$(status_field device_uid)" = usb:dead:0001 ]'
check "capture put config.json back" '[ "$(uid_in_config)" = usb:dead:0001 ]'
check "same capture process" 'kill -0 $recorder_pid'
samples_before=$(tail -1 "$work/tape/tape.idx" | python3 -c "import json,sys; print(json.load(sys.stdin)['samples'])")
sleep 2
samples_after=$(tail -1 "$work/tape/tape.idx" | python3 -c "import json,sys; print(json.load(sys.stdin)['samples'])")
check "the tape is still advancing" '[ "$samples_after" -gt "$samples_before" ]'

echo "== set_audio_input to a PRESENT different device"
stub enqueue '{"id":"a_present","kind":"set_audio_input","args":{"device_uid":"usb:dead:0002"}}'
waitack a_present
check "acked ok with applied_device_uid usb:dead:0002" '[ "$(ackbody a_present)" = "{\"applied_device_uid\": \"usb:dead:0002\", \"ok\": true}" ]'
check "capture re-pinned" '[ "$(status_field outcome)" = switched ] && [ "$(status_field device_uid)" = usb:dead:0002 ]'
check "same PID: re-exec, not a restart systemd would see" 'kill -0 $recorder_pid && [ "$(status_field pid)" = "$recorder_pid" ]'
check "the tape carries stopped then restart" 'grep -q "\"discontinuity\":\"restart\"" "$work/tape/tape.idx"'

echo "== set_audio_input to a present but BUSY device: the capture goes back"
stub enqueue '{"id":"a_busy","kind":"set_audio_input","args":{"device_uid":"usb:dead:0003"}}'
waitack a_busy
check "acked device_switch_failed: reverted: busy" '[ "$(ackbody a_busy | python3 -c "import json,sys; print(json.load(sys.stdin)[\"error\"])")" = "device_switch_failed: reverted: busy" ]'
check "capture is back on usb:dead:0002" '[ "$(status_field outcome)" = reverted ] && [ "$(status_field device_uid)" = usb:dead:0002 ]'
check "config.json is back on usb:dead:0002" '[ "$(uid_in_config)" = usb:dead:0002 ]'
sleep 3

echo "== stop both; the tape across two re-pins and a revert"
kill -TERM $recorder_pid
for _ in $(seq 1 50); do kill -0 $recorder_pid 2>/dev/null || break; sleep 0.1; done
set +e; wait $recorder_pid; code=$?; set -e
check "capture stopped on SIGTERM after its re-execs, exit 0" '[ "$code" = 0 ]'
kill -TERM $bench_pid; wait $bench_pid || true
"$verify" "$work/tape" > "$work/verify.txt" 2>&1 && vexit=0 || vexit=$?
check "U2 verify script exits 0" '[ "$vexit" = 0 ]'
check "U2 verify script: 0 structural breaks" 'grep -q "^  structural breaks   0$" "$work/verify.txt"'
check "U2 verify script: both restarts (the switch, and the reverted attempt) in one boot segment" 'grep -q "restarts in the same boot   2" "$work/verify.txt" && [ "$(grep -c "^  segment " "$work/verify.txt")" = 1 ]'
echo "== capture journal"
cat "$work/recorder.err"
