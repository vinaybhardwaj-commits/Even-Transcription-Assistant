#!/bin/bash
# U4 — the way back. Crude on purpose: it removes what the installer put in place, and it will not destroy a tape or an
# enrolment unless told to in words.
#
#   sudo deploy/room-recorder-uninstall.sh --rollback
#       Put back the binaries, units and settings files the LAST install run replaced (from /var/backups/room-recorder/
#       <newest>/), daemon-reload, and restart what was running. For a bad upgrade.
#   sudo deploy/room-recorder-uninstall.sh --remove [--restore-machine-settings]
#       Stop and disable both services; remove the units, the env file and the binaries. KEEPS /var/lib/room-recorder
#       (the tape, the enrolment, the spool) and the account. --restore-machine-settings also unmasks the sleep targets
#       and removes the logind and journald drop-ins. The default target and gdm autologin are left as they are and
#       printed, because turning a graphical login back on is a decision about the machine, not about this software.
#   sudo deploy/room-recorder-uninstall.sh --remove --purge-state --yes-delete-the-tape-and-enrolment
#       As --remove, then delete /var/lib/room-recorder and the account. The tape is gone after this. The server still
#       holds the install; retire it in the Bench.
set -euo pipefail

readonly BINDIR=/usr/local/lib/room-recorder
readonly SHAREDIR=/usr/local/share/room-recorder
readonly STATEDIR=/var/lib/room-recorder
readonly ETCDIR=/etc/room-recorder
readonly UNITDIR=/etc/systemd/system
readonly BACKUPROOT=/var/backups/room-recorder

mode=""
restore_machine=0
purge=0
confirmed=0
while [ $# -gt 0 ]; do
    case "$1" in
        --rollback) mode=rollback; shift ;;
        --remove) mode=remove; shift ;;
        --restore-machine-settings) restore_machine=1; shift ;;
        --purge-state) purge=1; shift ;;
        --yes-delete-the-tape-and-enrolment) confirmed=1; shift ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done
[ -n "$mode" ] || { sed -n '2,20p' "$0" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "must be run as root" >&2; exit 1; }
say() { printf '  %s\n' "$*"; }

if [ "$mode" = rollback ]; then
    latest=$(find "$BACKUPROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -1)
    [ -n "$latest" ] || { echo "no backup under $BACKUPROOT: nothing to roll back to" >&2; exit 1; }
    echo "rolling back to the files replaced by the install run of $(basename "$latest")"
    while IFS= read -r -d '' f; do
        dest=${f#"$latest"}
        # Copy beside, then rename: a running binary cannot be written in place (ETXTBSY), but it can be replaced.
        cp -a "$f" "$dest.rollback-$$"
        mv -f "$dest.rollback-$$" "$dest"
        say "restored $dest"
    done < <(find "$latest" -type f -print0)
    systemctl daemon-reload
    for u in room-recorder.service room-bench.service; do
        if systemctl is-active --quiet "$u"; then
            systemctl restart "$u"
            say "restarted $u"
        fi
    done
    echo "rolled back. The backup is left in place: $latest"
    exit 0
fi

if [ "$purge" = 1 ] && [ "$confirmed" = 0 ]; then
    echo "--purge-state deletes the tape and the enrolment for good. Add --yes-delete-the-tape-and-enrolment to mean it." >&2
    exit 2
fi

echo "removing the room recorder"
for u in room-bench.service room-recorder.service; do
    if systemctl list-unit-files "$u" --no-legend 2>/dev/null | grep -q "$u"; then
        systemctl disable --now "$u" >/dev/null 2>&1 || true
        say "stopped and disabled $u"
    fi
    if [ -f "$UNITDIR/$u" ]; then rm -f "$UNITDIR/$u"; say "removed $UNITDIR/$u"; fi
done
systemctl daemon-reload
rm -rf "$ETCDIR" "$BINDIR" "$SHAREDIR"
say "removed $ETCDIR $BINDIR $SHAREDIR"

if [ "$restore_machine" = 1 ]; then
    systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null
    say "unmasked the sleep targets"
    rm -f /etc/systemd/logind.conf.d/10-room-recorder.conf /etc/systemd/journald.conf.d/10-room-recorder.conf
    systemctl restart systemd-journald
    say "removed the logind and journald drop-ins (logind takes effect at the next reboot)"
    say "left as they are: default target $(systemctl get-default); /etc/gdm3/custom.conf autologin setting"
fi

if [ "$purge" = 1 ]; then
    rm -rf "$STATEDIR"
    say "deleted $STATEDIR (tape, enrolment, spool)"
    if id -u room-recorder >/dev/null 2>&1; then userdel room-recorder; say "deleted user room-recorder"; fi
    say "the server still holds this install: retire it in the Bench"
else
    say "kept $STATEDIR (tape, enrolment, spool) and the room-recorder account; reinstalling picks them up"
fi
