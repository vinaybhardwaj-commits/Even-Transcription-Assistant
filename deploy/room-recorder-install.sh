#!/bin/bash
# U4 — the install line. One command turns a bare Ubuntu machine into a recording, Bench-linked room.
#
#   sudo deploy/room-recorder-install.sh [--token-file PATH] [options]
#
# Read deploy/README.md first; it is the operator document. This header is for whoever maintains the script.
#
# WHAT IT DOES, IN ORDER (each step prints UNCHANGED, CHANGED or, with --check, WOULD CHANGE):
#   1  preflight      Ubuntu version, architecture, systemd, the built binaries, the pinned USB device (or --defer-device),
#                     the token file, and the network — only when this run needs it (packages to fetch, or an enrol).
#                     Any failure STOPS with the cause and the fix, before anything is changed.
#   2  packages       libasound2, libcurl4, tzdata, ffmpeg, alsa-utils, ca-certificates. ffmpeg must resolve to the
#                     absolute path room-bench pins (/usr/bin/ffmpeg); the path and version go to the install log.
#   3  account/dirs   system user room-recorder (nologin, group audio); /var/lib/room-recorder 0750; secrets 0600;
#                     nothing under it readable by others.
#   4  binaries       room-recorder and room-bench to /usr/local/lib/room-recorder, root:root 0755. The replaced ones
#                     are backed up first (see room-recorder-uninstall.sh --rollback).
#   5  units          /etc/room-recorder/room-recorder.env (the install-time device identity, no secrets),
#                     room-recorder.service and room-bench.service.
#   6  machine        multi-user.target default, graphical autologin off, the four sleep targets masked, logind lid and
#                     idle actions ignored, the journal capped.
#   7  capture gain   applied and stored with `alsactl store` so it survives a reboot.
#   8  enrol          with --token-file: enrol, verify both state files, enable room-bench.service.
#                     without: everything else is installed, room-bench stays disabled, the next step is printed.
#   9  services       room-recorder.service enabled and running; room-bench.service enabled and running once enrolled.
#  10  verification   one block an operator reads at a glance.
#
# IDEMPOTENT: every step compares what is there with what should be there and changes only the difference. A second run
# on an installed machine prints "changes this run: 0".
#
# NEVER, BY DESIGN:
#   - takes a token on the command line (it is readable by every local user from /proc); --token-file only, and the
#     token reaches room-bench on stdin, never argv;
#   - replaces an existing enrolment without --re-enrol (a token is single-use and a re-enrol retires the old install);
#   - restarts a RUNNING capture on its own. A capture restart is a gap in the tape; when a new binary or unit needs one,
#     the script says so and leaves the timing to the operator, or does it with --restart-capture;
#   - makes room-bench and the capture depend on each other (spec V8);
#   - resolves ffmpeg from PATH.
set -euo pipefail

readonly ACCOUNT=room-recorder
readonly BINDIR=/usr/local/lib/room-recorder
readonly SHAREDIR=/usr/local/share/room-recorder
readonly STATEDIR=/var/lib/room-recorder
readonly ETCDIR=/etc/room-recorder
readonly ENVFILE=$ETCDIR/room-recorder.env
readonly GAINFILE=$ETCDIR/capture-gain.applied
readonly UNITDIR=/etc/systemd/system
readonly LOGFILE=/var/log/room-recorder-install.log
readonly BACKUPROOT=/var/backups/room-recorder
# Must equal Pinned.ffmpegPath in Sources/BenchCore/RoomStore.swift. room-bench never looks on PATH.
readonly FFMPEG=/usr/bin/ffmpeg
readonly SUPPORTED_UBUNTU="24.04 26.04"
readonly DEFAULT_ORIGIN=https://www.evenscribe.app
readonly DEFAULT_DEVICE_UID=usb:0d8c:0134
# The capture gain OT 3 went live with on 16 Sep 2026: TONOR TM20 "Mic" capture 21 of 0-62 = 34% = +2.33 dB. Applied on
# the FIRST install only; see step 7 for why a re-run leaves the device's current value alone.
readonly DEFAULT_CAPTURE_GAIN=2.33dB

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/.." && pwd)

bin_dir=$repo/.build/release
token_file=""
origin=$DEFAULT_ORIGIN
device_uid=$DEFAULT_DEVICE_UID
defer_device=0
capture_gain=""
re_enrol=0
check=0
restart_capture=0

usage() {
    cat <<USAGE
usage: sudo $0 [--token-file PATH] [options]

  --token-file PATH        bootstrap token, one line, in a file. Never pass a token as an argument.
                           Omit to install without enrolling; room-bench.service then stays disabled.
  --origin URL             Bench origin (default $DEFAULT_ORIGIN; room-bench allows only www.evenscribe.app
                           and evenscribe.app)
  --device-uid usb:V:P     the capture device's USB identity (default $DEFAULT_DEVICE_UID, the TONOR TM20)
  --defer-device           install although the device is not plugged in; capture waits for it, gain and enrol
                           are skipped
  --capture-gain VALUE     capture gain in amixer's terms: dB as amixer prints it (e.g. 2.33dB), a percentage
                           (34%), or raw steps (21). Default on a first install: $DEFAULT_CAPTURE_GAIN. Given explicitly,
                           it is applied on every run. "skip" leaves the gain alone.
  --re-enrol               replace an existing enrolment with the token in --token-file (retires the old install)
  --restart-capture        restart a RUNNING room-recorder.service if a new binary or unit needs it (a short gap)
  --bin-dir DIR            directory holding the built room-recorder and room-bench (default $repo/.build/release)
  --check                  change nothing; print what a real run would change
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --token-file) token_file=${2:?--token-file needs a path}; shift 2 ;;
        --origin) origin=${2:?--origin needs a URL}; shift 2 ;;
        --device-uid) device_uid=${2:?--device-uid needs usb:VVVV:PPPP}; shift 2 ;;
        --defer-device) defer_device=1; shift ;;
        --capture-gain) capture_gain=${2:?--capture-gain needs a value}; shift 2 ;;
        --re-enrol) re_enrol=1; shift ;;
        --restart-capture) restart_capture=1; shift ;;
        --bin-dir) bin_dir=${2:?--bin-dir needs a directory}; shift 2 ;;
        --check) check=1; shift ;;
        -h|--help) usage; exit 0 ;;
        --token|--token=*) echo "STOP: a token is never accepted as an argument. Put it in a file and use --token-file." >&2; exit 2 ;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

changes=0
reboot_reasons=()
capture_restart_reasons=()
bench_restart_reasons=()
stamp=$(date +%Y%m%d-%H%M%S)
backup_dir=$BACKUPROOT/$stamp

if [ "$check" = 0 ]; then
    [ "$(id -u)" = 0 ] || { echo "STOP: must be run as root: sudo $0 $*" >&2; exit 1; }
    install -d -m 0755 "$(dirname "$LOGFILE")"
    touch "$LOGFILE" && chmod 0640 "$LOGFILE"
    exec > >(tee -a "$LOGFILE") 2>&1
else
    [ "$(id -u)" = 0 ] || { echo "STOP: --check reads root-only state; run it as root too: sudo $0 --check" >&2; exit 1; }
fi

section() { printf '\n== %s\n' "$*"; }
same() { printf '  UNCHANGED  %s\n' "$*"; }
info() { printf '             %s\n' "$*"; }
change() {
    changes=$((changes + 1))
    if [ "$check" = 1 ]; then printf '  WOULD      %s\n' "$*"; else printf '  CHANGED    %s\n' "$*"; fi
}
stop() {
    printf '\nSTOP: %s\n' "$1" >&2
    shift
    for line in "$@"; do printf '      %s\n' "$line" >&2; done
    exit 1
}
# `apply` runs its arguments only on a real run.
apply() { if [ "$check" = 0 ]; then "$@"; fi; }

backup() {  # backup PATH — keep the file a change is about to replace
    [ -e "$1" ] || return 0
    [ "$check" = 0 ] || return 0
    install -d -m 0700 "$backup_dir$(dirname "$1")"
    cp -a "$1" "$backup_dir$1"
}

# put_file SOURCE DEST MODE OWNER:GROUP — install when content, mode or owner differ. Returns 0 if it changed.
put_file() {
    local src=$1 dest=$2 mode=$3 owner=$4
    if [ -f "$dest" ] && cmp -s "$src" "$dest" && [ "$(stat -c '%a %U:%G' "$dest")" = "$mode $owner" ]; then
        same "$dest"
        return 1
    fi
    change "$dest ($mode $owner)"
    backup "$dest"
    apply install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$src" "$dest"
    return 0
}

# put_text DEST MODE OWNER:GROUP <<< CONTENT
put_text() {
    local dest=$1 mode=$2 owner=$3 tmp
    tmp=$(mktemp)
    cat > "$tmp"
    local rc=0
    put_file "$tmp" "$dest" "$mode" "$owner" || rc=$?
    rm -f "$tmp"
    return "$rc"
}

echo "room-recorder install (U4) — $(date -Is) — $( [ "$check" = 1 ] && echo 'CHECK MODE: nothing will be changed' || echo 'applying')"

# ─── 1. PREFLIGHT ─────────────────────────────────────────────────────────────────────────────────────────────────────
section "1 preflight"

[ -r /etc/os-release ] || stop "cannot read /etc/os-release, so this is not a supported Ubuntu." "Install on Ubuntu $SUPPORTED_UBUNTU."
# shellcheck source=/dev/null  # /etc/os-release is the machine's own file, read at run time, not a script to lint.
os_id=$(. /etc/os-release && echo "${ID:-}")
# shellcheck source=/dev/null
os_version=$(. /etc/os-release && echo "${VERSION_ID:-}")
case " $SUPPORTED_UBUNTU " in
    *" $os_version "*) [ "$os_id" = ubuntu ] || stop "this is $os_id $os_version, not Ubuntu." "Install on Ubuntu $SUPPORTED_UBUNTU." ;;
    *) stop "Ubuntu $os_version ($os_id) is not a supported release." "Supported: Ubuntu $SUPPORTED_UBUNTU. The binaries are built against 24.04's C library." ;;
esac
same "OS: Ubuntu $os_version"

arch=$(uname -m)
[ "$arch" = x86_64 ] || stop "this machine is $arch." "The room recorder binaries are built for x86_64 only."
same "architecture: $arch"

if [ ! -d /run/systemd/system ] || ! command -v systemctl >/dev/null 2>&1; then
    stop "systemd is not running as the init system." "Both services are systemd units; install on a standard Ubuntu boot."
fi
same "systemd: $(systemctl --version | head -1)"

for b in room-recorder room-bench; do
    [ -x "$bin_dir/$b" ] || stop "no executable $bin_dir/$b." \
        "Build it:  docker run --rm -v \"\$PWD\":/w -w /w eta-u1-build swift build -c release --static-swift-stdlib" \
        "or point --bin-dir at the directory that holds both binaries."
    # e_machine at offset 18: 0x3e = x86-64.
    [ "$(od -An -tx1 -j18 -N1 "$bin_dir/$b" | tr -d ' ')" = 3e ] || stop "$bin_dir/$b is not an x86-64 executable."
done
same "binaries: $bin_dir/room-recorder, $bin_dir/room-bench"

case "$device_uid" in
    usb:[0-9a-f][0-9a-f][0-9a-f][0-9a-f]:[0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) stop "--device-uid $device_uid is not usb:VVVV:PPPP in lower-case hex." "The TONOR TM20 is usb:0d8c:0134." ;;
esac
usbid=${device_uid#usb:}
card=""
for f in /proc/asound/card*/usbid; do
    [ -r "$f" ] || continue
    if [ "$(cat "$f")" = "$usbid" ]; then card=${f%/usbid}; card=${card##*/card}; break; fi
done
if [ -n "$card" ]; then
    same "device $device_uid present: ALSA card $card ($(cat "/proc/asound/card$card/id" 2>/dev/null))"
elif [ "$defer_device" = 1 ]; then
    info "device $device_uid NOT present — deferred (--defer-device): capture will wait for it; gain and enrol are skipped"
else
    stop "the capture device $device_uid is not plugged in (no /proc/asound/card*/usbid reads $usbid)." \
        "Plug the microphone in and run this again, or pass --defer-device to install without it."
fi

enrolled=0
[ -f "$STATEDIR/room-session.json" ] && [ -f "$STATEDIR/config.json" ] && enrolled=1
if [ -n "$token_file" ]; then
    [ -r "$token_file" ] || stop "cannot read the token file $token_file."
    [ "$(grep -c . "$token_file")" = 1 ] || stop "$token_file must hold exactly one non-empty line: the bootstrap token."
    [ -n "$card" ] || stop "an enrol needs the capture device plugged in, and $device_uid is not." "Plug it in and run again."
    if [ "$(stat -c %a "$token_file" | cut -c3)" != 0 ]; then
        info "WARNING: $token_file is readable by other users; delete it once this run has finished"
    fi
    if [ "$enrolled" = 1 ] && [ "$re_enrol" = 0 ]; then
        info "this machine is already enrolled; the token will NOT be used (it stays valid). Pass --re-enrol to replace the enrolment."
    fi
fi

pkg_name() {  # the package that exists on this release: pkg_name libasound2t64 libasound2
    local p
    for p in "$@"; do
        if apt-cache show "$p" >/dev/null 2>&1; then echo "$p"; return; fi
    done
    echo "$1"
}
installed() { [ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null)" = "install ok installed" ]; }
# A bare machine may have no package lists yet, and then no package name can be checked. Fetching them is also the
# plainest test that the archive is reachable.
lists_fetched=0
if ! apt-cache show tzdata >/dev/null 2>&1; then
    if [ "$check" = 0 ]; then
        lists_fetched=1
        apt-get update -qq >/dev/null 2>&1 || stop "the package archive cannot be reached (apt-get update failed)." \
            "Check the network and /etc/apt/sources.list*, then run this again."
        same "network: package archive reachable (package lists fetched)"
    else
        info "no package lists on this machine yet; package names below are the Ubuntu 24.04+ ones"
    fi
fi
packages=("$(pkg_name libasound2t64 libasound2)" "$(pkg_name libcurl4t64 libcurl4)" tzdata ffmpeg alsa-utils ca-certificates)
missing=()
for p in "${packages[@]}"; do installed "$p" || missing+=("$p"); done

needs_enrol=0
if [ -n "$token_file" ] && { [ "$enrolled" = 0 ] || [ "$re_enrol" = 1 ]; }; then needs_enrol=1; fi
reach() {  # reach HOST PORT — a TCP connect, no curl needed on a bare machine
    timeout 8 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null
}
if [ ${#missing[@]} -gt 0 ]; then
    if [ "$check" = 0 ] && [ "$lists_fetched" = 0 ]; then
        apt-get update -qq >/dev/null 2>&1 || stop "the package archive cannot be reached (apt-get update failed)." \
            "Check the network and /etc/apt/sources.list*, then run this again."
    fi
    same "network: package archive reachable (packages to install: ${missing[*]})"
fi
if [ "$needs_enrol" = 1 ]; then
    host=${origin#https://}; host=${host%%/*}; host=${host%%:*}
    getent hosts "$host" >/dev/null 2>&1 || stop "$host does not resolve." "Check DNS on this machine, then run again."
    reach "$host" 443 || stop "$host:443 cannot be reached." "Check the network or proxy, then run again. Nothing has been enrolled."
    same "network: $host:443 reachable"
fi
[ ${#missing[@]} -gt 0 ] || [ "$needs_enrol" = 1 ] || info "network: not needed for this run"

# ─── 2. PACKAGES ─────────────────────────────────────────────────────────────────────────────────────────────────────
section "2 packages"
if [ ${#missing[@]} -gt 0 ]; then
    change "apt-get install ${missing[*]}"
    apply env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
else
    same "installed: ${packages[*]}"
fi
if [ "$check" = 0 ] || [ ${#missing[@]} -eq 0 ]; then
    resolved=$(command -v ffmpeg || true)
    [ -x "$FFMPEG" ] || stop "ffmpeg is not at $FFMPEG, the absolute path room-bench pins." \
        "PATH gives: ${resolved:-nothing}. room-bench never falls back to PATH; install Ubuntu's ffmpeg package."
    same "ffmpeg: $FFMPEG (PATH resolves: ${resolved:-nothing}) — $("$FFMPEG" -version | head -1)"
fi
if [ "$check" = 0 ]; then
    for b in room-recorder room-bench; do
        # With no arguments both binaries print their usage and exit 2. What this proves is that the dynamic loader
        # found every shared library (libasound, libcurl); a missing one is "error while loading shared libraries".
        out=$("$bin_dir/$b" 2>&1 || true)
        if grep -q "error while loading shared libraries" <<< "$out" || ! grep -q "usage" <<< "$out"; then
            stop "$bin_dir/$b does not run on this machine: ${out%%$'\n'*}" \
                "A missing shared library means a package above did not install."
        fi
    done
    same "both binaries load their shared libraries"
fi

# ─── 3. ACCOUNT AND STATE DIRECTORY ──────────────────────────────────────────────────────────────────────────────────
section "3 account and state directory"
if id -u "$ACCOUNT" >/dev/null 2>&1; then
    same "user $ACCOUNT (uid $(id -u "$ACCOUNT"))"
else
    change "create system user $ACCOUNT (nologin, no home)"
    apply useradd --system --no-create-home --home-dir "$STATEDIR" --shell /usr/sbin/nologin --comment "Room recorder" "$ACCOUNT"
fi
if id -nG "$ACCOUNT" 2>/dev/null | tr ' ' '\n' | grep -qx audio; then
    same "$ACCOUNT in group audio"
else
    change "add $ACCOUNT to group audio (the only non-seat path to /dev/snd)"
    apply usermod -aG audio "$ACCOUNT"
fi
if [ -d "$STATEDIR" ] && [ "$(stat -c '%a %U:%G' "$STATEDIR")" = "750 $ACCOUNT:$ACCOUNT" ]; then
    same "$STATEDIR 0750 $ACCOUNT:$ACCOUNT"
else
    change "$STATEDIR 0750 $ACCOUNT:$ACCOUNT"
    apply install -d -m 0750 -o "$ACCOUNT" -g "$ACCOUNT" "$STATEDIR"
fi
for secret in room-session.json config.json config.json.staged status.json cursor.json capture-device.json retired.json; do
    f=$STATEDIR/$secret
    [ -f "$f" ] || continue
    if [ "$(stat -c '%a %U' "$f")" = "600 $ACCOUNT" ]; then
        same "$f 0600"
    else
        change "$f to 0600 $ACCOUNT (was $(stat -c '%a %U' "$f"))"
        apply chown "$ACCOUNT:$ACCOUNT" "$f"
        apply chmod 0600 "$f"
    fi
done
if [ -d "$STATEDIR" ]; then
    readable=$(find "$STATEDIR" -xdev -perm /o=rwx 2>/dev/null | head -50 || true)
    if [ -z "$readable" ]; then
        same "nothing under $STATEDIR is open to other users"
    else
        change "remove other-user access under $STATEDIR ($(wc -l <<< "$readable") path(s), e.g. $(head -1 <<< "$readable"))"
        apply find "$STATEDIR" -xdev -perm /o=rwx -exec chmod o-rwx {} +
    fi
fi

# ─── 4. BINARIES ─────────────────────────────────────────────────────────────────────────────────────────────────────
section "4 binaries"
if [ -d "$BINDIR" ] && [ "$(stat -c '%a %U:%G' "$BINDIR")" = "755 root:root" ]; then same "$BINDIR 0755 root:root"; else
    change "$BINDIR 0755 root:root"; apply install -d -m 0755 -o root -g root "$BINDIR"; fi
if put_file "$bin_dir/room-recorder" "$BINDIR/room-recorder" 755 root:root; then capture_restart_reasons+=("new room-recorder binary"); fi
if put_file "$bin_dir/room-bench" "$BINDIR/room-bench" 755 root:root; then bench_restart_reasons+=("new room-bench binary"); fi
put_file "$here/README.md" "$SHAREDIR/README.md" 644 root:root || true

# ─── 5. UNITS ────────────────────────────────────────────────────────────────────────────────────────────────────────
section "5 units"
if [ -d "$ETCDIR" ]; then same "$ETCDIR"; else change "$ETCDIR 0755"; apply install -d -m 0755 -o root -g root "$ETCDIR"; fi
if put_text "$ENVFILE" 644 root:root <<ENV
# Written by deploy/room-recorder-install.sh. No secrets. Read by room-recorder.service.
# The capture pins this identity only until the room is enrolled; after that config.json's device_uid rules, and the
# Bench can change it (set_audio_input). Re-running the installer with --device-uid updates this default.
ROOM_RECORDER_DEVICE_UID=$device_uid
ENV
then capture_restart_reasons+=("new device identity default"); fi
units_changed=0
if put_file "$here/room-recorder.service" "$UNITDIR/room-recorder.service" 644 root:root; then units_changed=1; capture_restart_reasons+=("new room-recorder.service"); fi
if put_file "$here/room-bench.service" "$UNITDIR/room-bench.service" 644 root:root; then units_changed=1; bench_restart_reasons+=("new room-bench.service"); fi
if [ "$units_changed" = 1 ]; then change "systemctl daemon-reload"; apply systemctl daemon-reload; fi

# ─── 6. MACHINE SETTINGS ─────────────────────────────────────────────────────────────────────────────────────────────
section "6 machine settings"
if [ "$(systemctl get-default)" = multi-user.target ]; then same "default target multi-user.target"; else
    change "default target multi-user.target (was $(systemctl get-default))"
    apply systemctl set-default multi-user.target >/dev/null 2>&1
    reboot_reasons+=("default target changed")
fi

gdm=/etc/gdm3/custom.conf
if [ -f "$gdm" ]; then
    current=$(sed -n 's/^[[:space:]]*AutomaticLoginEnable[[:space:]]*=[[:space:]]*\([^[:space:]#]*\).*/\1/p' "$gdm" | tail -1)
    if [ "${current,,}" = false ]; then same "graphical autologin off ($gdm)"; else
        change "graphical autologin off in $gdm (was ${current:-unset})"
        backup "$gdm"
        if [ -n "$current" ]; then
            apply sed -i 's/^\([[:space:]]*AutomaticLoginEnable[[:space:]]*=\).*/\1false/' "$gdm"
        elif grep -q '^\[daemon\]' "$gdm"; then
            apply sed -i 's/^\[daemon\]$/[daemon]\nAutomaticLoginEnable=false/' "$gdm"
        else
            if [ "$check" = 0 ]; then printf '\n[daemon]\nAutomaticLoginEnable=false\n' >> "$gdm"; fi
        fi
        reboot_reasons+=("autologin turned off")
    fi
else
    same "no gdm3 on this machine: no graphical autologin to turn off"
fi
for other in /etc/lightdm/lightdm.conf /etc/sddm.conf; do
    if [ -f "$other" ] && grep -qiE '^[[:space:]]*(autologin-user|User)[[:space:]]*=[[:space:]]*[^[:space:]]' "$other"; then
        info "WARNING: $other configures an autologin; this script handles gdm3 only. Turn it off by hand."
    fi
done

for t in sleep.target suspend.target hibernate.target hybrid-sleep.target; do
    if [ "$(systemctl is-enabled "$t" 2>/dev/null || true)" = masked ]; then same "$t masked"; else
        change "mask $t"; apply systemctl mask "$t" >/dev/null 2>&1
    fi
done

if put_text /etc/systemd/logind.conf.d/10-room-recorder.conf 644 root:root <<'CONF'
# Written by deploy/room-recorder-install.sh (U2 S5): a room machine must not stop recording because somebody shut the
# lid, pressed a key or walked away.
[Login]
HandleLidSwitch=ignore
HandleLidSwitchDocked=ignore
HandleLidSwitchExternalPower=ignore
HandleSuspendKey=ignore
HandleHibernateKey=ignore
IdleAction=ignore
CONF
then reboot_reasons+=("logind settings changed (restarting logind can end sessions, so it is left to the reboot)"); fi

if put_text /etc/systemd/journald.conf.d/10-room-recorder.conf 644 root:root <<'CONF'
# Written by deploy/room-recorder-install.sh (U2 S6): bound the journal so a long-running room cannot fill the disk.
[Journal]
Storage=persistent
SystemMaxUse=512M
SystemKeepFree=1G
SystemMaxFileSize=64M
MaxRetentionSec=1month
CONF
then change "restart systemd-journald to apply the cap"; apply systemctl restart systemd-journald; fi

# ─── 7. CAPTURE GAIN ─────────────────────────────────────────────────────────────────────────────────────────────────
# The gain is a ROOM setting the Bench may change at runtime (set_audio_input -> input_volume). So:
#   - the default is applied on the FIRST install only (recorded in capture-gain.applied);
#   - --capture-gain VALUE is applied on every run it is given;
#   - otherwise a re-run leaves the device's current value alone, which may be one the Bench chose.
# Whatever the device holds is then persisted with `alsactl store` when it differs from what is stored, so it survives
# a reboot (alsa-restore reads /var/lib/alsa/asound.state at boot). A value the Bench sets later is NOT stored until this
# script runs again — room-bench has no root and cannot write /var/lib/alsa.
section "7 capture gain"
capture_control() {  # the card's capture-volume simple control: Mic when there is one, else the first
    amixer -c "$1" scontents 2>/dev/null | awk -v q="'" '
        /^Simple mixer control/ { split($0, a, q); name = a[2] }
        /Capabilities:.*cvolume/ { found[++n] = name; if (name == "Mic") mic = 1 }
        END { if (mic) print "Mic"; else if (n) print found[1] }'
}
gain_reading() { amixer -c "$1" sget "$2" 2>/dev/null | grep -E 'Capture [0-9]+ \[' | head -1 | sed 's/^[[:space:]]*//'; }
if [ -z "$card" ]; then
    info "skipped: device deferred"
elif [ "$capture_gain" = skip ]; then
    info "skipped: --capture-gain skip"
else
    control=$(capture_control "$card")
    if [ -z "$control" ]; then
        info "card $card has no capture volume control; nothing to set"
    else
        target=$capture_gain
        [ -n "$target" ] || [ -f "$GAINFILE" ] || target=$DEFAULT_CAPTURE_GAIN
        reading=$(gain_reading "$card" "$control")
        gain_changed=0
        if [ -z "$target" ]; then
            same "$control on card $card left as the device holds it: $reading (the Bench may have set it; --capture-gain changes it)"
        else
            # amixer prints "Capture 21 [34%] [2.33dB] [on]": a target matches as raw steps, as [34%] or as [2.33dB].
            if grep -qF "[$target]" <<< "$reading" || grep -qE "Capture $target \[" <<< "$reading"; then
                same "$control on card $card at $target: $reading"
            else
                change "$control on card $card to $target (now: $reading)"
                apply amixer -q -c "$card" sset "$control" "$target" cap
                gain_changed=1
            fi
            put_text "$GAINFILE" 644 root:root <<GAIN || true
# Written by deploy/room-recorder-install.sh: the capture gain this installer last applied. While this file exists a
# re-run leaves the device's gain alone unless --capture-gain is given, because the Bench may have changed it since.
device=$device_uid control=$control value=$target
GAIN
        fi
        card_id=$(cat "/proc/asound/card$card/id")
        card_state() { sed -n "/^state\.${card_id}[[:space:]]/,/^}/p" "$1"; }
        fresh=$(mktemp)
        alsactl -f "$fresh" store "$card" 2>/dev/null || true
        if [ "$gain_changed" = 0 ] && [ -f /var/lib/alsa/asound.state ] && [ -s "$fresh" ] \
           && diff -q <(card_state "$fresh") <(card_state /var/lib/alsa/asound.state) >/dev/null; then
            same "card $card ($card_id) state already stored in /var/lib/alsa/asound.state"
        else
            change "alsactl store: persist card $card ($card_id) across reboots"
            apply alsactl store
        fi
        rm -f "$fresh"
    fi
fi

# ─── 8. ENROL ────────────────────────────────────────────────────────────────────────────────────────────────────────
section "8 enrol"
state_install_id() {  # the install_id a state file names, or nothing
    [ -f "$1" ] || return 0
    sed -n 's/^[[:space:]]*"install_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1
}
verify_state() {
    local s c
    for f in room-session.json config.json; do
        [ -f "$STATEDIR/$f" ] || { echo "missing $STATEDIR/$f"; return 1; }
        [ "$(stat -c '%a %U' "$STATEDIR/$f")" = "600 $ACCOUNT" ] || { echo "$STATEDIR/$f is $(stat -c '%a %U' "$STATEDIR/$f")"; return 1; }
        if command -v python3 >/dev/null 2>&1; then
            python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$STATEDIR/$f" 2>/dev/null || { echo "$STATEDIR/$f does not parse"; return 1; }
        fi
    done
    s=$(state_install_id "$STATEDIR/room-session.json"); c=$(state_install_id "$STATEDIR/config.json")
    [ -n "$s" ] && [ "$s" = "$c" ] || { echo "room-session.json names '$s' but config.json names '$c'"; return 1; }
    echo "$s"
}
if [ "$needs_enrol" = 1 ]; then
    # A re-enrol keeps the device the room records from now, which the Bench may have changed since install.
    enrol_uid=$(sed -n 's/^[[:space:]]*"device_uid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATEDIR/config.json" 2>/dev/null | head -1)
    enrol_uid=${enrol_uid:-$device_uid}
    change "enrol with $origin as $enrol_uid (token from $token_file, passed on stdin)"
    if [ "$check" = 0 ]; then
        if ! runuser -u "$ACCOUNT" -- "$BINDIR/room-bench" enrol --origin "$origin" --device-uid "$enrol_uid" --token-file - < "$token_file"; then
            stop "the enrol did not complete. room-bench's own message is above." \
                 "If it says the token is invalid: the token is spent or expired — mint a fresh one in the Bench." \
                 "If it says ENROLLED ON THE SERVER BUT NOT SAVED HERE: mint a fresh token and run with --re-enrol." \
                 "Everything else is installed; re-running this script with a new token is safe."
        fi
        id_now=$(verify_state) || stop "the enrol reported success but the state files are not right: $id_now"
        enrolled=1
        bench_restart_reasons+=("new enrolment")
        info "enrolled as install $id_now; state files present, 0600 $ACCOUNT, parse, and agree"
    fi
elif [ "$enrolled" = 1 ]; then
    if id_now=$(verify_state); then same "enrolled as install $id_now"; else
        stop "this machine holds enrolment state that is not usable: $id_now" \
             "room-bench repairs an interrupted enrol by itself on start; if this persists, re-enrol with a fresh token and --re-enrol."
    fi
else
    info "not enrolled, and no --token-file: room-bench.service stays disabled"
fi

# ─── 9. SERVICES ─────────────────────────────────────────────────────────────────────────────────────────────────────
section "9 services"
# Capture first and unconditionally: it records whether or not the room is enrolled or online (V8).
if [ "$(systemctl is-enabled room-recorder.service 2>/dev/null || true)" = enabled ]; then same "room-recorder.service enabled"; else
    change "enable room-recorder.service"; apply systemctl enable room-recorder.service >/dev/null 2>&1; fi
if systemctl is-active --quiet room-recorder.service; then
    if [ ${#capture_restart_reasons[@]} -gt 0 ]; then
        if [ "$restart_capture" = 1 ]; then
            change "restart room-recorder.service (${capture_restart_reasons[*]}) — a gap of a few seconds in the tape"
            apply systemctl restart --no-block room-recorder.service
        else
            info "room-recorder.service is RUNNING an older install (${capture_restart_reasons[*]})."
            info "It was NOT restarted: a restart is a gap in the tape. When the room is idle:"
            info "    sudo systemctl restart room-recorder.service      (or re-run with --restart-capture)"
        fi
    else
        same "room-recorder.service running"
    fi
else
    # --no-block: a capture that cannot start (no device yet, say) must never abort the install; step 10 reports it.
    change "start room-recorder.service"; apply systemctl start --no-block room-recorder.service
fi

if [ "$enrolled" = 1 ]; then
    if [ "$(systemctl is-enabled room-bench.service 2>/dev/null || true)" = enabled ]; then same "room-bench.service enabled"; else
        change "enable room-bench.service"; apply systemctl enable room-bench.service >/dev/null 2>&1; fi
    if systemctl is-active --quiet room-bench.service; then
        if [ ${#bench_restart_reasons[@]} -gt 0 ]; then
            # Safe at any time: a stop closes pieces without ending the session, and capture never notices.
            change "restart room-bench.service (${bench_restart_reasons[*]})"; apply systemctl restart --no-block room-bench.service
        else
            same "room-bench.service running"
        fi
    else
        change "start room-bench.service"; apply systemctl start --no-block room-bench.service
    fi
else
    if [ "$(systemctl is-enabled room-bench.service 2>/dev/null || true)" = enabled ]; then
        change "disable room-bench.service (not enrolled)"; apply systemctl disable --now room-bench.service >/dev/null 2>&1
    else
        same "room-bench.service disabled (not enrolled)"
    fi
fi

# ─── 10. VERIFICATION ────────────────────────────────────────────────────────────────────────────────────────────────
row() { printf '  %-16s %s\n' "$1" "$2"; }
unit_line() {
    local u=$1 enabled
    # is-enabled prints the state AND exits non-zero for "disabled": only an empty answer means no unit file.
    enabled=$(systemctl is-enabled "$u" 2>/dev/null) || true
    printf '%s, %s%s' "${enabled:-not-installed}" "$(systemctl is-active "$u" 2>/dev/null || true)" \
        "$(systemctl show "$u" -p ActiveEnterTimestamp --value 2>/dev/null | sed 's/^./ since &/')"
}
section "10 verification"
[ "$check" = 1 ] || sleep 3
row "capture" "room-recorder.service $(unit_line room-recorder.service)"
row "bench" "room-bench.service $(unit_line room-bench.service)"
if [ -n "$card" ]; then
    status=$(cat /proc/asound/card"$card"/pcm0c/sub0/status 2>/dev/null | head -1)
    owner=$(sed -n 's/^owner_pid[[:space:]]*:[[:space:]]*//p' /proc/asound/card"$card"/pcm0c/sub0/status 2>/dev/null)
    row "PCM" "card $card ($device_uid): ${status:-unknown}${owner:+, owner pid $owner}"
    ctl=$(capture_control "$card")
    row "gain" "${ctl:-no capture control}${ctl:+: $(gain_reading "$card" "$ctl")} (stored: /var/lib/alsa/asound.state)"
else
    row "PCM" "device $device_uid not present (deferred)"
fi
idx=$STATEDIR/tape/tape.idx
if [ -f "$idx" ]; then
    a=$(stat -c %s "$idx"); sleep 2; b=$(stat -c %s "$idx")
    row "tape" "$STATEDIR/tape ($(numfmt --to=iec "$(stat -c %s "$STATEDIR/tape/tape.pcm" 2>/dev/null || echo 0)") PCM), $([ "$b" -gt "$a" ] && echo advancing || echo 'NOT advancing in the last 2 s')"
else
    row "tape" "$STATEDIR/tape — no tape yet"
fi
row "ffmpeg" "$FFMPEG — $("$FFMPEG" -version 2>/dev/null | head -1 || echo MISSING)"
if [ "$enrolled" = 1 ] && id_now=$(verify_state 2>/dev/null); then
    row "enrol" "enrolled, install $id_now, origin $(sed -n 's/^[[:space:]]*"origin"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATEDIR/config.json" | head -1)"
    [ -f "$STATEDIR/retired.json" ] && row "" "RETIRED by the server: this install idles. Re-enrol with a fresh token and --re-enrol."
else
    row "enrol" "NOT ENROLLED"
    row "" "Next: put the bootstrap token from the Bench in a file only root can read, then run:"
    row "" "  sudo $0 --token-file /root/room-token"
    row "" "  sudo shred -u /root/room-token"
fi
row "machine" "default $(systemctl get-default); sleep targets $(systemctl is-enabled sleep.target 2>/dev/null || true); journal capped"
if [ ${#reboot_reasons[@]} -gt 0 ]; then
    row "reboot" "NEEDED ($(printf '%s; ' "${reboot_reasons[@]}" | sed 's/; $//')). Use: sudo systemctl reboot -i"
fi
echo
if [ "$check" = 1 ]; then
    echo "check mode: $changes change(s) WOULD be made; nothing was changed"
else
    echo "changes this run: $changes   (log: $LOGFILE)"
    [ -d "$backup_dir" ] && echo "files this run replaced are kept under $backup_dir (deploy/room-recorder-uninstall.sh --rollback restores them)"
    true
fi
