#!/bin/sh
# Forced command for the eta-lab-t4 box's restricted "eta_bus_tunnel" SSH key
# (see ~/.ssh/authorized_keys) — reached ONLY through the reverse tunnel a
# box-resident Claude Code pane opens to run eta-bus-mcp on the Mini over
# SSH-tunneled stdio, never directly over the network.
#
# The authorized_keys `command=` restriction means whatever the client
# actually asked to run is IGNORED; OpenSSH still exposes it to us as
# $SSH_ORIGINAL_COMMAND so we can extract exactly one thing from it — the
# caller's HERDR_PANE_ID — through a strict allow-list pattern. We never
# eval or exec that string; we only ever pull a validated token out of it.
# HERDR_MACHINE is not client-supplied at all: every caller reaching this
# script arrived via this one key, which only ever lives on eta-lab-t4, so
# it's hardcoded here, not something a client could spoof to point identity
# resolution at a different machine.
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

HERDR_PANE_ID="$candidate"
export HERDR_PANE_ID
HERDR_MACHINE="eta-lab-t4"
export HERDR_MACHINE
exec /bin/sh /Users/vinaybhardwaj/dev/eta-bus-mcp/run.sh
