#!/bin/sh
# Render the service template for this OS. Writes the unit/plist and pins herdrBin in ~/.ubus/nodelink.json;
# never enables, loads or starts anything. Fails (exit 1, nothing written) if node or herdr is not found.
# usage: install-nodelink.sh [repo-dir]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=${1:-$(cd "$here/.." && pwd)}
case "$repo" in */nodelink) repo=$(dirname "$repo");; esac
node=$(command -v node || true)
herdr=$(command -v herdr || true)
[ -n "$node" ] || { echo "error: node not found on PATH" >&2; exit 1; }
[ -n "$herdr" ] || { echo "error: herdr not found on PATH; a node without herdr would report zero panes. Install herdr or fix PATH, then rerun." >&2; exit 1; }
case "$node$herdr$repo$HOME" in *'
'*) echo "error: newline in a path" >&2; exit 1;; esac
esc() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; }
os=${UBUS_INSTALL_OS:-$(uname -s)}
d_node=$(dirname "$node"); d_herdr=$(dirname "$herdr")
path="$d_node:$d_herdr:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
render() { sed -e "s|@NODE@|$(esc "$node")|g" -e "s|@REPO@|$(esc "$repo")|g" -e "s|@HOME@|$(esc "$HOME")|g" -e "s|@PATH@|$(esc "$path")|g" "$1"; }
if [ "$os" = Darwin ]; then
  out=$HOME/Library/LaunchAgents/in.evenhc.ubus-nodelink.plist; tpl=launchd.plist
else
  out=$HOME/.config/systemd/user/ubus-nodelink.service; tpl=systemd-user.service
fi
mkdir -p "$HOME/.ubus" "$(dirname "$out")"
[ ! -e "$out" ] || { cp "$out" "$out.bak"; echo "backed up existing to $out.bak"; }
render "$here/$tpl" > "$out"
echo "wrote $out"
# pin herdr in the config (merge; keep every other key)
cfgf=${UBUS_NODELINK_CONFIG:-$HOME/.ubus/nodelink.json}
"$node" -e 'const fs=require("fs");const [f,h]=process.argv.slice(1);let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}c.herdrBin=h;fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' "$cfgf" "$herdr"
echo "pinned herdrBin=$herdr in $cfgf"
if [ "$os" = Darwin ]; then
  echo "next: launchctl bootstrap gui/$(id -u) $out"
else
  linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo unknown)
  if [ "$linger" != yes ]; then
    echo "WARNING: linger is off (Linger=$linger). Headless node: the service will not start at boot and stops at logout." >&2
    echo "         Run: loginctl enable-linger $(id -un)" >&2
  fi
  echo "next: systemctl --user daemon-reload && systemctl --user enable --now ubus-nodelink"
fi
