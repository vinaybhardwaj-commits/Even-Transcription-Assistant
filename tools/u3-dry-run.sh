#!/bin/bash
# U3 dry run: room-bench end to end against tools/bench-stub.py, over real HTTP, with the real pinned ffmpeg, on a
# synthetic tape from tools/fake-capture.py. No server, no bootstrap token, no room audio. Needs a test-hook build:
#   docker run --rm -v "$PWD":/w -w /w eta-u1-build swift build -c release --static-swift-stdlib \
#       -Xswiftc -DBENCH_TEST_HOOKS --scratch-path .build-bench-hooks --product room-bench
# usage: tools/u3-dry-run.sh WORKDIR
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
bench="$here/.build-bench-hooks/release/room-bench"
work=$1
port=${PORT:-18643}
rm -rf "$work"; mkdir -p "$work/root" "$work/stub"; chmod 750 "$work/root"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

python3 "$here/tools/bench-stub.py" "$port" "$work/stub" & pids+=($!)
python3 "$here/tools/fake-capture.py" "$work/tape" 10 & pids+=($!)
sleep 1
stub() { curl -s -X POST "http://127.0.0.1:$port/_stub/$1" -H 'Content-Type: application/json' -d "$2" > /dev/null; }
state() { curl -s "http://127.0.0.1:$port/_stub/state"; }
waitfor() {  # waitfor SECONDS PYTHON-EXPRESSION-over-s
    local deadline=$((SECONDS + $1))
    while [ $SECONDS -lt $deadline ]; do
        if state | python3 -c "import json,sys; s=json.load(sys.stdin); sys.exit(0 if ($2) else 1)"; then return 0; fi
        sleep 0.5
    done
    echo "TIMED OUT waiting for: $2" >&2; state | python3 -m json.tool | tail -40 >&2; return 1
}

echo "== enrol: a wrong token is refused and writes nothing"
echo "WRONG" > "$work/token"
if "$bench" enrol --origin "http://127.0.0.1:$port" --token-file "$work/token" --device-uid usb:0d8c:0134 --root "$work/root"; then
    echo "FAIL: a wrong token enrolled"; exit 1; fi
[ -z "$(ls -A "$work/root")" ] || { echo "FAIL: a refused enrol wrote files"; exit 1; }
echo "BOOT-DRY-RUN" > "$work/token"
"$bench" enrol --origin "http://127.0.0.1:$port" --token-file "$work/token" --device-uid usb:0d8c:0134 --root "$work/root"
# Point the enrolled room at the synthetic tape (the only hand edit; config.json stays 0600).
python3 - "$work/root/config.json" "$work/tape" <<'PY'
import json, os, sys
p, tape = sys.argv[1], sys.argv[2]
c = json.load(open(p)); c["tape_dir"] = tape
tmp = p + ".tmp"; fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.write(fd, json.dumps(c, indent=2, sort_keys=True).encode()); os.close(fd); os.rename(tmp, p)
PY
stat -c '%a %n' "$work/root" "$work/root/config.json" "$work/root/room-session.json"

echo "== serve"
"$bench" serve --root "$work/root" 2> "$work/serve.log" & serve=$!; pids+=($serve)
waitfor 10 "len(s['polls']) >= 2"

echo "== start_day whose three ack attempts all fail, so the next poll REDELIVERS it: re-acked, not re-executed"
stub fail-ack '{"id":"cmd_start","times":3}'
stub enqueue '{"id":"cmd_start","kind":"start_day"}'
waitfor 20 "any(a['id']=='cmd_start' and a['landed'] for a in s['acks'])"
echo "== an unknown kind, check_update_now, report_diag, set_audio_input to the same device, restart refused while open"
stub enqueue '{"id":"cmd_unknown","kind":"teleport_room"}'
stub enqueue '{"id":"cmd_update","kind":"check_update_now"}'
stub enqueue '{"id":"cmd_diag","kind":"report_diag","args":{"log_lines":20}}'
stub enqueue '{"id":"cmd_audio","kind":"set_audio_input","args":{"device_uid":"usb:0d8c:0134"}}'
stub enqueue '{"id":"cmd_absent","kind":"set_audio_input","args":{"device_uid":"usb:dead:beef"}}'
stub enqueue '{"id":"cmd_restart","kind":"restart_engine"}'
waitfor 20 "all(any(a['id']==i and a['landed'] for a in s['acks']) for i in ['cmd_unknown','cmd_update','cmd_diag','cmd_audio','cmd_absent','cmd_restart'])"
echo "== a full 5-minute piece (30 s of wall time at 10x), uploaded in five steps"
waitfor 90 "len(s['chunks']) >= 1"
echo "== pause_day, 20 s of tape while paused, resume_day, end_day"
stub enqueue '{"id":"cmd_pause","kind":"pause_day"}'
waitfor 20 "any(a['id']=='cmd_pause' and a['landed'] for a in s['acks'])"
sleep 2
stub enqueue '{"id":"cmd_resume","kind":"resume_day"}'
waitfor 30 "any(a['id']=='cmd_resume' and a['landed'] for a in s['acks'])"
sleep 3
stub enqueue '{"id":"cmd_end","kind":"end_day"}'
waitfor 60 "any(a['id']=='cmd_end' and a['landed'] for a in s['acks'])"
echo "== restart_engine with the session closed: acked, then exit 75; relaunched as systemd would"
stub enqueue '{"id":"cmd_restart2","kind":"restart_engine"}'
set +e; wait $serve; code=$?; set -e
[ "$code" = 75 ] || { echo "FAIL: restart_engine exit $code, expected 75"; exit 1; }
"$bench" serve --root "$work/root" 2>> "$work/serve.log" & serve=$!; pids+=($serve)
polls_before=$(state | python3 -c "import json,sys; print(len(json.load(sys.stdin)['polls']))")
waitfor 10 "len(s['polls']) > $polls_before + 1"
echo "== retired: the next poll answers 409 RETIRED"
stub retire '{}'
waitfor 20 "True" && sleep 6
[ -f "$work/root/retired.json" ] || { echo "FAIL: no retired.json"; exit 1; }
echo "== an idle (retired) process still stops on SIGTERM"
kill -TERM $serve
for _ in $(seq 1 50); do kill -0 $serve 2>/dev/null || break; sleep 0.1; done
if kill -0 $serve 2>/dev/null; then echo "FAIL: idle serve ignored SIGTERM"; exit 1; fi
wait $serve || true
state > "$work/stub-state.json"
echo "== assertions over what the stub saw"
python3 - "$work" <<'PY'
import json, os, subprocess, sys
work = sys.argv[1]
s = json.load(open(f"{work}/stub-state.json"))
def check(cond, what):
    print(("ok    " if cond else "FAIL  ") + what)
    if not cond: sys.exit(1)
starts = [a for a in s["acks"] if a["id"] == "cmd_start"]
check(len(s["sessions"]) == 1, "one session created for a start_day delivered twice")
check([a["landed"] for a in starts] == [False, False, False, True], "start_day: 3 failed ack attempts, then re-acked on redelivery")
acked = {a["id"]: a["body"] for a in s["acks"] if a["landed"]}
check(acked["cmd_unknown"] == {"ok": False, "error": "unsupported_kind"}, "unknown kind acked ok:false unsupported_kind")
check(acked["cmd_update"]["error"] == "unsupported_kind", "check_update_now acked ok:false unsupported_kind (D3)")
check(acked["cmd_absent"]["error"] == "device_not_present", "set_audio_input to an absent device refused")
check(acked["cmd_restart"]["error"] == "session_open", "restart_engine refused while a session is open")
check(acked["cmd_restart2"].get("restarting") is True, "restart_engine acked restarting:true before exiting")
check([p["action"] for p in s["patches"]] == ["pause", "resume", "end"], "session PATCHes: pause, resume, end")
chunks = sorted(s["chunks"], key=lambda c: c["idx"])
check([c["idx"] for c in chunks] == list(range(len(chunks))) and len(chunks) >= 3, "piece indices contiguous from 0")
check(chunks[0]["duration_ms"] == 300000, "first piece is a full 5 minutes")
check(any(c["gap_before_ms"] > 10000 for c in chunks[1:]), "the piece after resume carries the paused gap")
check(all(p["cookie"] is None for p in s["puts"]), "storage PUTs carry no session cookie")
check(s["unauthenticated"] == 0, "every API request carried the session cookie")
for c in chunks:
    path = f"{work}/stub/objects/{c['session_id']}-{c['idx']}.webm"
    out = subprocess.run(["/usr/bin/ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"], capture_output=True)
    check(os.path.getsize(path) == c["size_bytes"] and len(out.stdout) // 2 == c["duration_ms"] * 16,
          f"piece {c['idx']}: stored size matches, decodes to exactly {c['duration_ms']} ms")
check(not os.listdir(f"{work}/root/spool"), "spool empty: every piece deleted only after verified registration")
check(os.path.exists(f"{work}/root/retired.json"), "retired.json written on 409 RETIRED")
PY
echo "== serve log"
cat "$work/serve.log"
echo "state: $work/stub-state.json   objects: $work/stub/objects"
