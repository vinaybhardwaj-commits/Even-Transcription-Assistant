#!/bin/bash
# Launch wrapper for the pico pipe server (launchd: com.eta.guardian.pipe). Binds to the Mini tailnet IPv4 only, read at start.
# Refuses: no tailnet address, port 22, host key not 0600, database url file not 0600. Secrets never on argv.
set -euo pipefail
GH="${GUARDIAN_HOME:-$HOME/oc/fleet-access/guardian}"
# shellcheck disable=SC1091
. "$GH/etc/guardian.env"
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
PIPE_HOST="$("$TS" ip -4 2>/dev/null | head -n1)"
case "$PIPE_HOST" in 100.*) ;; *) echo "run-pipe: no tailnet IPv4 (got '${PIPE_HOST:+set}'); refusing to bind elsewhere" >&2; exit 2 ;; esac
[ "$PIPE_SSH_PORT" != "22" ] || { echo "run-pipe: port 22 refused" >&2; exit 2; }
KEY="$PIPE_WORKDIR/ssh_data/term_info_ed25519"
[ "$(stat -f '%Lp' "$KEY" 2>/dev/null || echo missing)" = "600" ] || { echo "run-pipe: host key must exist with mode 600" >&2; exit 2; }
[ "$(stat -f '%Lp' "$PIPE_DATABASE_URL_FILE" 2>/dev/null || echo missing)" = "600" ] || { echo "run-pipe: database url file must be mode 600" >&2; exit 2; }
DATABASE_URL="$(cat "$PIPE_DATABASE_URL_FILE")"
# pico defaults ship logs to the hosted pipe.pico.sh over ssh (PICO_PIPE_ENABLED=true); never from here.
# Permanent (V, 14 Oct): never the hosted pico.sh. Refuse to start if anything asks for it; then pin it off.
case "${PICO_PIPE_ENABLED:-false}" in false) ;; *) echo "run-pipe: PICO_PIPE_ENABLED must be false (no hosted pico.sh); refusing to start" >&2; exit 2 ;; esac
export PICO_PIPE_ENABLED=false PIPE_DOMAIN=pipe.invalid
export DATABASE_URL PIPE_HOST PIPE_SSH_PORT PIPE_PROM_PORT   # PIPE_PROM_PORT empty = prometheus listener disabled (pssh: promPort != "")
cd "$PIPE_WORKDIR"
# pico logs DATABASE_URL (password included) at start; strip it before it reaches the log files. exec keeps the pipe as the launchd child.
exec "$PIPE_BIN" > >(sed -u -E 's#(://[^:/@]+:)[^@]*@#\1REDACTED@#g') 2>&1
