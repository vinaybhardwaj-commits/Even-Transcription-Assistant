#!/usr/bin/env bash
# Install the ubus client (shim + hook) from this tree onto one host.
#   scripts/install-client.sh <ssh-host|local> [--dry-run]
# Copies dist/ and package.json (plus production node_modules when package.json has runtime deps) to
# ~/.local/ubus-mcp on the host. It does NOT touch the host's bin/ wrappers, ~/.config/ubus/config.json,
# or ~/.claude/settings.json: those hold the host's node path, UBUS_MACHINE label and door settings.
# If the host has no bin/ wrappers yet, it prints how to create them and stops. Never restarts anything.
# shellcheck disable=SC2016,SC2029  # remote snippets are single-quoted on purpose
set -euo pipefail

HOST="${1:-}"
[ -n "$HOST" ] || { echo "usage: $0 <ssh-host|local> [--dry-run]" >&2; exit 2; }
shift
DRY=0
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; *) echo "unknown flag: $a" >&2; exit 2 ;; esac; done


# Hosts this tooling must never touch (same list as isDeniedMachine in src/constants.ts, plus the ssh alias icu).
deny_host() {
  local h="${1##*@}"; h="$(printf '%s' "$h" | tr '[:upper:]' '[:lower:]')"
  case "$h" in
    ehrc-*|orb2|vinay-orb2|icu) echo "refused: host '$1' is a denied machine (hospital kiosk, ICU Mac, or OT recorder). Nothing was contacted." >&2; exit 3 ;;
  esac
}
deny_host "$HOST"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8)
say() { printf '%s\n' "$*"; }
act() { if [ "$DRY" = 1 ]; then say "[dry-run] $*"; else say "[run] $*"; fi; }

remote() { # run a shell snippet on the host (read-only unless the caller says otherwise); never reads our stdin
  if [ "$HOST" = local ]; then bash -c "$1" </dev/null; else ssh -n "${SSH_OPTS[@]}" "$HOST" "$1"; fi
}

VERSION="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$ROOT/package.json")"
say "tree: $ROOT  version: $VERSION  host: $HOST  dry-run: $DRY"

# 1. build if dist is missing or older than the sources
NEED_BUILD=0
if [ ! -f "$ROOT/dist/bin/ubus-mcp.js" ]; then NEED_BUILD=1
elif [ -n "$(find "$ROOT/src" "$ROOT/bin" "$ROOT/package.json" -newer "$ROOT/dist/bin/ubus-mcp.js" -type f 2>/dev/null | head -1)" ]; then NEED_BUILD=1; fi
if [ "$NEED_BUILD" = 1 ]; then
  act "build: (cd $ROOT && npm ci && npm run build)"
  if [ "$DRY" = 0 ]; then (cd "$ROOT" && { [ -d node_modules ] || npm ci; } && npx tsc -p tsconfig.json); fi
else
  say "build: dist is current"
fi

# 2. probe the host (read-only)
PROBE="$(remote 'printf "os=%s\n" "$(uname -s)"; printf "node=%s\n" "$(command -v node || true)"; printf "dest=%s\n" "$HOME/.local/ubus-mcp"; printf "installed=%s\n" "$(sed -n "s/.*\"version\": *\"\([^\"]*\)\".*/\1/p" "$HOME/.local/ubus-mcp/package.json" 2>/dev/null | head -1)"; for w in ubus-mcp ubus-hook; do [ -x "$HOME/.local/ubus-mcp/bin/$w" ] && echo "wrapper=$w"; done; ls -d "$HOME/.local/ubus-mcp/dist" >/dev/null 2>&1 && echo has_dist=1; true' 2>&1)" || { say "probe failed: host unreachable"; exit 1; }
say "$PROBE" | sed 's/^/probe: /'
OS="$(printf '%s\n' "$PROBE" | sed -n 's/^os=//p')"
DEST="$(printf '%s\n' "$PROBE" | sed -n 's/^dest=//p')"
INSTALLED="$(printf '%s\n' "$PROBE" | sed -n 's/^installed=//p')"
WRAPPERS="$(printf '%s\n' "$PROBE" | grep -c '^wrapper=' || true)"
case "$OS" in Linux|Darwin) ;; *) say "unsupported os: $OS"; exit 1 ;; esac

# 2b. the Mini's wrappers run the repo tree, not ~/.local/ubus-mcp/dist
if [ "$HOST" = local ] && ! printf '%s\n' "$PROBE" | grep -q '^has_dist=1'; then
  say "local: wrappers here run from the live ubus tree (install/bin), not $DEST/dist. Installing would not change the running client. Nothing to do."
  [ "$DRY" = 1 ] && say "[dry-run] would stop here for host local"
  exit 0
fi

# 3. production node_modules, only if there are runtime dependencies
DEPS="$(node -e 'const p=require(process.argv[1]);process.stdout.write(String(Object.keys(p.dependencies||{}).length))' "$ROOT/package.json")"
FILES=(dist package.json)
if [ "$DEPS" != 0 ]; then
  act "production node_modules: (cd $ROOT && npm ci --omit=dev) then ship node_modules"
  FILES+=(node_modules)
else
  say "node_modules: none needed (no runtime dependencies; client uses fetch/fs/os/crypto only)"
fi

# 4. wrappers: never overwritten
if [ "$WRAPPERS" -ge 2 ]; then
  say "bin: host wrappers kept as they are (they pin the host's node and UBUS_MACHINE)"
else
  say "bin: host has no ubus-mcp/ubus-hook wrappers at $DEST/bin; create them first (see install/bin/* and fleet-mcp deploy/ubus_install.sh). Stopping before copy."
  [ "$DRY" = 1 ] || exit 1
fi

# 5. copy: tar over ssh (no rsync needed on the host), to a staging dir, then swap dist
STAGE="$DEST/.stage-$VERSION"
act "backup: $DEST/dist -> $DEST/dist.bak-${INSTALLED:-none}"
act "copy: ${FILES[*]} -> $HOST:$STAGE (tar over ssh, no xattrs)"
act "swap: $STAGE/dist -> $DEST/dist; $STAGE/package.json -> $DEST/package.json; remove $STAGE"
if [ "$DRY" = 0 ]; then
  TAR=(tar -C "$ROOT" -cf - "${FILES[@]}")
  if tar --help 2>&1 | grep -q -- --no-xattrs; then TAR=(tar --no-xattrs -C "$ROOT" -cf - "${FILES[@]}"); fi
  remote "set -e; D=\$HOME/.local/ubus-mcp; S=\$D/.stage-$VERSION; rm -rf \$S; mkdir -p \$S" 
  COPYFILE_DISABLE=1 "${TAR[@]}" | { if [ "$HOST" = local ]; then tar -C "$DEST/.stage-$VERSION" -xf -; else ssh "${SSH_OPTS[@]}" "$HOST" "tar -C \"\$HOME/.local/ubus-mcp/.stage-$VERSION\" -xf -"; fi; }
  remote "set -e; D=\$HOME/.local/ubus-mcp; S=\$D/.stage-$VERSION; [ -d \$D/dist ] && rm -rf \$D/dist.bak-${INSTALLED:-none} && mv \$D/dist \$D/dist.bak-${INSTALLED:-none}; mv \$S/dist \$D/dist; mv \$S/package.json \$D/package.json; [ -d \$S/node_modules ] && { rm -rf \$D/node_modules; mv \$S/node_modules \$D/node_modules; }; rm -rf \$S"
fi

# 6. report the installed version
if [ "$DRY" = 1 ]; then
  say "installed version after a real run: $VERSION (host has ${INSTALLED:-none} now)"
else
  say "installed version: $(remote 'sed -n "s/.*\"version\": *\"\([^\"]*\)\".*/\1/p" "$HOME/.local/ubus-mcp/package.json" | head -1')"
  say "running shims keep the old code until their pane restarts: scripts/restart-panes.sh $HOST"
fi
