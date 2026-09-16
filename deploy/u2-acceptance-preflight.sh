#!/bin/bash
# U2 acceptance preflight — read-only, unprivileged. Run it immediately before the acceptance run.
# It answers one question: would the run PROVE anything? Exits non-zero if any precondition is unmet.
#
# R2 is why this exists. A HUMAN seat session grants a udev uaccess ACL on /dev/snd/* — an access a real room
# machine will not have (M2.1 measured it appearing with a session and vanishing without one) — so an acceptance run
# with one present proves nothing. Two different causes, two different fixes:
#   autologin enabled   the machine logs itself in       -> turn autologin off, reboot
#   autologin off       a human logged in at the console -> reboot and let nobody touch the machine
# The R2 check reads /etc/gdm3/custom.conf and the session's Service to tell which one you are in, and names both in
# its output. Do not collapse them back into one hint: on 16 Sep 2026 the hint told an operator to set
# AutomaticLoginEnable=false in a file that already said false.
#
# CORRECTED 16 Sep 2026, and this is the important part: "nobody logged in" does NOT mean "no seat0 session" and does
# NOT mean "no seat ACL". On every machine that runs a display manager — which is every room machine — gdm's GREETER
# takes seat0 the moment the last human session ends, as its own user, carrying its own uaccess ACL. Measured here:
# ending vinay's session left session c2, user gdm-greeter uid 60579, Service=gdm-launch-environment, Class=greeter
# on seat0, and /dev/snd/pcmC1D0c reading user:gdm-greeter:rw-. The earlier form of these two checks — FAIL on ANY
# seat0 session, FAIL on ANY named ACL entry — could therefore never pass on a correctly unattended boot, and it was
# measuring the wrong thing besides: an ACL naming somebody who is not room-recorder grants room-recorder nothing,
# so it cannot mask the group-audio path the acceptance is there to prove. Both checks now discriminate HUMAN from
# system, and both say so in their output.
set -u
fail=0
ok()   { printf '  PASS  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=1; }
note() { printf '        %s\n' "$*"; }
info() { printf '  INFO  %s\n' "$*"; }
# "Is this uid a human login account?" is asked of the MACHINE'S OWN policy, not guessed. `uid >= 1000` is wrong
# here in both directions: gdm's greeter on this Yoga is a systemd DynamicUser at uid 60579 — ABOVE UID_MAX, with no
# /etc/passwd entry at all, so `id -u gdm-greeter` and `getent passwd 60579` both fail — while room-recorder is 994.
UID_MIN=$(awk '$1=="UID_MIN"{print $2}' /etc/login.defs 2>/dev/null); UID_MIN=${UID_MIN:-1000}
UID_MAX=$(awk '$1=="UID_MAX"{print $2}' /etc/login.defs 2>/dev/null); UID_MAX=${UID_MAX:-60000}
human_uid() {
    case "${1:-}" in ''|*[!0-9]*) return 1;; esac
    [ "$1" -ge "$UID_MIN" ] && [ "$1" -le "$UID_MAX" ]
}

echo "R2 — no HUMAN seat0 session (THE precondition; needs root to change, V must do it):"
# Both facts are read before anything is judged, and both are printed whatever the verdict, so the operator can see
# which case they are in rather than being told. A seat0 session is not by itself the hazard; a human one is.
autologin=$(sed -n 's/^[[:space:]]*AutomaticLoginEnable[[:space:]]*=[[:space:]]*\([^[:space:]#]*\).*/\1/p' \
            /etc/gdm3/custom.conf 2>/dev/null | tail -1)
case "${autologin,,}" in true|1|yes) autologin_on=1;; *) autologin_on=0;; esac
note "/etc/gdm3/custom.conf AutomaticLoginEnable=${autologin:-unset (gdm default: off)}"
human_svcs=""
seen_seat0=0
for sess in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do
    [ "$(loginctl show-session "$sess" -p Seat --value 2>/dev/null)" = seat0 ] || continue
    seen_seat0=1
    svc=$(loginctl show-session "$sess" -p Service --value 2>/dev/null)
    cls=$(loginctl show-session "$sess" -p Class   --value 2>/dev/null)
    who=$(loginctl show-session "$sess" -p Name    --value 2>/dev/null)
    uid=$(loginctl show-session "$sess" -p User    --value 2>/dev/null)
    desc="session $sess (user ${who:-?} uid ${uid:-?}, Service=${svc:-?}, Class=${cls:-?})"
    if [ "$cls" = greeter ]; then
        ok "seat0 $desc is the display manager's GREETER, not a person"
        note "This is the EXPECTED state of an unattended room machine and is NOT a failure. gdm takes seat0 at"
        note "the login screen on every machine that runs a display manager, so \"nobody logged in\" never means"
        note "\"no seat0 session\". Do NOT change this back to a FAIL on any seat0 session: such a check can never"
        note "pass on a correctly unattended boot, which is how it stood until 16 Sep 2026."
    elif human_uid "$uid" || [ "$svc" = gdm-password ] || [ "$svc" = gdm-autologin ]; then
        bad "seat0 $desc is a HUMAN session — the run would be invalid"
        human_svcs="$human_svcs ${svc:-unknown}"
    else
        bad "seat0 $desc is neither the greeter nor a human login — unrecognised, look at it before accepting"
    fi
done
[ "$seen_seat0" = 1 ] || ok "no seat0 session at all (no display manager running)"
if [ -n "$human_svcs" ]; then
    hsv=$(printf '%s\n' $human_svcs | sort -u | tr '\n' ' '); hsv=${hsv% }
    if [ "$autologin_on" = 1 ]; then
        note "cause: autologin is ENABLED — the machine logs itself in at boot, and will again after any reboot."
        note "fix (root): set AutomaticLoginEnable=false in /etc/gdm3/custom.conf, then sudo systemctl reboot -i"
    elif [ "$hsv" = gdm-password ]; then
        note "cause: autologin is already OFF and the session came from gdm-password — somebody typed a password at"
        note "       the laptop. Editing custom.conf would change nothing; it already says what that fix asks for."
        note "fix: sudo systemctl reboot -i, then leave the machine at the login screen with nobody touching it, and"
        note "     run this preflight again over SSH. The acceptance run needs a boot that nobody logs into."
    else
        note "cause: autologin is OFF, so this is not gdm-autologin; the session's Service is $hsv."
        note "fix: end that session, then sudo systemctl reboot -i and let nobody log in at the seat before the run."
    fi
fi

echo "M2.1 — no HUMAN user may hold an ACL on the pinned PCM node:"
node=""; card=""
for f in /proc/asound/card*/usbid; do
    [ -r "$f" ] && [ "$(cat "$f" 2>/dev/null)" = "0d8c:0134" ] || continue
    n=${f%/usbid}; n=${n##*/card}; card=$n; node="/dev/snd/pcmC${n}D0c"
done
if [ -z "$node" ]; then bad "the pinned TM20 (0d8c:0134) is not present at all"; else
    note "$node is $(stat -c '%U:%G %a' "$node")"
    note "An ACL naming some OTHER user grants room-recorder nothing: the account reaches this node through group"
    note "audio (root:audio 0660) or not at all. Only an entry naming a HUMAN is a hazard, and only because it is"
    note "the fingerprint of a person logged in at the seat — the access a real room machine will not have. The"
    note "greeter's entry is the normal unattended state and can mask nothing."
    # -n, so the decision is made on the NUMERIC uid. The greeter has no passwd entry to resolve (DynamicUser),
    # and a name that nothing can look up must not be allowed to decide whether an acceptance run is valid.
    acl_uids=$(getfacl -pn "$node" 2>/dev/null | sed -n 's/^user:\([0-9][0-9]*\):.*/\1/p')
    if [ -z "$acl_uids" ]; then ok "$node carries no named user: ACL entry at all"; else
        for uid in $acl_uids; do
            who=$(id -nu "$uid" 2>/dev/null) || who="no passwd entry — a systemd DynamicUser, e.g. the gdm greeter"
            if human_uid "$uid"; then
                bad "$node carries an ACL for uid $uid ($who) — a HUMAN account (uid range $UID_MIN-$UID_MAX)"
                note "somebody is logged in at the seat; the run would be invalid"
            else
                ok "$node carries an ACL for uid $uid ($who) — outside this machine's human uid range"
                note "$UID_MIN-$UID_MAX, so not a person. It grants room-recorder nothing and masks nothing."
            fi
        done
    fi
fi

echo "M2.2 — is anything holding the capture node right now (INFO, never a precondition failure):"
if [ -n "$card" ]; then
    for st in /proc/asound/card$card/pcm0c/sub*/status; do
        [ -r "$st" ] || continue
        info "$st: $(tr '\n' ' ' < "$st" | sed 's/  */ /g; s/ *$//')"
    done
fi
if [ -n "$node" ]; then
    held=$(fuser "$node" 2>/dev/null | tr -s ' ' | sed 's/^ *//; s/ *$//')
    [ -n "$held" ] && info "fuser: held by PID(s) $held" || info "fuser: nothing THIS USER can see is holding $node"
fi
info "fuser here is unprivileged and sees only this user's processes — measured 16 Sep 2026, /proc/<pid>/fd of a"
info "gdm-greeter process is not readable as vinay. The substream status line above is the one that does not depend"
info "on who is asking: it is world-readable and reports the node's own state."
stack=$(ps -eo user:32,comm --no-headers 2>/dev/null \
        | awk '$2=="pipewire"||$2=="wireplumber"||$2=="pipewire-pulse"{print $1"/"$2}' | sort | tr '\n' ' ')
info "PipeWire processes running: ${stack:-none}"
info "The greeter runs a FULL PipeWire stack as its own user, so M2.2's contention condition is present on the login"
info "screen of EVERY room machine, not only once somebody logs in. This is INFO and not a FAIL because S3 handles"
info "it: the bounded wait rides out PipeWire's measured 5.0 s hold and exit 4 names the busy case. What it does not"
info "change is M2.2's rule — we win only by opening first."

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
