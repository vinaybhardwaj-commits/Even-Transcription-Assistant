#!/usr/bin/env bash
# One-command real-browser check. Needs ~/.cache/eta-browser-check (playwright@1.56.1 + extracted chromium libs); see README.
set -euo pipefail
H="$HOME/.cache/eta-browser-check"
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$(mktemp -d)}"
mkdir -p "$out"
export LD_LIBRARY_PATH="$H/libs/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
node "$here/build.mjs" >/dev/null
NODE_PATH="$H/node_modules" node "$here/browser-check.mjs" "$out"
