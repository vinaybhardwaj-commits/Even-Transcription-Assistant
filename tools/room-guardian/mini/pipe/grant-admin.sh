#!/bin/bash
# Give an existing pipe user the pico "admin" feature (valid to 2099). Idempotent. Admin lets that user subscribe to ANY user's topic
# with an absolute name "/<user>/<topic>" (pkg/apps/pipe/topic.go). Only the subscriber gets it; room keys stay confined to their own namespace.
# Usage: grant-admin.sh <name>
set -euo pipefail
NAME="${1:?name}"
case "$NAME" in *[!a-z0-9_-]*|"") echo "grant-admin: bad name" >&2; exit 2 ;; esac
GH="${GUARDIAN_HOME:-$HOME/oc/fleet-access/guardian}"
export PATH=/opt/homebrew/opt/postgresql@16/bin:$PATH
set -a
# shellcheck disable=SC1091
. "$GH/etc/pg.env"
set +a
psql -v ON_ERROR_STOP=1 -q -v name="$NAME" <<'SQL'
INSERT INTO feature_flags (user_id, name, expires_at)
SELECT u.id, 'admin', '2099-01-01'::timestamp FROM app_users u
WHERE u.name = :'name' AND NOT EXISTS (SELECT 1 FROM feature_flags f WHERE f.user_id = u.id AND f.name = 'admin');
SQL
echo "grant-admin: ok $NAME"
