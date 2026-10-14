#!/usr/bin/env bash
# One-command real-browser check of the /rate page against mock-server.mjs (375 px + 1280 px, light + dark, viewer CSP).
# Needs the ~/.cache install described in ../surgery-review/browser-check.sh.
set -euo pipefail
H="$HOME/.cache/eta-browser-check"
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$(mktemp -d)}"
mkdir -p "$out"
export LD_LIBRARY_PATH="$H/libs/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
python3 "$here/build_ui.py" >/dev/null
NODE_PATH="$H/node_modules" node "$here/browser-check.js" "$out"
