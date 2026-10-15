#!/bin/bash
# shellcheck disable=SC2034,SC2154
# Kiosk Guardian: guardian.conf as DATA (R12). The file is never sourced and never evaluated. bash 3.2 compatible, pure bash plus the pinned tr/wc.
#
# Accepted lines (leading blanks allowed), nothing else:
#   blank line, or a line whose first non-blank character is #
#   [export ]KEY=VALUE            KEY from the allow-list below
#     VALUE = 'single quoted' (no quote inside, taken literally)
#           | "double quoted" (\\ \" \$ \` are the only escapes; a bare $ or backtick inside is an error, so nothing is ever expanded)
#           | bare word (letters, digits and . _ / : @ + , = % -)
#     followed by optional blanks and an optional # comment
# Unknown key, bad value, duplicate key, an unreadable file, a file over 16 KiB, a line with a byte outside 0x20-0x7E and tab (that line only, R13), or any other line shape is a parse error.
# On any error G_CONF_BAD is set to 1 (readonly in run mode) and the Guardian runs KILLED: shadow, no actions, health still published.
# The valid lines of a bad file are still applied (each value passed its own check), so the room name and the publish command survive to report the fault.
# Each error is audited with its line number and the key name only, never the value.
#
# Trust boundary: this file is data. The code and the root helper are the trust boundary (README threat model).

CONF_ERR_N=0

conf_err() { # <line number> <what>
  CONF_ERR_N=$((CONF_ERR_N + 1)); G_CONF_BAD=1
  if [ "$CONF_ERR_N" -le 8 ]; then audit "conf error line=$1: $2"; fi
}

# conf_value_ok <key> <value>: 0 when the value passes the key's own regex. Patterns sit in variables (bash 3.2 =~ needs them unquoted).
conf_value_ok() {
  local k="$1" v="$2"
  local re_room='^[a-z0-9_-]{1,64}$'
  local re_cmd='^[[:print:]]+$'   # (macOS regex repeat counts stop at 255, so the length is checked apart)
  local re_sudo='^[A-Za-z0-9 ._/=:,+-]*$'
  local re_abs='^/[A-Za-z0-9 ._/+@-]{0,254}$'
  local re_pat='^[A-Za-z0-9 ._+()-]{1,64}$'
  local re_vol='^0\.[0-9]{1,2}$'
  local re_ssh='^[[:print:]]*$'
  case "$k" in
    GUARDIAN_ROOM) [[ $v =~ $re_room ]] ;;
    GUARDIAN_PUBLISH_CMD|GUARDIAN_SUBSCRIBE_CMD|GUARDIAN_CONTROL_SUB_CMD) [ "${#v}" -le 4096 ] && [[ $v =~ $re_cmd ]] ;;
    GUARDIAN_SUDO) [ "${#v}" -le 200 ] && [[ $v =~ $re_sudo ]] ;;
    GUARDIAN_ROOT_HELPER|PRESENCE_FILE)
      [[ $v =~ $re_abs ]] || return 1
      case "$v" in */..|*/../*|*/./*|*/.) return 1 ;; esac
      return 0 ;;
    USB_MIC_PATTERN) [[ $v =~ $re_pat ]] ;;
    CANARY_VOLUME) [[ $v =~ $re_vol ]] ;;
    GUARDIAN_PIPE_SSH) [ "${#v}" -le 2048 ] && [[ $v =~ $re_ssh ]] ;;
    *) return 1 ;;
  esac
}

conf_key_known() {
  case "$1" in
    GUARDIAN_ROOM|GUARDIAN_PUBLISH_CMD|GUARDIAN_SUBSCRIBE_CMD|GUARDIAN_CONTROL_SUB_CMD|GUARDIAN_SUDO|GUARDIAN_ROOT_HELPER|USB_MIC_PATTERN|CANARY_VOLUME|PRESENCE_FILE|GUARDIAN_PIPE_SSH) return 0 ;;
  esac
  return 1
}

# R13 (C3 rerun 11 MUST 2): the conf must be a regular file (lstat: not a symlink), owned by root or by the agent's own uid, and not group- or world-writable.
# Otherwise a hard stop like the size cap: no key is read, G_CONF_BAD=1, one audit line "conf rejected: <symlink|not regular|owner|mode>" (never a path's contents).
# rc 0 = acceptable. macOS stat -f first, GNU stat -c as the fallback for a portable harness. A path that does not exist is left to conf_load's own "unreadable".
conf_perms_ok() { # <file>
  local f="$1" out typ uid mode me g o
  { [ -e "$f" ] || [ -L "$f" ]; } || return 0
  out="$("$G_STAT" -f '%u %Lp %HT' "$f" 2>/dev/null)" || out=""
  if [ -z "$out" ]; then out="$("$G_STAT" -c '%u %a %F' "$f" 2>/dev/null)" || out=""; fi
  if [ -z "$out" ]; then conf_reject "not regular"; return 1; fi
  uid="${out%% *}"; out="${out#* }"; mode="${out%% *}"; typ="${out#* }"
  case "$typ" in [Ss]ymbolic*|[Ss]ymlink*) conf_reject "symlink"; return 1 ;; esac
  case "$typ" in [Rr]egular*) ;; *) conf_reject "not regular"; return 1 ;; esac
  me="$("$G_ID" -u)"
  case "$uid" in ''|*[!0-9]*) conf_reject "owner"; return 1 ;; esac
  if [ "$uid" != 0 ] && [ "$uid" != "$me" ]; then conf_reject "owner"; return 1; fi
  case "$mode" in ''|*[!0-7]*) conf_reject "mode"; return 1 ;; esac
  mode=$((8#$mode)); g=$(((mode >> 3) & 7)); o=$((mode & 7))
  if [ $((g & 2)) -ne 0 ] || [ $((o & 2)) -ne 0 ]; then conf_reject "mode"; return 1; fi
  return 0
}
conf_reject() { CONF_ERR_N=$((CONF_ERR_N + 1)); G_CONF_BAD=1; audit "conf rejected: $1"; }

# conf_load <file> [noperm]: parse and apply. rc 0 only when the whole file was clean. "noperm" (install.sh's lint of a --config source) skips the owner/mode check.
conf_load() {
  local LC_ALL=C
  local file="$1" line key val inner lineno=0 seen=" " size
  local re_line='^([[:space:]]*)(export[[:space:]]+)?([A-Z][A-Z0-9_]*)=(.*)$'
  local re_single="^'([^']*)'([[:space:]]*|[[:space:]]*#.*)\$"
  local re_double='^"(([^"\\]|\\.)*)"([[:space:]]*|[[:space:]]*#.*)$'
  local re_bare='^([A-Za-z0-9._/:@+,=%-]*)([[:space:]]*|[[:space:]]+#.*)$'
  local re_badbyte=$'[^[:print:]\t]'
  local re_bad_dq='(^|[^\\])(\\\\)*[$`]'
  CONF_ERR_N=0
  if [ "${2:-}" != noperm ]; then conf_perms_ok "$file" || return 1; fi
  if [ ! -f "$file" ] || [ ! -r "$file" ]; then
    # /dev/null and friends: a readable non-regular file is an empty config, not an error
    if [ -r "$file" ] && [ ! -d "$file" ]; then return 0; fi
    conf_err 0 "unreadable"; return 1
  fi
  size="$("$G_WC" -c <"$file" 2>/dev/null | "$G_TR" -d ' ')"
  case "$size" in ''|*[!0-9]*) conf_err 0 "size unreadable"; return 1 ;; esac
  if [ "$size" -gt 16384 ]; then conf_err 0 "file over 16 KiB"; return 1; fi
  # R13 S1: a byte error rejects only its own line (NUL is mapped to 0x01 first, because bash drops NUL on read, so the line check sees it).
  # The size cap above stays a hard stop.
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    if [[ $line =~ $re_badbyte ]]; then conf_err "$lineno" "byte outside 0x20-0x7E and tab (CR, NUL, high byte): line rejected"; continue; fi
    # blank, or a comment
    if [[ $line =~ ^[[:space:]]*(#.*)?$ ]]; then continue; fi
    if ! [[ $line =~ $re_line ]]; then conf_err "$lineno" "not KEY=VALUE"; continue; fi
    key="${BASH_REMATCH[3]}"; val="${BASH_REMATCH[4]}"
    if ! conf_key_known "$key"; then conf_err "$lineno" "key not allowed: $key"; continue; fi
    case "$seen" in *" $key "*) conf_err "$lineno" "duplicate key: $key"; continue ;; esac
    seen="$seen$key "
    if [[ $val =~ $re_single ]]; then
      inner="${BASH_REMATCH[1]}"
    elif [[ $val =~ $re_double ]]; then
      inner="${BASH_REMATCH[1]}"
      if [[ $inner =~ $re_bad_dq ]]; then conf_err "$lineno" "unescaped \$ or backtick in double quotes: $key"; continue; fi
      inner="${inner//\\\\/$'\x01'}"; inner="${inner//\\\"/\"}"; inner="${inner//\\\$/\$}"; inner="${inner//\\\`/\`}"
      inner="${inner//$'\x01'/\\}"
    elif [[ $val =~ $re_bare ]]; then
      inner="${BASH_REMATCH[1]}"
    else
      conf_err "$lineno" "bad value shape: $key"; continue
    fi
    if ! conf_value_ok "$key" "$inner"; then conf_err "$lineno" "value rejected: $key"; continue; fi
    printf -v "$key" '%s' "$inner"
    if [ "$key" = GUARDIAN_PIPE_SSH ]; then export GUARDIAN_PIPE_SSH; fi
  done < <("$G_TR" '\000' '\001' <"$file")
  [ "$CONF_ERR_N" -eq 0 ]
}
