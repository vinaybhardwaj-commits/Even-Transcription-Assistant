#!/usr/bin/env bash
# Build the pico pipe SSH server from source at a pinned commit (FR-1 R4, A0 option A+C). Installs nothing system-wide.
# Needs Go >= 1.27 on PATH or in GO_PREFIX (a test prefix). Output: $PIPE_BIN (default under GUARDIAN_HOME/bin).
set -euo pipefail
PICO_COMMIT="${PICO_COMMIT:-40c2ba8}"
PICO_URL="${PICO_URL:-https://github.com/picosh/pico.git}"
GUARDIAN_HOME="${GUARDIAN_HOME:-$HOME/oc/fleet-access/guardian}"
PIPE_BIN="${PIPE_BIN:-$GUARDIAN_HOME/bin/pipe-ssh}"
SRC="${PIPE_SRC:-$GUARDIAN_HOME/src/pico}"
[ -n "${GO_PREFIX:-}" ] && export PATH="$GO_PREFIX/bin:$PATH"
if ! command -v go >/dev/null 2>&1; then
  echo "build-pipe: go not found. Install Go into a test prefix and set GO_PREFIX, then re-run." >&2
  exit 2
fi
mkdir -p "$(dirname "$PIPE_BIN")" "$(dirname "$SRC")"
if [ ! -d "$SRC/.git" ]; then git clone --quiet "$PICO_URL" "$SRC"; fi
git -C "$SRC" fetch --quiet origin
git -C "$SRC" checkout --quiet "$PICO_COMMIT"
(cd "$SRC" && go build -o "$PIPE_BIN" ./cmd/pipe/ssh)
chmod 0755 "$PIPE_BIN"
echo "build-pipe: built $PIPE_BIN at pico $PICO_COMMIT"
