#!/usr/bin/env bash
# One-command real-browser check of v2-page.html (375 px + 1280 px, light + dark).
# Needs Chromium in ~/.cache/ms-playwright and playwright + libs in ~/.cache/eta-browser-check (installed 24 Sep).
set -euo pipefail
H="$HOME/.cache/eta-browser-check"
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$(mktemp -d)}"
export LD_LIBRARY_PATH="$H/libs/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
python3 "$here/make-harness.py" "$out/harness.html" >/dev/null
NODE_PATH="$H/node_modules" node "$here/browser-check.js" "$out"
