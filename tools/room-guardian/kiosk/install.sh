#!/bin/bash
# Install the Kiosk Guardian on THIS Mac as the console user. Idempotent. Does not load the agent unless --load.
#   install.sh --room <slug> [--config <file>] [--mic-class webcam|tonor] [--dry-run] [--load] [--sudo "<cmd>"]
# Test seams: GUARDIAN_HOME, LA_DIR, GUARDIAN_ROOT_HELPER.
# R15: every ancestor of GUARDIAN_HOME is walked first (lib/conf.sh tree_walk_anc). One owned by root or by this user, not group/world-writable, no ACL beyond the macOS default
# "group:everyone deny delete" passes. One owned by this user that fails on mode or ACL is repaired (chmod go-w, extra ACL entries removed) and each repair is logged.
# Anything else (root-owned writable, a foreign owner, a link owned by this user) is refused with rc 2 and nothing is installed. --dry-run reports both and changes nothing.
umask 022   # R15: the same modes whatever the caller's umask (umask 000 used to leave bin, lib, state, flags and the parent 0777)
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARDIAN_HOME="${GUARDIAN_HOME:-$HOME/Library/Application Support/EvenScribe/Guardian}"
LA_DIR="${LA_DIR:-$HOME/Library/LaunchAgents}"
GUARDIAN_ROOT_HELPER="${GUARDIAN_ROOT_HELPER:-/usr/local/libexec/eta-guardian-root}"
LABEL="com.evenscribe.room-guardian"
ROOM=""; CONFIG=""; MIC_CLASS=""; MIC_SET=0; DRY=0; LOAD=0; SUDO="sudo"
while [ $# -gt 0 ]; do
  case "$1" in
    --room) ROOM="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --mic-class) MIC_CLASS="${2:-}"; MIC_SET=1; shift $(( $# >= 2 ? 2 : 1 )) ;;
    --dry-run) DRY=1; shift ;;
    --load) LOAD=1; shift ;;
    --sudo) SUDO="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
case "$ROOM" in ''|*[!a-z0-9-]*) echo "--room <slug> required (lowercase letters, digits, hyphen)" >&2; exit 2 ;; esac
[ -z "$CONFIG" ] || [ -r "$CONFIG" ] || { echo "cannot read --config" >&2; exit 2; }
# S2: --mic-class writes GUARDIAN_MIC_CLASS into the conf: the --config source (else the existing conf, else the stub) with any active GUARDIAN_MIC_CLASS line replaced.
if [ "$MIC_SET" = 1 ]; then
  case "$MIC_CLASS" in webcam|tonor) ;; *) echo "refusing: --mic-class must be webcam or tonor" >&2; exit 2 ;; esac
  MC_BASE="$CONFIG"; MC_TMP=""; MC_OUT=""
  trap 'rm -f "${MC_TMP:-}" "${MC_OUT:-}"' EXIT   # F3: the temp conf goes on every exit path, refusals included
  if [ -z "$MC_BASE" ] && { [ -e "$GUARDIAN_HOME/guardian.conf" ] || [ -L "$GUARDIAN_HOME/guardian.conf" ]; }; then
    # F2: an existing conf that cannot be read is refused, as without the flag; it never falls back to the stub
    if [ -f "$GUARDIAN_HOME/guardian.conf" ] && [ -r "$GUARDIAN_HOME/guardian.conf" ]; then MC_BASE="$GUARDIAN_HOME/guardian.conf"; else echo "refusing: existing guardian.conf is not a readable file; move it aside" >&2; exit 2; fi
  fi
  MC_TMP="$(mktemp)" || exit 1
  # N1: a --config that passes -r but cannot be read as a file (a directory) is refused here, as without the flag; no class-only conf may reach the R12 check
  if [ -n "$MC_BASE" ]; then cat "$MC_BASE" >"$MC_TMP" 2>/dev/null || { echo "cannot read --config" >&2; exit 2; }; else sed "s/<room-slug>/$ROOM/" "$SRC/guardian.conf.example" >"$MC_TMP"; fi
  MC_OUT="$(mktemp)" || exit 1
  ( . "$SRC/lib/conf.sh"; mic_class_set "$MIC_CLASS" ) <"$MC_TMP" >"$MC_OUT" || exit 1
  rm -f "$MC_TMP"; CONFIG="$MC_OUT"
fi
# R12: guardian.conf is data, parsed by lib/conf.sh. Refuse a config the agent would reject (it would run killed), before anything is installed.
if [ -n "$CONFIG" ]; then
  # R16: GUARDIAN_PIPE_SSH goes through `eval`, which strips one level of quotes, and OpenSSH splits UserKnownHostsFile / IdentityFile values on
  # whitespace. A value with a space that is not inner-quoted makes every ssh call fail (rc 255, OPD 6). Pattern check on the text only: no eval, no source.
  # Advisory lint, not a parser. It catches exactly two forms: a bare quoted value (KEY="a b" or KEY='a b') and an outer-quoted pair with no inner quote ("KEY=a b").
  # It does not catch -o "KEY=\"a b\"" (correct, passes), an unquoted KEY=a b (cannot be told from KEY=a plus the next option), or any other shape a space can hide in. A pass is not proof the ssh line works.
  pipe_ssh_lint() {
    local v="${GUARDIAN_PIPE_SSH:-}" re_bare re_wrapped
    re_bare='(^|[[:space:]])(UserKnownHostsFile|IdentityFile)=("[^"]* [^"]*"|'"'"'[^'"'"']* [^'"'"']*'"'"')'
    re_wrapped='"(UserKnownHostsFile|IdentityFile)=[^"\\]* [^"]*"'
    if [[ $v =~ $re_bare ]] || [[ $v =~ $re_wrapped ]]; then
      audit "GUARDIAN_PIPE_SSH: a UserKnownHostsFile or IdentityFile value has a space and is not inner-quoted; write -o \"UserKnownHostsFile=\\\"<path>\\\"\" (see guardian.conf.example)"
      return 1
    fi
    return 0
  }
  if ! ( G_TR=/usr/bin/tr; G_WC=/usr/bin/wc; G_HEAD=/usr/bin/head; audit() { echo "  conf: $*" >&2; }; . "$SRC/lib/conf.sh"; conf_load "$CONFIG" noperm && pipe_ssh_lint ); then
    echo "refusing: --config is not valid guardian.conf (data lines only, allow-listed keys)" >&2; exit 2
  fi
fi

do_it() { if [ "$DRY" -eq 1 ]; then echo "DRY-RUN: $*"; else "$@"; fi; }
# R15: a code file is written to a temp file in its own directory, then mv'd over the name: never through a symlink, and a running agent never reads a half-written file.
copy_if_changed() { # src dst mode
  local tmp
  if [ -f "$2" ] && [ ! -L "$2" ] && cmp -s "$1" "$2"; then echo "unchanged: $2"; return 0; fi
  do_it mkdir -p "$(dirname "$2")" || return 1
  if [ "$DRY" -eq 1 ]; then echo "DRY-RUN: write $2 (temp file, chmod $3, mv)"; return 0; fi
  tmp="$(mktemp "$(dirname "$2")/.install.XXXXXX")" || return 1
  if cp "$1" "$tmp" && chmod "$3" "$tmp" && /bin/chmod -N "$tmp" && mv -f "$tmp" "$2"; then return 0; fi
  rm -f "$tmp"; return 1
}

# ---- R15 (G14-3 i): the ancestors of GUARDIAN_HOME ----
case "$GUARDIAN_HOME" in /*) ;; *) echo "refusing: GUARDIAN_HOME must be an absolute path" >&2; exit 2 ;; esac
tree_scan() { # the scanner of lib/conf.sh, read-only: lines CLASS|what|path
  ( G_TR=/usr/bin/tr; G_WC=/usr/bin/wc; G_HEAD=/usr/bin/head; G_STAT=/usr/bin/stat; G_LS=/bin/ls; G_ID=/usr/bin/id; G_CAT=/bin/cat; G_MKDIR=/bin/mkdir
    # shellcheck disable=SC2329
    audit() { :; }; . "$SRC/lib/conf.sh" && tree_walk_anc "$GUARDIAN_HOME" 1 )
}
tree_refusals() { # reads scan lines on stdin; prints one line per refusal; rc 0 when there is none
  local cls what path bad=0
  while IFS='|' read -r cls what path; do
    [ -n "$cls" ] || continue
    case "$cls:$what" in X:*|R:acl:*\?*) echo "ancestor $path: ${what#acl:}"; bad=1 ;; esac
  done
  [ "$bad" -eq 0 ]
}
ANC="$(tree_scan)" || { echo "refusing: cannot scan the ancestors of $GUARDIAN_HOME" >&2; exit 2; }
REF="$(printf '%s\n' "$ANC" | tree_refusals)"
if [ -n "$REF" ]; then
  if [ "$DRY" -eq 1 ]; then printf '%s\n' "$REF" | sed 's/^/DRY-RUN: would refuse: /'; else printf '%s\n' "$REF" | sed 's/^/refusing: /' >&2; fi
  exit 2
fi
ROUND=0
while [ -n "$ANC" ] && [ "$ROUND" -lt 3 ]; do
  ROUND=$((ROUND + 1)); SEEN=$'\n'
  while IFS='|' read -r cls what path; do
    [ "$cls" = R ] || continue
    # the logical and the physical walk can name one directory twice (/var and /private/var): repair it once
    real="$(cd -P "$path" 2>/dev/null && pwd -P)" || real="$path"
    case "$SEEN" in *$'\n'"$real|$what"$'\n'*) continue ;; esac
    SEEN="$SEEN$real|$what"$'\n'
    case "$what" in
      writable)
        if [ "$DRY" -eq 1 ]; then echo "DRY-RUN: would repair: chmod go-w $path"; elif /bin/chmod go-w "$path"; then echo "repaired: chmod go-w $path"; else echo "refusing: cannot chmod go-w $path" >&2; exit 2; fi ;;
      acl:*)
        # shellcheck disable=SC2086
        for idx in $(printf '%s\n' ${what#acl:} | sort -rn); do
          if [ "$DRY" -eq 1 ]; then echo "DRY-RUN: would repair: remove ACL entry $idx from $path"
          elif /bin/chmod -a# "$idx" "$path"; then echo "repaired: removed ACL entry $idx from $path"
          else echo "refusing: cannot remove ACL entry $idx from $path" >&2; exit 2; fi
        done ;;
    esac
  done <<<"$ANC"
  [ "$DRY" -eq 1 ] && break
  ANC="$(tree_scan)" || { echo "refusing: cannot rescan the ancestors of $GUARDIAN_HOME" >&2; exit 2; }
  REF="$(printf '%s\n' "$ANC" | tree_refusals)"
  if [ -n "$REF" ]; then printf '%s\n' "$REF" | sed 's/^/refusing: /' >&2; exit 2; fi
done
if [ "$DRY" -ne 1 ] && [ -n "$ANC" ]; then echo "refusing: ancestors of $GUARDIAN_HOME still fail after repair" >&2; exit 2; fi

# R15b (S3): state/, flags/ and keys/ are the agent's own: state/control.last decides the mode, flags/ is its cache, keys/ holds the SSH key. One that is a symlink, is not a directory
# or is not owned by this user is refused with rc 2 before anything is created or changed (--dry-run says "would refuse", rc 2, and changes nothing).
ME_UID="$(id -u)"; S3_BAD=""
for d in state flags keys; do
  if [ -L "$GUARDIAN_HOME/$d" ]; then S3_BAD="${S3_BAD}$GUARDIAN_HOME/$d is a symlink"$'\n'
  elif [ -e "$GUARDIAN_HOME/$d" ]; then
    if [ ! -d "$GUARDIAN_HOME/$d" ]; then S3_BAD="${S3_BAD}$GUARDIAN_HOME/$d is not a directory"$'\n'
    elif [ "$(/usr/bin/stat -f '%u' "$GUARDIAN_HOME/$d" 2>/dev/null)" != "$ME_UID" ]; then S3_BAD="${S3_BAD}$GUARDIAN_HOME/$d is not owned by this user"$'\n'; fi
  fi
done
if [ -n "$S3_BAD" ]; then
  if [ "$DRY" -eq 1 ]; then printf '%s' "$S3_BAD" | sed 's/^/DRY-RUN: would refuse: /'; else printf '%s' "$S3_BAD" | sed 's/^/refusing: /' >&2; fi
  exit 2
fi

# R14 A2: GUARDIAN_HOME is the conf's parent directory. The agent rejects a conf whose directory is group/world-writable or carries an ACL, so make it 0700, no ACL
# (an inheritable ACL on the parent would otherwise be copied onto it), before anything else is created inside it.
do_it mkdir -p "$GUARDIAN_HOME"
do_it chmod 700 "$GUARDIAN_HOME"
do_it /bin/chmod -N "$GUARDIAN_HOME"
# R15: bin/ and lib/ are the code the agent runs: never a symlink (a link would send the copy elsewhere)
for d in bin lib; do
  if [ -L "$GUARDIAN_HOME/$d" ]; then echo "refusing: $GUARDIAN_HOME/$d is a symlink; move it aside" >&2; exit 2; fi
done
do_it mkdir -p "$GUARDIAN_HOME/bin" "$GUARDIAN_HOME/lib" "$GUARDIAN_HOME/state" "$GUARDIAN_HOME/flags" "$GUARDIAN_HOME/keys" "$LA_DIR" || { echo "failed: mkdir under $GUARDIAN_HOME" >&2; exit 1; }
do_it chmod 700 "$GUARDIAN_HOME/keys" || { echo "failed: chmod 700 keys/" >&2; exit 1; }
# R15: state/ and flags/ are the agent's own: not group/world-writable, no inherited ACL (an earlier umask-000 install left them 0777). R15b: each rc is checked.
do_it /bin/chmod go-w "$GUARDIAN_HOME/state" "$GUARDIAN_HOME/flags" || { echo "failed: chmod go-w state/ flags/" >&2; exit 1; }
do_it /bin/chmod -N "$GUARDIAN_HOME/state" "$GUARDIAN_HOME/flags" "$GUARDIAN_HOME/keys" || { echo "failed: chmod -N state/ flags/ keys/" >&2; exit 1; }
copy_if_changed "$SRC/bin/guardian.sh" "$GUARDIAN_HOME/bin/guardian.sh" 755 || { echo "failed to install bin/guardian.sh" >&2; exit 1; }
for f in common conf collect killswitch faulttree heal probe canary; do copy_if_changed "$SRC/lib/$f.sh" "$GUARDIAN_HOME/lib/$f.sh" 644 || { echo "failed to install lib/$f.sh" >&2; exit 1; }; done
# R15: on every install, changed or not: bin/ and lib/ and the files under them lose group/world write and every ACL entry (an inherited everyone-write ACL survives a plain copy)
do_it /bin/chmod -R go-w "$GUARDIAN_HOME/bin" "$GUARDIAN_HOME/lib"
do_it /bin/chmod -RN "$GUARDIAN_HOME/bin" "$GUARDIAN_HOME/lib"

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

# R15: the installed tree must pass the check the agent runs on every tick; else it would run KILLED
if [ "$DRY" -ne 1 ]; then
  if ! ( G_TR=/usr/bin/tr; G_WC=/usr/bin/wc; G_HEAD=/usr/bin/head; G_STAT=/usr/bin/stat; G_LS=/bin/ls; G_ID=/usr/bin/id; G_CAT=/bin/cat; G_MKDIR=/bin/mkdir
         # shellcheck disable=SC2329
         audit() { :; }; . "$SRC/lib/conf.sh" && tree_check_paths "$GUARDIAN_HOME" "$GUARDIAN_HOME" || { echo "installed tree fails the agent's check: $G_TREE_WHY" >&2; exit 1; } ); then
    exit 1
  fi
fi

if [ "$LOAD" -eq 1 ]; then
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then echo "already loaded"; else do_it launchctl bootstrap "gui/$(id -u)" "$PLIST"; fi
else
  echo "agent NOT loaded. Load with: launchctl bootstrap gui/\$(id -u) \"$PLIST\"  (or re-run with --load)"
fi
echo "manual: sudoers NOPASSWD for $GUARDIAN_ROOT_HELPER only; Guardian starts in SHADOW; HEAL is set from the Mini."
