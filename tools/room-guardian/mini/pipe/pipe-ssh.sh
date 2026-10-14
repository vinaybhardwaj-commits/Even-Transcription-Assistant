#!/bin/bash
# ssh to the local pipe as a given key.  Usage: pipe-ssh.sh <keyfile> <pipe command...>   e.g. pipe-ssh.sh keys/subscriber sub kiosk/x/health
# Host address read from tailscale; host key pinned from pipe/ssh_data/*.pub via etc/known_hosts.
set -euo pipefail
GH="${GUARDIAN_HOME:-$HOME/oc/fleet-access/guardian}"
# shellcheck disable=SC1091
. "$GH/etc/guardian.env"
KEY="$1"; shift
H="$(/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4 | head -n1)"
printf '[%s]:%s %s\n' "$H" "$PIPE_SSH_PORT" "$(cut -d' ' -f1,2 "$PIPE_WORKDIR/ssh_data/term_info_ed25519.pub")" > "$GH/etc/known_hosts"
exec ssh -p "$PIPE_SSH_PORT" -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o UserKnownHostsFile="$GH/etc/known_hosts" -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -o ServerAliveInterval=15 "$H" "$@"
