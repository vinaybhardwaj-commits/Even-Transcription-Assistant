#!/bin/bash
# Samples the pipe-ssh process's TCP sockets every 30 s until the file $1 contains DONE (or 40 min). Classifies each socket:
#   listen_tailnet       LISTEN on <tailnet address>:<pipe port>             (allowed)
#   pg_local             ESTABLISHED loopback -> loopback:<postgres port>   (allowed)
#   inbound_clients      ESTABLISHED on the pipe's own local port            (a client dialled in; not outbound)
#   OTHER                anything else, including any outbound connection    (must stay 0)
# Addresses and ports are read at run time (tailscale, lo0, etc/guardian.env, etc/pg.env); none is written in this file or in the output.
set -uo pipefail
GH="${GUARDIAN_HOME:-$HOME/oc/fleet-access/guardian}"
DONEFILE="${1:?file that will contain DONE}"
# shellcheck disable=SC1091
. "$GH/etc/guardian.env"
# shellcheck disable=SC1091
PGPORT="$(. "$GH/etc/pg.env"; echo "$PGPORT")"
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
for _ in $(seq 1 80); do
  TIP="$("$TS" ip -4 2>/dev/null | head -n1)"
  LO="$(ifconfig lo0 | awk '/inet /{print $2; exit}')"
  pid="$(pgrep -f 'guardian/bin/pipe-ssh' | head -n1)"
  if [ -z "$pid" ]; then echo "$(date +%H:%M:%S) pipe-ssh NOT RUNNING"; else
    lsof -nP -a -p "$pid" -iTCP 2>/dev/null | tail -n +2 | awk -v t="$(date +%H:%M:%S)" -v tip="$TIP" -v lo="$LO" -v pp="$PIPE_SSH_PORT" -v pg="$PGPORT" '
      { n=$9; st=$10 }
      n == tip ":" pp && st=="(LISTEN)" { l++; next }
      index(n, lo ":") == 1 && n ~ ("->" lo ":" pg "$") { c++; next }
      index(n, tip ":" pp "->") == 1 { inb++; next }
      { o++ }
      END { printf "%s listen_tailnet=%d pg_local=%d inbound_clients=%d OTHER=%d\n", t, l, c, inb, o }'
  fi
  grep -q DONE "$DONEFILE" 2>/dev/null && break
  sleep 30
done
