#!/bin/sh
# Create <keyDir>/<node>.key (32 random bytes, hex, mode 0600) and a 0600 copy at <outpath> for transfer.
# keyDir comes from ~/.ubus/hub.json (or UBUS_HUB_CONFIG), default ~/.ubus/hub/nodes. Prints only names and paths.
set -eu
umask 077
[ $# -eq 2 ] || { echo "usage: hub-provision-node.sh <node> <outpath>" >&2; exit 2; }
node="$1"; out="$2"
case "$node" in mini|air|t4|c3|c4|asus|yoga) ;; *) echo "refused: unknown node" >&2; exit 1 ;; esac
cfg="${UBUS_HUB_CONFIG:-$HOME/.ubus/hub.json}"
keydir=""
[ -f "$cfg" ] && keydir="$(sed -n 's/.*"keyDir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" | head -1)"
keydir="${keydir:-$HOME/.ubus/hub/nodes}"
key="$keydir/$node.key"
[ -e "$key" ] && { echo "refused: $key exists" >&2; exit 1; }
[ -e "$out" ] && { echo "refused: $out exists" >&2; exit 1; }
mkdir -p "$keydir"
openssl rand -hex 32 > "$key"
chmod 600 "$key"
cp "$key" "$out"
chmod 600 "$out"
echo "node: $node"
echo "key: $key"
echo "copy: $out"
