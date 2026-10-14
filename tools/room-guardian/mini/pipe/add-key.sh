#!/bin/bash
# Authorise one ssh-ed25519 public key on the pipe server. Idempotent: a second run with the same args changes nothing.
# Usage: add-key.sh <name> <pubkey-file>      name = room slug, "subscriber", ... ([a-z0-9_-], <= 50)
# Inserts one app_users row (unique name) and one public_keys row (unique user_id+key). Credentials from etc/pg.env (0600), never argv.
set -euo pipefail
NAME="${1:?name}"; KEYFILE="${2:?pubkey file}"
case "$NAME" in *[!a-z0-9_-]*|"") echo "add-key: name must be [a-z0-9_-]" >&2; exit 2 ;; esac
[ "${#NAME}" -le 50 ] || { echo "add-key: name over 50 chars" >&2; exit 2; }
[ -f "$KEYFILE" ] || { echo "add-key: no such key file" >&2; exit 2; }
KEY="$(awk 'NR==1{print $1" "$2}' "$KEYFILE")"        # pico compares "type base64" with the comment stripped (shared.KeyForKeyText)
case "$KEY" in "ssh-ed25519 "[A-Za-z0-9+/]*) ;; *) echo "add-key: only ssh-ed25519 public keys" >&2; exit 2 ;; esac
GH="${GUARDIAN_HOME:-$HOME/oc/fleet-access/guardian}"
export PATH=/opt/homebrew/opt/postgresql@16/bin:$PATH
set -a
# shellcheck disable=SC1091
. "$GH/etc/pg.env"
set +a
# psql variables are quoted with :'name' so no value is spliced into SQL text; the SQL arrives on stdin.
psql -v ON_ERROR_STOP=1 -q -v name="$NAME" -v key="$KEY" <<'SQL'
WITH u AS (
  INSERT INTO app_users (name) VALUES (:'name')
  ON CONFLICT ON CONSTRAINT unique_name DO UPDATE SET name = EXCLUDED.name
  RETURNING id)
INSERT INTO public_keys (user_id, public_key, name) SELECT id, :'key', :'name' FROM u
ON CONFLICT ON CONSTRAINT unique_key_for_user DO NOTHING;
SQL
echo "add-key: ok $NAME"
