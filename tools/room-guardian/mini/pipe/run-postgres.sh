#!/bin/bash
# Postgres for the pipe server. Loopback only; the port is in pgdata/postgresql.conf (listen_addresses, port). launchd runs this.
set -euo pipefail
GH="$HOME/oc/fleet-access/guardian"
export LC_ALL=en_US.UTF-8
exec /opt/homebrew/opt/postgresql@16/bin/postgres -D "$GH/pgdata"
