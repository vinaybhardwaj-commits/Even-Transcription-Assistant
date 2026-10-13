#!/usr/bin/env bash
# Launch wrapper for the pipe server. launchd runs this. Reads config, refuses a loose host key, exports DATABASE_URL from a 0600 file (never argv).
set -euo pipefail
ENV_FILE="${GUARDIAN_ENV:-$HOME/oc/fleet-access/guardian/guardian.env}"
[ -f "$ENV_FILE" ] || { echo "run-pipe: missing $ENV_FILE" >&2; exit 2; }
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${PIPE_HOST:?}" "${PIPE_SSH_PORT:?}" "${PIPE_WORKDIR:?}" "${PIPE_BIN:?}" "${PIPE_DATABASE_URL_FILE:?}"
case "$PIPE_HOST" in 127.0.0.1|localhost) ;; *"<"*) echo "run-pipe: PIPE_HOST is still a placeholder" >&2; exit 2 ;; esac
[ "$PIPE_SSH_PORT" != "22" ] || { echo "run-pipe: port 22 refused" >&2; exit 2; }
KEY="$PIPE_WORKDIR/ssh_data/term_info_ed25519"   # hard-coded relative path inside pico (ssh.go)
mode="$(stat -f '%Lp' "$KEY" 2>/dev/null || echo missing)"
[ "$mode" = "600" ] || { echo "run-pipe: host key must exist with mode 600 (got $mode)" >&2; exit 2; }
fmode="$(stat -f '%Lp' "$PIPE_DATABASE_URL_FILE" 2>/dev/null || echo missing)"
[ "$fmode" = "600" ] || { echo "run-pipe: database url file must be mode 600 (got $fmode)" >&2; exit 2; }
DATABASE_URL="$(cat "$PIPE_DATABASE_URL_FILE")"
export DATABASE_URL PIPE_HOST PIPE_SSH_PORT
export PIPE_PROM_PORT="${PIPE_PROM_PORT:-9222}"
cd "$PIPE_WORKDIR"
exec "$PIPE_BIN"
