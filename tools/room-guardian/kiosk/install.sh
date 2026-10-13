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

do_it() { if [ "$DRY" -eq 1 ]; then echo "DRY-RUN: $*"; else "$@"; fi; }
copy_if_changed() { # src dst mode
  if [ -e "$2" ] && cmp -s "$1" "$2"; then echo "unchanged: $2"; return 0; fi
  do_it mkdir -p "$(dirname "$2")" && do_it cp "$1" "$2" && do_it chmod "$3" "$2"
}

do_it mkdir -p "$GUARDIAN_HOME/bin" "$GUARDIAN_HOME/lib" "$GUARDIAN_HOME/state" "$GUARDIAN_HOME/flags" "$GUARDIAN_HOME/keys" "$LA_DIR"
do_it chmod 700 "$GUARDIAN_HOME/keys"
copy_if_changed "$SRC/bin/guardian.sh" "$GUARDIAN_HOME/bin/guardian.sh" 755
for f in common collect killswitch faulttree heal probe; do copy_if_changed "$SRC/lib/$f.sh" "$GUARDIAN_HOME/lib/$f.sh" 644; done

# config: from --config (kept outside git), else a stub the operator completes. Existing config is kept unless --config differs (old one backed up).
if [ -n "$CONFIG" ]; then
  if [ -e "$GUARDIAN_HOME/guardian.conf" ] && ! cmp -s "$CONFIG" "$GUARDIAN_HOME/guardian.conf"; then
    do_it cp -p "$GUARDIAN_HOME/guardian.conf" "$GUARDIAN_HOME/guardian.conf.bak-$(date +%s)"
  fi
  copy_if_changed "$CONFIG" "$GUARDIAN_HOME/guardian.conf" 600
elif [ ! -e "$GUARDIAN_HOME/guardian.conf" ]; then
  if [ "$DRY" -eq 1 ]; then echo "DRY-RUN: write stub guardian.conf for $ROOM"; else
    sed "s/<room-slug>/$ROOM/" "$SRC/guardian.conf.example" >"$GUARDIAN_HOME/guardian.conf"; chmod 600 "$GUARDIAN_HOME/guardian.conf"; fi
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
