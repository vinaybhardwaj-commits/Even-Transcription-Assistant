#!/bin/bash
# Usage: install.sh <ssh-target>     e.g. install.sh ehrc-audiometry@100.109.231.107
# Builds a per-host CRX (machine_id = the target's LocalHostName, ingest URL and token baked into the
# package, same signing key so the extension id never changes) and force-installs it into macOS Chrome
# on the target through managed policy. Idempotent: re-running bumps the version and updates in place.
# sudo on the target asks for the admin password on this terminal (ssh -t). The password and the token
# are never on a command line, in a log, or in git.
set -euo pipefail
TARGET="${1:?usage: install.sh <ssh-target>}"
KIT="$(cd "$(dirname "$0")" && pwd)"
REPO="${ETA_PRESENCE_REPO:-$HOME/dev/eta-pulse-presence}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/oc/eta-presence-ingest/.ingest-token}"
INGEST_URL="${INGEST_URL:-https://www.evenscribe.app/api/presence}"
[ -r "$TOKEN_FILE" ] && [ -f "$REPO/kit/build-kit.sh" ] || { echo "token file or repo missing" >&2; exit 1; }
SSH_OPTS=(-o ConnectTimeout=15)

MACHINE="$(ssh "${SSH_OPTS[@]}" "$TARGET" 'scutil --get LocalHostName')"
LOCAL="$(mktemp -d)"; umask 077
trap 'rm -rf "$LOCAL"' EXIT
# The per-host config holds the token. It is written mode 600 from the token file; the token never
# appears in an argument list.
python3 - "$LOCAL/host.json" "$TOKEN_FILE" "$INGEST_URL" "$MACHINE" <<'PY'
import json, sys
out, tokfile, url, machine = sys.argv[1:5]
json.dump({"ingest_url": url, "token": open(tokfile).read().strip(), "machine_id": machine, "room": ""}, open(out, "w"))
PY
KIT_OUT="$KIT" HOST_CONFIG="$LOCAL/host.json" bash "$REPO/kit/build-kit.sh"
HOSTDIR="$KIT/hosts/$MACHINE"
ID="$(cat "$HOSTDIR/extension-id.txt")"; CRX="$(cat "$HOSTDIR/crx-name.txt")"
[ "$ID" = "$(cat "$KIT/extension-id.txt")" ] || { echo "extension id mismatch: STOP" >&2; exit 1; }

REMOTE="$(ssh "${SSH_OPTS[@]}" "$TARGET" 'mktemp -d /tmp/eta-presence.XXXXXX')"
case "$REMOTE" in /tmp/eta-presence.*) ;; *) echo "unexpected remote dir" >&2; exit 1;; esac
scp "${SSH_OPTS[@]}" -q "$HOSTDIR/$CRX" "$HOSTDIR/update.xml" "$KIT/remote/apply.sh" "$TARGET:$REMOTE/"
# -t: sudo can prompt for the password on this terminal.
ssh -t "${SSH_OPTS[@]}" "$TARGET" "sudo bash '$REMOTE/apply.sh' '$REMOTE' '$ID' '$CRX'; rc=\$?; rm -rf '$REMOTE'; exit \$rc"
echo "installed on $TARGET (extension $ID, machine_id $MACHINE, package $CRX)"
echo "restart Chrome there to pick it up: ssh $TARGET 'killall \"Google Chrome\"; open -a \"Google Chrome\"'"
