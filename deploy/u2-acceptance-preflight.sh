#!/bin/bash
# U2 acceptance preflight — read-only, unprivileged. Run it immediately before the acceptance run.
# It answers one question: would the run PROVE anything? Exits non-zero if any precondition is unmet.
#
# R2 is why this exists. This Yoga runs gdm-autologin, so "nobody logs in" is not true of it as configured, and an
# acceptance run in that state proves nothing: the seat ACL on /dev/snd/* grants an access a real room machine will
# not have (M2.1 measured it appearing with a session and vanishing without one).
set -u
fail=0
ok()   { printf '  PASS  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=1; }
note() { printf '        %s\n' "$*"; }

echo "R2 — autologin off / no seat session (THE precondition; needs root to change, V must do it):"
sessions=$(loginctl list-sessions --no-legend 2>/dev/null | grep -c seat0)
if [ "$sessions" = 0 ]; then ok "no seat0 session"; else
    bad "$sessions seat0 session(s) present — the run would be invalid"
    loginctl list-sessions --no-legend 2>/dev/null | sed 's/^/        /'
    note "fix (root): set AutomaticLoginEnable=false in /etc/gdm3/custom.conf, then reboot"
fi

echo "M2.1 — the seat ACL must be ABSENT from the pinned PCM node:"
node=""
for f in /proc/asound/card*/usbid; do
    [ -r "$f" ] && [ "$(cat "$f" 2>/dev/null)" = "0d8c:0134" ] || continue
    n=${f%/usbid}; n=${n##*/card}; node="/dev/snd/pcmC${n}D0c"
done
if [ -z "$node" ]; then bad "the pinned TM20 (0d8c:0134) is not present at all"; else
    acl=$(getfacl -p "$node" 2>/dev/null | grep -c '^user:[^:]')
    if [ "$acl" = 0 ]; then ok "$node has no user: ACL entry beyond the owner"
    else bad "$node still carries a seat ACL:"; getfacl -p "$node" 2>/dev/null | grep '^user:[^:]' | sed 's/^/        /'; fi
    note "$node is $(stat -c '%U:%G %a' "$node")"
fi

echo "S1 — the account, its shell, and group audio:"
if id -u room-recorder >/dev/null 2>&1; then
    ok "room-recorder exists (uid $(id -u room-recorder))"
    sh=$(getent passwd room-recorder | cut -d: -f7)
    case "$sh" in */nologin|*/false) ok "shell is $sh";; *) bad "shell is $sh, expected nologin";; esac
    id -nG room-recorder | tr ' ' '\n' | grep -qx audio && ok "in group audio" || bad "NOT in group audio"
else bad "account room-recorder does not exist — run deploy/room-recorder-install.sh as root"; fi

echo "S1/S7 — binary and tape directory outside /home, tape not world-readable:"
for p in /usr/local/lib/room-recorder/room-recorder /var/lib/room-recorder; do
    if [ -e "$p" ]; then
        case "$p" in /home/*) bad "$p is under /home";; *) ok "$p is outside /home ($(stat -c '%U:%G %a' "$p"))";; esac
    else bad "$p does not exist"; fi
done
if [ -d /var/lib/room-recorder ]; then
    m=$(stat -c %a /var/lib/room-recorder)
    [ "${m: -1}" = 0 ] && ok "tape dir mode $m is not world-readable" || bad "tape dir mode $m IS world-readable"
fi

echo "S5 — machine must not sleep, lid ignored:"
for t in sleep.target suspend.target hibernate.target hybrid-sleep.target; do
    [ "$(systemctl is-enabled "$t" 2>/dev/null)" = masked ] && ok "$t masked" || bad "$t is NOT masked"
done
lid=$(grep -rhi '^HandleLidSwitch=' /etc/systemd/logind.conf /etc/systemd/logind.conf.d/ 2>/dev/null | tail -1)
[ "${lid,,}" = "handlelidswitch=ignore" ] && ok "lid switch ignored" || bad "lid switch not ignored (${lid:-unset})"

echo "S2 — the unit is a system unit and is installed:"
if [ -f /etc/systemd/system/room-recorder.service ]; then
    ok "/etc/systemd/system/room-recorder.service present (system unit)"
    [ -e "$HOME/.config/systemd/user/room-recorder.service" ] && bad "a USER unit of the same name also exists" \
        || ok "no competing user unit"
else bad "unit not installed"; fi

echo "S8 — tzdata for the IST midnight rollover:"
[ -f /usr/share/zoneinfo/Asia/Kolkata ] && ok "Asia/Kolkata zone data present" || bad "Asia/Kolkata zone data MISSING"

echo
[ "$fail" = 0 ] && echo "PREFLIGHT PASSES — the acceptance run would be valid." \
                || echo "PREFLIGHT FAILS — an acceptance run now would prove nothing. Fix the FAIL lines first."
exit "$fail"
