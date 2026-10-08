#!/bin/sh
# add-member.sh <bus-name> '<ssh public key line>'
# Registers an external poll-based bus member (GrokBot, OPD bot, any outside agent) — Fable, 8 Oct 2026.
# 1. Appends the name to members.txt (lib/tools.mjs reads it: posts to that name are stored for polling).
# 2. Appends ONE locked-down key to ~/.ssh/authorized_keys: `restrict` (no shell, no pty, no forwarding) plus a
#    forced command that runs only the bus server with ETA_BUS_AS=<bus-name> and every herdr variable unset.
#    The client cannot choose its identity, cannot become 'fable', and cannot run anything else on the Mini.
# Run on the Mini by Fable only. Never prints key material back.
set -eu
NAME=$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z')
KEY=${2:-}
DIR=/Users/vinaybhardwaj/dev/eta-bus-mcp
# Paths default to the real files; tests point these at temp files (never at the real authorized_keys).
AK=${ETA_ADDMEMBER_AK:-/Users/vinaybhardwaj/.ssh/authorized_keys}
MEMBERS=${ETA_ADDMEMBER_MEMBERS:-$DIR/members.txt}
DB=${ETA_ADDMEMBER_DB:-/Users/vinaybhardwaj/dev/_fable/bus/bus.db}

die() { echo "add-member: $*" >&2; exit 2; }

# Guest names: 'ext-' + 2..36 chars of [a-z0-9-], validated as the WHOLE string with case patterns (no line-based grep,
# so an embedded newline or quote cannot sneak past). Same rule as EXT_NAME_RE in lib/tools.mjs.
case "$NAME" in ext-*) ;; *) die "bad name: must start with ext-";; esac
case "$NAME" in *[!a-z0-9-]*) die "bad name: only lowercase letters, digits and dashes";; esac
[ "${#NAME}" -ge 6 ] && [ "${#NAME}" -le 40 ] || die "bad name: ext- plus 2-36 characters"

# exactly one line, a known key type, base64 body, optional comment; no quotes or option prefixes
[ "$(printf '%s\n' "$KEY" | wc -l | tr -d ' ')" = "1" ] || die "key must be one line"
printf '%s' "$KEY" | grep -Eq '^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._:-]{0,64})?$' || die "not a plain public key line"
KTYPE=$(printf '%s' "$KEY" | cut -d' ' -f1)
KBODY=$(printf '%s' "$KEY" | cut -d' ' -f2)
# exact match on the base64 body field (no substring matching)
if [ -f "$AK" ] && awk -v b="$KBODY" '{ for (i = 1; i <= NF; i++) if ($i == b) f = 1 } END { exit f ? 0 : 1 }' "$AK"; then
  die "this key is already in authorized_keys"
fi

if grep -Fxq -- "$NAME" "$MEMBERS" 2>/dev/null; then
  echo "add-member: $NAME already in members.txt (adding another key for it)"
else
  # new name: refuse one that already appears in bus history, so a guest cannot inherit an internal agent's mail
  SEEN=$(sqlite3 -readonly "$DB" "SELECT 1 FROM messages WHERE lower(sender)='$NAME' UNION SELECT 1 FROM receipts WHERE lower(recipient)='$NAME' LIMIT 1;") || die "cannot read bus.db to check the name"
  [ -z "$SEEN" ] || die "$NAME already appears in bus.db as a sender or recipient"
fi

cp "$AK" "$AK.bak-add-member-$(date +%Y%m%d-%H%M%S)"
printf '%s\n' "restrict,command=\"/usr/bin/env -u HERDR_PANE_ID -u HERDR_MACHINE -u HERDR_SESSION ETA_BUS_AS=$NAME /bin/sh $DIR/run.sh\" $KTYPE $KBODY eta-bus:$NAME" >> "$AK"
grep -qx "$NAME" "$MEMBERS" 2>/dev/null || printf '%s\n' "$NAME" >> "$MEMBERS"
chmod 600 "$AK"
echo "add-member: registered $NAME (key type $KTYPE). Connect: ssh -i <private key> ${ETA_ADDMEMBER_SSH_TARGET:-<user>@<host>}"
