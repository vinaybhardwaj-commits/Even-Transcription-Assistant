#!/bin/bash
# Install the Kiosk Guardian on THIS Mac as the console user. Idempotent. Does not load the agent unless --load.
#   install.sh --room <slug> [--config <file>] [--dry-run] [--load] [--sudo "<cmd>"]
# Test seams: GUARDIAN_HOME, LA_DIR, GUARDIAN_ROOT_HELPER.
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARDIAN_HOME="${GUARDIAN_HOME:-$HOME/Library/Application Support/EvenScribe/Guardian}"
LA_DIR="${LA_DIR:-$HOME/Library/LaunchAgents}"
GUARDIAN_ROOT_HELPER="${GUARDIAN_ROOT_HELPER:-/usr/local/libexec/eta-guardian-root}"
LABEL="com.evenscribe.room-guardian"
ROOM=""; CONFIG=""; DRY=0; LOAD=0; SUDO="sudo"
while [ $# -gt 0 ]; do
  case "$1" in
    --room) ROOM="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --load) LOAD=1; shift ;;
    --sudo) SUDO="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
case "$ROOM" in ''|*[!a-z0-9-]*) echo "--room <slug> required (lowercase letters, digits, hyphen)" >&2; exit 2 ;; esac
[ -z "$CONFIG" ] || [ -r "$CONFIG" ] || { echo "cannot read --config" >&2; exit 2; }
# R12: guardian.conf is data, parsed by lib/conf.sh. Refuse a config the agent would reject (it would run killed), before anything is installed.
if [ -n "$CONFIG" ]; then
  if ! ( G_TR=/usr/bin/tr; G_WC=/usr/bin/wc; G_HEAD=/usr/bin/head; audit() { echo "  conf: $*" >&2; }; . "$SRC/lib/conf.sh"; conf_load "$CONFIG" noperm ); then
    echo "refusing: --config is not valid guardian.conf (data lines only, allow-listed keys)" >&2; exit 2
  fi
fi

do_it() { if [ "$DRY" -eq 1 ]; then echo "DRY-RUN: $*"; else "$@"; fi; }
copy_if_changed() { # src dst mode
  if [ -e "$2" ] && cmp -s "$1" "$2"; then echo "unchanged: $2"; return 0; fi
  do_it mkdir -p "$(dirname "$2")" && do_it cp "$1" "$2" && do_it chmod "$3" "$2"
}

# R14 A2: GUARDIAN_HOME is the conf's parent directory. The agent rejects a conf whose directory is group/world-writable or carries an ACL, so make it 0700, no ACL
# (an inheritable ACL on the parent would otherwise be copied onto it), before anything else is created inside it.
do_it mkdir -p "$GUARDIAN_HOME"
do_it chmod 700 "$GUARDIAN_HOME"
do_it /bin/chmod -N "$GUARDIAN_HOME"
do_it mkdir -p "$GUARDIAN_HOME/bin" "$GUARDIAN_HOME/lib" "$GUARDIAN_HOME/state" "$GUARDIAN_HOME/flags" "$GUARDIAN_HOME/keys" "$LA_DIR"
do_it chmod 700 "$GUARDIAN_HOME/keys"
copy_if_changed "$SRC/bin/guardian.sh" "$GUARDIAN_HOME/bin/guardian.sh" 755
for f in common conf collect killswitch faulttree heal probe canary; do copy_if_changed "$SRC/lib/$f.sh" "$GUARDIAN_HOME/lib/$f.sh" 644; done

# config: from --config (kept outside git), else a stub the operator completes. Existing config is kept unless --config differs (old one backed up).
# R14 A1/A6: the installed conf must pass the agent's check: a regular file (not a symlink), this uid, mode 0600, no ACL. An existing conf that fails any of
# these is rewritten even when its content is identical: a temp file in the same directory, 0600, ACL stripped, then `mv` over the name. mv replaces a symlink
# itself, never what it points to, so the old file or symlink target is not modified and nothing is deleted.
CONF_DST="$GUARDIAN_HOME/guardian.conf"
conf_state_ok() { # 0 when the existing conf is a regular file, 0600, this uid, no ACL
  local st acl
  [ -L "$CONF_DST" ] && return 1
  [ -f "$CONF_DST" ] || return 1
  st="$(/usr/bin/stat -f '%Lp %u' "$CONF_DST" 2>/dev/null)" || return 1
  [ "$st" = "600 $(id -u)" ] || return 1
  acl="$(/bin/ls -led "$CONF_DST" 2>/dev/null | wc -l | tr -d ' ')"
  [ "$acl" = 1 ]
}
write_conf() { # <source file>
  local tmp
  if [ "$DRY" -eq 1 ]; then echo "DRY-RUN: write $CONF_DST (temp file, 0600, no ACL, mv)"; return 0; fi
  if [ -d "$CONF_DST" ]; then echo "refusing: $CONF_DST is a directory; move it aside" >&2; exit 2; fi
  tmp="$(mktemp "$GUARDIAN_HOME/.guardian.conf.XXXXXX")" || exit 1
  if cat "$1" >"$tmp" && chmod 600 "$tmp" && /bin/chmod -N "$tmp" && mv -f "$tmp" "$CONF_DST"; then echo "installed: $CONF_DST"; else rm -f "$tmp"; echo "failed to write $CONF_DST" >&2; exit 1; fi
}
if [ -n "$CONFIG" ]; then
  if [ -e "$CONF_DST" ] && ! cmp -s "$CONFIG" "$CONF_DST"; then
    do_it cp -p "$CONF_DST" "$GUARDIAN_HOME/guardian.conf.bak-$(date +%s)"
  fi
  if [ -e "$CONF_DST" ] && cmp -s "$CONFIG" "$CONF_DST" && conf_state_ok; then echo "unchanged: $CONF_DST"; else write_conf "$CONFIG"; fi
elif [ ! -e "$CONF_DST" ] && [ ! -L "$CONF_DST" ]; then
  STUB="$(mktemp)"; sed "s/<room-slug>/$ROOM/" "$SRC/guardian.conf.example" >"$STUB"; write_conf "$STUB"; rm -f "$STUB"
elif ! conf_state_ok; then
  # an existing conf that the agent would reject (symlink, bad mode or owner, ACL): rewrite it with its own content (read through the link, never written through it)
  if [ -f "$CONF_DST" ] && [ -r "$CONF_DST" ]; then write_conf "$CONF_DST"; else echo "refusing: existing guardian.conf is not a readable file; move it aside" >&2; exit 2; fi
fi

# per-room SSH key, generated here, never leaves this Mac; only the public half is for the Mini
if [ ! -e "$GUARDIAN_HOME/keys/id_ed25519" ]; then
  do_it ssh-keygen -q -t ed25519 -N "" -C "guardian-$ROOM" -f "$GUARDIAN_HOME/keys/id_ed25519"
fi
echo "public key file (register on the Mini pipe server): $GUARDIAN_HOME/keys/id_ed25519.pub"

# LaunchAgent
PLIST="$LA_DIR/$LABEL.plist"
if [ "$DRY" -eq 1 ]; then echo "DRY-RUN: render $PLIST"; else
  TMP="$(mktemp)"; sed "s|__GUARDIAN_HOME__|$GUARDIAN_HOME|g" "$SRC/launchd/$LABEL.plist.tmpl" >"$TMP"
  if [ -e "$PLIST" ] && cmp -s "$TMP" "$PLIST"; then echo "unchanged: $PLIST"; else cp "$TMP" "$PLIST"; fi
  rm -f "$TMP"
fi

# root helper, through the sudo path only
if [ -e "$GUARDIAN_ROOT_HELPER" ] && cmp -s "$SRC/bin/guardian-root.sh" "$GUARDIAN_ROOT_HELPER"; then echo "unchanged: $GUARDIAN_ROOT_HELPER"; else
  # shellcheck disable=SC2086
  do_it $SUDO install -d -m 755 "$(dirname "$GUARDIAN_ROOT_HELPER")"
  # shellcheck disable=SC2086
  do_it $SUDO install -m 755 "$SRC/bin/guardian-root.sh" "$GUARDIAN_ROOT_HELPER"
fi

if [ "$LOAD" -eq 1 ]; then
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then echo "already loaded"; else do_it launchctl bootstrap "gui/$(id -u)" "$PLIST"; fi
else
  echo "agent NOT loaded. Load with: launchctl bootstrap gui/\$(id -u) \"$PLIST\"  (or re-run with --load)"
fi
echo "manual: sudoers NOPASSWD for $GUARDIAN_ROOT_HELPER only; Guardian starts in SHADOW; HEAL is set from the Mini."
