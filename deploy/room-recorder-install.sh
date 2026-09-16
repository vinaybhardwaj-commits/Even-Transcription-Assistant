#!/bin/bash
# U2 install — the root half. Everything here needs root and therefore needs V; nothing in it is run by the agent.
# Against S1, S2, S5, S6, S7 of ETA-ROOM-RECORDER-UBUNTU-U2-SPEC-16-SEP-2026-v0.1.
#
#   sudo deploy/room-recorder-install.sh /path/to/built/room-recorder
#
# Idempotent: safe to re-run. It prints every change it makes and makes no change it did not print.
set -euo pipefail

ACCOUNT=room-recorder
BINDIR=/usr/local/lib/room-recorder
TAPEDIR=/var/lib/room-recorder
UNIT=/etc/systemd/system/room-recorder.service
SRC=${1:-}

[ "$(id -u)" = 0 ] || { echo "must be root" >&2; exit 1; }
[ -n "$SRC" ] && [ -x "$SRC" ] || { echo "usage: $0 /path/to/built/room-recorder (an executable)" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)

say() { printf '  %s\n' "$*"; }

# --- S1: the account ------------------------------------------------------------------------------------------
# A system account (--system: uid below 1000, no ageing, no password), a nologin shell, and NO home directory of its
# own — its only writable place is the tape directory, which systemd's StateDirectory= creates and owns.
# Group `audio` is the ONLY non-seat path to /dev/snd/pcmC1D0c (root:audio 0660): M2.1 measured the udev uaccess ACL
# `user:vinay:rw-` appearing with a seat session and vanishing without one. Never loosen /dev/snd instead.
echo "S1 account:"
if id -u "$ACCOUNT" >/dev/null 2>&1; then
    say "user $ACCOUNT exists, leaving it alone"
else
    useradd --system --no-create-home --home-dir "$TAPEDIR" \
            --shell /usr/sbin/nologin --comment "Room recorder (U2)" "$ACCOUNT"
    say "created system user $ACCOUNT (nologin, no home)"
fi
if id -nG "$ACCOUNT" | tr ' ' '\n' | grep -qx audio; then
    say "already in group audio"
else
    usermod -aG audio "$ACCOUNT"
    say "added $ACCOUNT to group audio"
fi
say "uid=$(id -u "$ACCOUNT")  groups=$(id -nG "$ACCOUNT")  shell=$(getent passwd "$ACCOUNT" | cut -d: -f7)"

# --- S1/M2.1: the binary lives OUTSIDE /home ------------------------------------------------------------------
# /home/vinay is mode 750, so a system account cannot traverse it — M2.1's probe died at exec with
# "Permission denied", exit 126, before reaching ALSA. root-owned, world-executable, not writable by the account:
# the service must not be able to rewrite its own binary.
echo "S1 binary:"
install -d -o root -g root -m 0755 "$BINDIR"
install -o root -g root -m 0755 "$SRC" "$BINDIR/room-recorder"
say "installed $BINDIR/room-recorder ($(stat -c '%U:%G %a' "$BINDIR/room-recorder"), $(stat -c %s "$BINDIR/room-recorder") bytes)"
case "$BINDIR" in /home/*) echo "REFUSING: binary path is under /home" >&2; exit 1;; esac

# --- S7: the tape directory ------------------------------------------------------------------------------------
# Outside /home/vinay, owned by the account, NOT world-readable (0750). The unit's StateDirectory= would create this
# anyway; it is created here too so that the permissions are auditable before the first start.
echo "S7 tape directory:"
install -d -o "$ACCOUNT" -g "$ACCOUNT" -m 0750 "$TAPEDIR"
say "$TAPEDIR is $(stat -c '%U:%G %a' "$TAPEDIR")"
case "$TAPEDIR" in /home/*) echo "REFUSING: tape path is under /home" >&2; exit 1;; esac

# --- S2: the unit ----------------------------------------------------------------------------------------------
echo "S2 unit:"
install -o root -g root -m 0644 "$here/room-recorder.service" "$UNIT"
systemctl daemon-reload
say "installed $UNIT (system unit, not a user unit)"

# --- S5: the machine must not sleep ----------------------------------------------------------------------------
# Masking the four sleep targets is what actually prevents sleep; the unit cannot do it for itself (see the comment
# in room-recorder.service where the systemd-inhibit no-op is explained). Lid switch ignored on all three paths —
# plain, docked, and on external power — because a room laptop's lid gets closed.
echo "S5 sleep:"
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null
say "masked sleep.target suspend.target hibernate.target hybrid-sleep.target"
install -d -m 0755 /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/10-room-recorder.conf <<'CONF'
# U2 S5: a room machine must not stop recording because somebody shut the lid or walked away.
[Login]
HandleLidSwitch=ignore
HandleLidSwitchDocked=ignore
HandleLidSwitchExternalPower=ignore
HandleSuspendKey=ignore
HandleHibernateKey=ignore
IdleAction=ignore
CONF
say "wrote /etc/systemd/logind.conf.d/10-room-recorder.conf (lid ignored, idle action none)"
say "NOTE: logind picks this up on restart; a reboot is the honest way to apply it before an acceptance run."

# --- S6: bound the log volume ----------------------------------------------------------------------------------
# The unit rate-limits its own messages; this bounds what the journal as a whole may consume, so a long-running room
# cannot fill the disk no matter who is logging. The unit's own content rule — lifecycle, device identity, errors
# and counts, never sample values — is enforced in the recorder, not here.
echo "S6 journal bound:"
install -d -m 0755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/10-room-recorder.conf <<'CONF'
# U2 S6: bound the journal so a long-running room cannot fill the disk.
[Journal]
Storage=persistent
SystemMaxUse=512M
SystemKeepFree=1G
SystemMaxFileSize=64M
MaxRetentionSec=1month
CONF
systemctl restart systemd-journald
say "journal capped at 512M / 1 month"

echo
echo "Installed. NOT enabled and NOT started — S3's bounded wait is not implemented in the binary yet."
echo "When it is:  systemctl enable --now room-recorder.service"
