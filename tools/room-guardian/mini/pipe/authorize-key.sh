#!/usr/bin/env bash
# Authorise one public key on the pipe server by inserting rows pico looks up (A0 section 3). INFERRED schema: read from picosh/pico
# sql/migrations/20220310_init.sql + 20240311_add_public_key_name.sql at 40c2ba8; NOT run against a live pipe database.
# Usage: authorize-key.sh <name> <pubkey-file>        (name = room slug or "subscriber")
# DATABASE_URL comes from PIPE_DATABASE_URL_FILE (env only). Use --print to show the SQL without running it.
set -euo pipefail
PRINT=0; [ "${1:-}" = "--print" ] && { PRINT=1; shift; }
NAME="${1:?name}"; KEYFILE="${2:?pubkey file}"
case "$NAME" in *[!a-zA-Z0-9_-]*|"") echo "authorize-key: name must be [a-zA-Z0-9_-]" >&2; exit 2 ;; esac
[ "${#NAME}" -le 50 ] || { echo "authorize-key: name over 50 chars" >&2; exit 2; }
# key as pico stores it: "type base64", no comment, no newline (INFERRED from FindUserByPubkey string compare)
KEY="$(awk 'NR==1{print $1" "$2}' "$KEYFILE")"
case "$KEY" in ssh-ed25519\ *) ;; *) echo "authorize-key: only ssh-ed25519 keys" >&2; exit 2 ;; esac
case "$KEY" in *"'"*) echo "authorize-key: bad key" >&2; exit 2 ;; esac
SQL="WITH u AS (INSERT INTO app_users (name) VALUES ('$NAME') ON CONFLICT ON CONSTRAINT unique_name DO UPDATE SET name = EXCLUDED.name RETURNING id)
INSERT INTO public_keys (user_id, public_key, name) SELECT id, '$KEY', '$NAME' FROM u ON CONFLICT ON CONSTRAINT unique_key_for_user DO NOTHING;"
if [ "$PRINT" = 1 ]; then printf '%s\n' "$SQL"; exit 0; fi
ENV_FILE="${GUARDIAN_ENV:-$HOME/oc/fleet-access/guardian/guardian.env}"
# shellcheck disable=SC1090
. "$ENV_FILE"
PGURL="$(cat "$PIPE_DATABASE_URL_FILE")"
PGCONNECT_TIMEOUT=5 psql "$PGURL" -v ON_ERROR_STOP=1 -c "$SQL"
