#!/bin/bash
# Apply the pico migrations the pipe server touches, from the pinned source tree. Idempotent. Credentials from etc/pg.env (0600), never argv.
set -euo pipefail
GH="$HOME/oc/fleet-access/guardian"
export PATH=/opt/homebrew/opt/postgresql@16/bin:$PATH
set -a
# shellcheck disable=SC1091
. "$GH/etc/pg.env"
set +a
M="$GH/src/pico/sql/migrations"
q() { psql -v ON_ERROR_STOP=1 -q "$@"; }
q -f "$M/20220310_init.sql"
have="$(psql -Atc "select 1 from information_schema.columns where table_name='public_keys' and column_name='name'")"
[ "$have" = "1" ] || q -f "$M/20240311_add_public_key_name.sql"
q -f "$M/20220811_add_feature.sql"
have="$(psql -Atc "select 1 from information_schema.columns where table_name='feature_flags' and column_name='expires_at'")"
[ "$have" = "1" ] || q -f "$M/20240120_add_payment_history.sql"
q -f "$M/20251217_add_access_logs_table.sql"
q -f "$M/20251226_add_pipe_monitoring.sql"
echo "init-schema: ok"
