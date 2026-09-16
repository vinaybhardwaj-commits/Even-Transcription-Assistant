#!/bin/bash
# U2 acceptance preflight — read-only, unprivileged. Run it immediately before the acceptance run.
# It answers one question: would the run PROVE anything? Exits non-zero if any precondition is unmet.
#
# R2 is why this exists. A seat0 session grants a seat ACL on /dev/snd/* — an access a real room machine will not
# have (M2.1 measured it appearing with a session and vanishing without one) — so an acceptance run with one present
# proves nothing. There are two different ways to end up with that session, and they need different fixes:
#   autologin enabled   the machine logs itself in       -> turn autologin off, reboot
#   autologin off       a human logged in at the console -> reboot and let nobody touch the machine
# The R2 check below reads /etc/gdm3/custom.conf and the session's Service to tell which one you are in, and names
# both in its output. Do not collapse them back into one hint: on 16 Sep 2026 the hint told an operator to set
# AutomaticLoginEnable=false in a file that already said false.
set -u
fail=0
ok()   { printf '  PASS  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=1; }
note() { printf '        %s\n' "$*"; }

echo "R2 — autologin off / no seat session (THE precondition; needs root to change, V must do it):"
# Both facts are read before anything is judged, and both are printed whatever the verdict, so the operator can see
# which of the two causes they are in rather than being told.
autologin=$(sed -n 's/^[[:space:]]*AutomaticLoginEnable[[:space:]]*=[[:space:]]*\([^[:space:]#]*\).*/\1/p' \
            /etc/gdm3/custom.conf 2>/dev/null | tail -1)
case "${autologin,,}" in true|1|yes) autologin_on=1;; *) autologin_on=0;; esac
seat0=""
for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do
    [ "$(loginctl show-session "$s" -p Seat --value 2>/dev/null)" = seat0 ] && seat0="$seat0 $s"
done
note "/etc/gdm3/custom.conf AutomaticLoginEnable=${autologin:-unset (gdm default: off)}"
if [ -z "$seat0" ]; then ok "no seat0 session"; else
    svcs=""
    for s in $seat0; do
        svc=$(loginctl show-session "$s" -p Service --value 2>/dev/null)
        bad "seat0 session $s is present (user $(loginctl show-session "$s" -p Name --value 2>/dev/null), Service=${svc:-unknown}) — the run would be invalid"
        svcs="$svcs $svc"
    done
    svcs=$(printf '%s\n' $svcs | sort -u | tr '\n' ' '); svcs=${svcs% }
    if [ "$autologin_on" = 1 ]; then
        note "cause: autologin is ENABLED — the machine logs itself in at boot, and will again after any reboot."
        note "fix (root): set AutomaticLoginEnable=false in /etc/gdm3/custom.conf, then sudo systemctl reboot -i"
    elif [ "$svcs" = gdm-password ]; then
        note "cause: autologin is already OFF and the session came from gdm-password — somebody typed a password at"
        note "       the laptop. Editing custom.conf would change nothing; it already says what that fix asks for."
        note "fix: sudo systemctl reboot -i, then leave the machine at the login screen with nobody touching it, and"
        note "     run this preflight again over SSH. The acceptance run needs a boot that nobody logs into."
    else
        note "cause: autologin is OFF, so this is not gdm-autologin; the session's Service is $svcs."
        note "fix: end that session, then sudo systemctl reboot -i and let nobody log in at the seat before the run."
    fi
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
