#!/bin/bash
# bus.sh <tool> '<json args>'   |  bus.sh --list
# Calls the eta-bus MCP on the Mini as identity "scribe-mcp-lead" over ssh stdio.
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"herdr-air","version":"1"}}}'
NOTE='{"jsonrpc":"2.0","method":"notifications/initialized"}'
ARGS="${2:-}"; [ -z "$ARGS" ] && ARGS='{}'
if [ "$1" = "--list" ]; then CALL='{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
else CALL=$(printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$1" "$ARGS"); fi
{ echo "$INIT"; echo "$NOTE"; echo "$CALL"; sleep "${BUS_WAIT:-4}"; } | ssh -o BatchMode=yes -o ConnectTimeout=15 mini 'env ETA_BUS_AS=scribe-mcp-lead /bin/sh /Users/vinaybhardwaj/dev/eta-bus-mcp/run.sh' 2>/dev/null | grep '"id":2'
