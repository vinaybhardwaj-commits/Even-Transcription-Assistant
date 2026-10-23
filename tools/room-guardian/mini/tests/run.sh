#!/usr/bin/env bash
# FR-1 C4 suite: shellcheck on every .sh, then both unittest files. Run from anywhere.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# FR1 D7-4 MUST-1: the live router runs from ~/oc/fleet-access/guardian. Point every router path at a scratch dir BEFORE python starts, so no test
# can open the live case store, router-local.json or the real gating inbox, and no test can start the real ubus shim.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/guardian-test.XXXXXX")"
case "$SCRATCH" in */guardian-test.*) trap 'rm -r -- "$SCRATCH"' EXIT ;; esac
export GUARDIAN_HOME="$SCRATCH" GUARDIAN_GATING_INBOX="$SCRATCH/INBOX-scratch.md" UBUS_MCP="$SCRATCH/no-such-ubus-mcp"
shellcheck "$HERE"/../pipe/*.sh "$HERE"/../ops/*.sh "$HERE"/run.sh
PYTHONDONTWRITEBYTECODE=1 python3 -W ignore -I -m unittest discover -s "$HERE" -p 'test_*.py' -v 2>&1 | tail -n 40
