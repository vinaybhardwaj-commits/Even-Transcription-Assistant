#!/bin/sh
# Forced command for worker-pool restricted bus-relay keys (generic: HERDR_MACHINE and optional
# PANE_ALLOWLIST both come from the authorized_keys command= line, never the client). Client command
# ignored except for one validated HERDR_PANE_ID token, never eval'd. The key binding (which
# authorized_keys line matched) is the real identity fix; PANE_ALLOWLIST is defense-in-depth on top.
case "$SSH_ORIGINAL_COMMAND" in
  HERDR_PANE_ID=*)
    candidate=${SSH_ORIGINAL_COMMAND#HERDR_PANE_ID=}
    case "$candidate" in
      *[!a-zA-Z0-9:._-]*) candidate="" ;;
    esac
    ;;
  *)
    candidate=""
    ;;
esac

if [ -z "$candidate" ]; then
  echo "ssh-forced-wrapper-worker.sh: no valid HERDR_PANE_ID, refusing" >&2
  exit 1
fi

if [ -n "${PANE_ALLOWLIST:-}" ]; then
  if [ ! -f "$PANE_ALLOWLIST" ] || ! grep -qxF "$candidate" "$PANE_ALLOWLIST"; then
    echo "ssh-forced-wrapper-worker.sh: pane id not in allowlist, refusing" >&2
    exit 1
  fi
fi

HERDR_PANE_ID="$candidate"
export HERDR_PANE_ID
: "${HERDR_MACHINE:?ssh-forced-wrapper-worker.sh: HERDR_MACHINE must be set by the authorized_keys command= line, refusing}"
export HERDR_MACHINE
exec /bin/sh /Users/vinaybhardwaj/dev/eta-bus-mcp/run.sh
