#!/bin/bash
# The live enrol aborted after the server's success and before any write. This kills `room-bench enrol` (a
# -DBENCH_TEST_HOOKS build) with abort(3) at every named point against tools/bench-stub.py, then shows what is on disk
# before and after the next start's recovery (`room-bench serve` runs completeInterruptedEnrolment first).
# The invariant: after recovery, room-session.json and config.json are both present, parse, are 0600 and name the same
# install — or neither exists. Never one without the other, never a partial file, never a stray staged config.
# usage: tools/u3-enrol-abort-check.sh WORKDIR
set -uo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
bench="$here/.build-bench-hooks/release/room-bench"
work=$1
port=${PORT:-18645}
rm -rf "$work"; mkdir -p "$work/stub"
python3 "$here/tools/bench-stub.py" "$port" "$work/stub" & stub=$!
trap 'kill $stub 2>/dev/null' EXIT
sleep 1
echo "BOOT-DRY-RUN" > "$work/token"
fail=0
state() {  # prints: session=<install|-> config=<install|-> staged=<yes|no> tmp=<n>
    python3 - "$1" <<'PY'
import json, os, stat, sys
root = sys.argv[1]
def load(name):
    p = os.path.join(root, name)
    if not os.path.exists(p): return "-"
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600, f"{name} not 0600"
    return json.load(open(p))["install_id"]
tmp = len([n for n in os.listdir(root) if n.endswith(".tmp")])
print(f"session={load('room-session.json')} config={load('config.json')} staged={'yes' if os.path.exists(os.path.join(root, 'config.json.staged')) else 'no'} tmp={tmp}")
PY
}
for point in after-exchange before-staged-config after-staged-config after-session after-config at-client-release none; do
    root="$work/$point"; mkdir -p "$root"; chmod 750 "$root"
    if [ "$point" = none ]; then extra=(); else extra=(--test-abort-at "$point"); fi
    "$bench" enrol --origin "http://127.0.0.1:$port" --token-file "$work/token" --device-uid usb:0d8c:0134 --root "$root" "${extra[@]}" \
        > "$root.out" 2> "$root.err"
    code=$?
    before=$(state "$root")
    timeout 3 "$bench" serve --root "$root" > /dev/null 2> "$root.serve.err"
    after=$(state "$root")
    recovered=$(grep -o "completed an interrupted enrolment\|discarded a staged config" "$root.serve.err" | head -1)
    printf '%-22s exit %-3s  on disk: %-52s after next start: %s %s\n' "$point" "$code" "$before" "$after" "${recovered:+($recovered)}"
    if [ "$point" = none ]; then want="0"; else want="134"; fi
    if [ "$code" != "$want" ]; then echo "  FAIL: exit $code, expected $want (a refusal or a usage error is not the abort under test)"; cat "$root.err"; fail=1; fi
    grep -q "TEST HOOK aborting at $point" "$root.err" || [ "$point" = none ] || { echo "  FAIL: the hook did not fire at $point"; fail=1; }
    python3 - "$after" <<'PY' || fail=1
import sys
kv = dict(p.split("=") for p in sys.argv[1].split())
ok = kv["staged"] == "no" and kv["tmp"] == "0" and kv["session"] == kv["config"]
if not ok: print("  FAIL: invariant broken:", sys.argv[1])
sys.exit(0 if ok else 1)
PY
done
[ $fail = 0 ] && echo "INVARIANT HOLDS at every abort point" || { echo "INVARIANT BROKEN"; exit 1; }
