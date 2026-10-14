#!/bin/sh
# eta-lab fork. Herdr runs plugin commands with the PATH its server started
# with, and on a remote that PATH has no ~/.local/bin. Find node the way a
# login shell would, then hand over: run-node.sh bin/agent-state.js [args].
if ! command -v node >/dev/null 2>&1; then
  for dir in "$HOME/.local/node/bin" /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$dir/node" ]; then
      PATH="$dir:$PATH"
      export PATH
      break
    fi
  done
fi
exec node "$@"
