#!/bin/bash
# U4 proof harness: runs deploy/room-recorder-install.sh end to end on a bare Ubuntu 26.04 with systemd as PID 1, in a
# container, so that idempotency, the deferred-enrol path, the enrolled path, the uninstall and the rollback are proven
# WITHOUT touching a real room machine.
#
# Isolation from the host's live capture, stated because this runs on the room machine itself:
#   - not --privileged: no /dev/snd in the container, and Docker masks /proc/asound, so no sound card is visible;
#   - --cgroupns=private with writable-cgroups: systemd manages only the container's own cgroup subtree;
#   - --cap-add SYS_ADMIN and AppArmor unconfined: the MINIMUM with which systemd can build the units' sandboxes
#     (namespaces for ProtectSystem, PrivateTmp, ...). Without them every unit fails at spawn with 217/USER, and the
#     installer could not be tested with the real, fully hardened units. Device access is still denied (no /dev/snd,
#     no disk nodes), and /proc/asound is still masked;
#   - the enrolled-path steps run with the container DISCONNECTED from the network, so room-bench (holding a made-up
#     session) can never reach the real Bench.
#
# usage: tools/u4/container-check.sh [BIN_DIR]    (BIN_DIR defaults to .build/release; both binaries must be built)
# shellcheck disable=SC2016,SC2034  # check expressions are single-quoted on purpose and `check` evals them later, so shellcheck cannot see them expand or read $code.
set -uo pipefail
here=$(cd "$(dirname "$0")/../.." && pwd)
bins=${1:-$here/.build/release}
name=u4check
image=eta-u4-systemd
pass=0
fail=0

ok() { printf 'ok    %s\n' "$*"; pass=$((pass + 1)); }
no() { printf 'FAIL  %s\n' "$*"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }
cx() { docker exec "$name" bash -c "$*"; }
install_run() {  # install_run LOG ARGS...
    local log=$1; shift
    docker exec "$name" /src/deploy/room-recorder-install.sh --bin-dir /opt/bins "$@" > "$log" 2>&1
}
changes() { sed -n 's/^changes this run: \([0-9]*\).*/\1/p' "$1" | tail -1; }
work=$(mktemp -d)

docker build -q -t "$image" -f "$here/tools/u4/systemd-ubuntu.Dockerfile" "$here/tools/u4" >/dev/null
docker rm -f "$name" >/dev/null 2>&1
docker run -d -t --name "$name" --cgroupns=private --cap-add SYS_ADMIN --security-opt writable-cgroups=true \
    --security-opt apparmor=unconfined \
    --tmpfs /run --tmpfs /run/lock -e container=docker -v "$here":/src:ro "$image" >/dev/null
# U4_KEEP_LOGS=DIR keeps every install log for inspection.
trap 'docker rm -f "$name" >/dev/null 2>&1; if [ -n "${U4_KEEP_LOGS:-}" ]; then mkdir -p "$U4_KEEP_LOGS" && cp "$work"/*.log "$U4_KEEP_LOGS"/; fi; rm -rf "$work"' EXIT
for _ in $(seq 1 30); do cx 'systemctl is-system-running 2>/dev/null | grep -qE "running|degraded"' && break; sleep 1; done
cx 'mkdir -p /opt/bins'
docker cp "$bins/room-recorder" "$name:/opt/bins/room-recorder"
docker cp "$bins/room-bench" "$name:/opt/bins/room-bench"
echo "container: $(cx '. /etc/os-release; echo $PRETTY_NAME'), systemd $(cx 'systemctl --version | head -1 | cut -d" " -f2'), sound cards visible: $(cx 'ls /proc/asound 2>/dev/null | wc -l')"

echo "== preflight refuses what it must"
install_run "$work/nodevice.log"; code=$?
check "no device and no --defer-device: STOP, exit 1, naming the device" '[ $code = 1 ] && grep -q "STOP: the capture device usb:0d8c:0134 is not plugged in" "$work/nodevice.log"'
check "...and it changed nothing" '! cx "id -u room-recorder" >/dev/null 2>&1 && ! cx "test -e /etc/systemd/system/room-recorder.service"'
docker exec "$name" /src/deploy/room-recorder-install.sh --token SECRET > "$work/argtoken.log" 2>&1; code=$?
check "a token as an argument is refused (exit 2)" '[ $code = 2 ] && grep -q "never accepted as an argument" "$work/argtoken.log"'
cx 'echo tok > /root/token && chmod 600 /root/token'
install_run "$work/tokennodevice.log" --defer-device --token-file /root/token; code=$?
check "a token with the device deferred: STOP before any change" '[ $code = 1 ] && grep -q "an enrol needs the capture device plugged in" "$work/tokennodevice.log"'

echo "== first install, no token, device deferred"
install_run "$work/run1.log" --defer-device; code=$?
check "run 1 exits 0" '[ $code = 0 ]'
check "run 1 made changes ($(changes "$work/run1.log"))" '[ "$(changes "$work/run1.log")" -gt 10 ]'
check "packages installed, ffmpeg at the pinned /usr/bin/ffmpeg and logged with its version" 'grep -q "ffmpeg: /usr/bin/ffmpeg (PATH resolves: /usr/bin/ffmpeg) — ffmpeg version" "$work/run1.log" && cx "grep -q \"ffmpeg version\" /var/log/room-recorder-install.log"'
check "both binaries root:root 0755" '[ "$(cx "stat -c \"%U:%G %a\" /usr/local/lib/room-recorder/room-recorder /usr/local/lib/room-recorder/room-bench" | sort -u)" = "root:root 755" ]'
check "account room-recorder, nologin, group audio" 'cx "id -nG room-recorder" | grep -qw audio && cx "getent passwd room-recorder" | grep -q nologin'
check "/var/lib/room-recorder 0750 room-recorder:room-recorder" '[ "$(cx "stat -c \"%a %U:%G\" /var/lib/room-recorder")" = "750 room-recorder:room-recorder" ]'
check "room-recorder.service running under its full hardening, waiting for the absent device" 'sleep 3; [ "$(cx "systemctl is-active room-recorder.service")" = active ] && cx "journalctl -u room-recorder.service --no-pager" | grep -q "no /var/lib/room-recorder/config.json yet"'
check "room-recorder.service enabled, pinned by --device-config with the env default" 'cx "systemctl is-enabled room-recorder.service" | grep -qx enabled && cx "systemctl cat room-recorder.service" | grep -q -- "--device-config /var/lib/room-recorder/config.json" && cx "cat /etc/room-recorder/room-recorder.env" | grep -qx "ROOM_RECORDER_DEVICE_UID=usb:0d8c:0134"'
check "room-bench.service installed but DISABLED (not enrolled), and the verification row says so" '[ "$(cx "systemctl is-enabled room-bench.service")" = disabled ] && grep -qx "  bench            room-bench.service disabled, inactive" "$work/run1.log"'
check "the deferred-enrol instruction is printed" 'grep -q "NOT ENROLLED" "$work/run1.log" && grep -q "Next: put the bootstrap token from the Bench in a file only root can read" "$work/run1.log" && grep -q -- "--token-file /root/room-token" "$work/run1.log"'
check "sleep, suspend, hibernate, hybrid-sleep masked" '[ "$(cx "systemctl is-enabled sleep.target suspend.target hibernate.target hybrid-sleep.target" | sort -u)" = masked ]'
check "default target multi-user, logind and journald drop-ins present" '[ "$(cx "systemctl get-default")" = multi-user.target ] && cx "test -f /etc/systemd/logind.conf.d/10-room-recorder.conf && test -f /etc/systemd/journald.conf.d/10-room-recorder.conf"'
check "the two units name no dependency on each other" '! cx "systemctl cat room-bench.service room-recorder.service" | grep -E "^(After|Before|Requires|Wants|BindsTo|PartOf)=" | grep -q "room-"'

echo "== idempotency"
install_run "$work/run2.log" --defer-device; code=$?
check "run 2 exits 0 and makes 0 changes" '[ $code = 0 ] && [ "$(changes "$work/run2.log")" = 0 ]'
check "run 2 prints no CHANGED line" '! grep -q "^  CHANGED" "$work/run2.log"'
cx 'touch /tmp/before-check; sleep 1'
docker exec "$name" /src/deploy/room-recorder-install.sh --bin-dir /opt/bins --defer-device --check > "$work/check.log" 2>&1; code=$?
check "--check on the installed machine: exit 0, 0 changes would be made" '[ $code = 0 ] && grep -q "check mode: 0 change(s) WOULD be made" "$work/check.log"'
check "--check wrote nothing (no file under /etc /usr/local /var/lib/room-recorder /var/log newer than before)" '[ -z "$(cx "find /etc /usr/local /var/lib/room-recorder /var/log/room-recorder-install.log -newer /tmp/before-check -type f 2>/dev/null")" ]'
install_run "$work/run3.log" --defer-device
check "run 3 still 0 changes" '[ "$(changes "$work/run3.log")" = 0 ]'

echo "== enrolled machine, network disconnected so nothing can reach the real Bench"
docker network disconnect bridge "$name"
cx 'install -o room-recorder -g room-recorder -m 0600 /dev/null /var/lib/room-recorder/room-session.json
cat > /var/lib/room-recorder/room-session.json <<J
{
  "install_id" : "install_container_check",
  "origin" : "https://www.evenscribe.app",
  "room_name" : "Container",
  "room_slug" : "container",
  "session_token" : "not-a-real-token",
  "written_at" : "2026-09-16T20:00:00Z",
  "written_by" : "container-check"
}
J
install -o room-recorder -g room-recorder -m 0600 /dev/null /var/lib/room-recorder/config.json
cat > /var/lib/room-recorder/config.json <<J
{
  "channel_locked" : false,
  "device_uid" : "usb:0d8c:0134",
  "ffmpeg_path" : "/usr/bin/ffmpeg",
  "install_id" : "install_container_check",
  "origin" : "https://www.evenscribe.app",
  "room_slug" : "container",
  "tab_id" : "app_install_container_check",
  "tape_dir" : "/var/lib/room-recorder/tape",
  "update_channel" : "stable"
}
J'
install_run "$work/enrolled1.log" --defer-device; code=$?
check "an enrolled machine (no token needed): exit 0, room-bench enabled and started" '[ $code = 0 ] && grep -q "CHANGED    enable room-bench.service" "$work/enrolled1.log" && [ "$(cx "systemctl is-enabled room-bench.service")" = enabled ]'
check "the verification block names the install" 'grep -q "enrolled, install install_container_check" "$work/enrolled1.log"'
sleep 12
check "room-bench active and NOT restart-looping while offline (NRestarts=0 after 12 s)" '[ "$(cx "systemctl is-active room-bench.service")" = active ] && [ "$(cx "systemctl show room-bench.service -p NRestarts --value")" = 0 ]'
install_run "$work/enrolled2.log" --defer-device
check "enrolled re-run: 0 changes" '[ "$(changes "$work/enrolled2.log")" = 0 ]'
check "nothing the running services created is reachable by other users (UMask 0027 capture, 0077 bench)" '[ "$(cx "systemctl show room-recorder.service -p UMask --value")" = 0027 ] && [ "$(cx "systemctl show room-bench.service -p UMask --value")" = 0077 ] && [ -z "$(cx "find /var/lib/room-recorder -perm /o=rwx")" ]'
cx 'install -o room-recorder -g room-recorder -m 0600 /dev/null /var/lib/room-recorder/retired.json; printf "{\"at\":\"2026-09-16T20:00:00Z\",\"install_id\":\"install_container_check\"}" > /var/lib/room-recorder/retired.json; systemctl restart room-bench.service'
sleep 15
check "a RETIRED install idles: active, NRestarts=0 after 15 s, no poll" '[ "$(cx "systemctl is-active room-bench.service")" = active ] && [ "$(cx "systemctl show room-bench.service -p NRestarts --value")" = 0 ] && cx "journalctl -u room-bench.service --no-pager" | grep -q "not polling"'
check "SIGTERM stops the idle process cleanly (exit 0, not restarted)" 'cx "systemctl stop room-bench.service" && [ "$(cx "systemctl show room-bench.service -p ExecMainStatus --value")" = 0 ]'
cx 'rm -f /var/lib/room-recorder/retired.json; systemctl start room-bench.service'

echo "== the restart semantics room-bench.service relies on, measured on this systemd"
cx 'systemd-run --quiet --unit u4-exit75 -p Restart=on-failure -p RestartPreventExitStatus=2 -p RestartSec=1 /bin/sh -c "exit 75"; systemd-run --quiet --unit u4-exit2 -p Restart=on-failure -p RestartPreventExitStatus=2 -p RestartSec=1 /bin/sh -c "exit 2"'
sleep 5
check "exit 75 (acked restart_engine) IS restarted under these directives" '[ "$(cx "systemctl show u4-exit75.service -p NRestarts --value")" -ge 2 ]'
check "exit 2 (usage) is NOT restarted" '[ "$(cx "systemctl show u4-exit2.service -p NRestarts --value")" = 0 ]'
cx 'systemctl stop u4-exit75.service u4-exit2.service 2>/dev/null; systemctl reset-failed 2>/dev/null' || true

echo "== rollback and uninstall"
docker network connect bridge "$name"
cx 'cp /opt/bins/room-bench /opt/bins/room-bench.orig && printf x >> /opt/bins/room-bench'
install_run "$work/upgrade.log" --defer-device
check "an upgraded room-bench is installed, the old one backed up, room-bench restarted" 'grep -q "CHANGED    /usr/local/lib/room-recorder/room-bench" "$work/upgrade.log" && grep -q "restart room-bench.service (new room-bench binary)" "$work/upgrade.log" && cx "ls /var/backups/room-recorder/*/usr/local/lib/room-recorder/room-bench" >/dev/null'
docker exec "$name" /src/deploy/room-recorder-uninstall.sh --rollback > "$work/rollback.log" 2>&1
check "--rollback puts the previous room-bench back" '[ "$(cx "sha256sum < /usr/local/lib/room-recorder/room-bench")" = "$(cx "sha256sum < /opt/bins/room-bench.orig")" ]'
cx 'mv /opt/bins/room-bench.orig /opt/bins/room-bench'
docker exec "$name" /src/deploy/room-recorder-uninstall.sh --remove > "$work/remove.log" 2>&1; code=$?
check "--remove: exit 0, units and binaries gone, tape dir and enrolment kept" '[ $code = 0 ] && ! cx "test -e /etc/systemd/system/room-recorder.service" && ! cx "test -e /usr/local/lib/room-recorder" && cx "test -f /var/lib/room-recorder/room-session.json"'
install_run "$work/reinstall.log" --defer-device; code=$?
check "reinstall after --remove: exit 0, both services enabled again, the enrolment picked up" '[ $code = 0 ] && [ "$(cx "systemctl is-enabled room-recorder.service room-bench.service" | sort -u)" = enabled ] && grep -q "enrolled, install install_container_check" "$work/reinstall.log"'
install_run "$work/reinstall2.log" --defer-device
check "and the run after it: 0 changes" '[ "$(changes "$work/reinstall2.log")" = 0 ]'
docker exec "$name" /src/deploy/room-recorder-uninstall.sh --remove --purge-state > "$work/purge-noconfirm.log" 2>&1; code=$?
check "--purge-state without the confirmation words refuses (exit 2) and deletes nothing" '[ $code = 2 ] && cx "test -f /var/lib/room-recorder/room-session.json"'

echo
echo "run 1 output (for the record):"
sed 's/^/    /' "$work/run1.log" | tail -40
echo
echo "container check: $pass passed, $fail failed"
[ "$fail" = 0 ]
