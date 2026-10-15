#!/bin/bash
# shellcheck disable=SC2034,SC2154
# Kiosk Guardian: guardian.conf as DATA (R12). The file is never sourced and never evaluated. bash 3.2 compatible, pure bash plus the pinned tr/head/ls/stat.
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
# R14 A1: and carry no ACL entry at all (an ACL can make a 0600 file writable by others). R14 A2: and its parent directory (and GUARDIAN_HOME) must be owned by
# root or the agent, not group- or world-writable, and carry no ACL either; else a file in a writable directory could be swapped under the checks.
# Otherwise a hard stop like the size cap: no key is read, G_CONF_BAD=1, one audit line "conf rejected: <symlink|not regular|owner|mode|acl|dir>" (never a path's contents).
# rc 0 = acceptable. macOS stat -f first, GNU stat -c as the fallback for a portable harness. A path that does not exist is left to conf_load's own "unreadable".
# conf_path_stat <path> <L|P>: prints "uid mode type" (L follows a symlink, for the directory checks; P does not). rc 1 when stat cannot say.
conf_path_stat() {
  local f="$1" fl="" out
  [ "$2" = L ] && fl="-L"
  # shellcheck disable=SC2086
  out="$("$G_STAT" $fl -f '%u %Lp %HT' "$f" 2>/dev/null)" || out=""
  # shellcheck disable=SC2086
  if [ -z "$out" ]; then out="$("$G_STAT" $fl -c '%u %a %F' "$f" 2>/dev/null)" || out=""; fi
  [ -n "$out" ] || return 1
  printf '%s' "$out"
}
# conf_has_acl <path>: rc 0 when `ls -led` shows any line after the first (an ACL entry). If ls cannot say, the answer is "yes" (fail closed).
conf_has_acl() {
  local out n
  out="$("$G_LS" -ledL "$1" 2>/dev/null)" || return 0
  [ -n "$out" ] || return 0
  n="$(printf '%s\n' "$out" | "$G_WC" -l | "$G_TR" -d ' ')"
  [ "${n:-2}" -gt 1 ]
}
# conf_dir_ok <dir>: 0 when the directory is root- or agent-owned, not group/world-writable, no ACL.
conf_dir_ok() {
  local out uid mode typ me g o
  out="$(conf_path_stat "$1" L)" || return 1
  uid="${out%% *}"; out="${out#* }"; mode="${out%% *}"; typ="${out#* }"
  case "$typ" in [Dd]irectory*) ;; *) return 1 ;; esac
  me="$("$G_ID" -u)"
  case "$uid" in ''|*[!0-9]*) return 1 ;; esac
  if [ "$uid" != 0 ] && [ "$uid" != "$me" ]; then return 1; fi
  case "$mode" in ''|*[!0-7]*) return 1 ;; esac
  mode=$((8#$mode)); g=$(((mode >> 3) & 7)); o=$((mode & 7))
  if [ $((g & 2)) -ne 0 ] || [ $((o & 2)) -ne 0 ]; then return 1; fi
  if conf_has_acl "$1"; then return 1; fi
  return 0
}
conf_perms_ok() { # <file>
  local f="$1" out typ uid mode me g o d
  { [ -e "$f" ] || [ -L "$f" ]; } || return 0
  out="$(conf_path_stat "$f" P)" || out=""
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
  if conf_has_acl "$f"; then conf_reject "acl"; return 1; fi
  case "$f" in */*) d="${f%/*}"; [ -n "$d" ] || d=/ ;; *) d=. ;; esac
  if ! conf_dir_ok "$d"; then conf_reject "dir"; return 1; fi
  if [ -n "${GUARDIAN_HOME:-}" ] && [ "$GUARDIAN_HOME" != "$d" ] && ! conf_dir_ok "$GUARDIAN_HOME"; then conf_reject "dir"; return 1; fi
  return 0
}
conf_reject() { CONF_ERR_N=$((CONF_ERR_N + 1)); G_CONF_BAD=1; audit "conf rejected: $1"; }

# conf_load <file> [noperm]: parse and apply. rc 0 only when the whole file was clean. "noperm" (install.sh's lint of a --config source) skips the owner/mode check.
conf_load() {
  local LC_ALL=C
  local file="$1" line key val inner lineno=0 seen=" " content rdrc
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
  # R14 A2: the file is opened ONCE, here. Its bytes (at most 16 KiB + 1, NUL mapped to 0x01 because bash drops NUL) are read into memory in one read;
  # the size, byte and parse checks all run on that copy, never on the path again. The trailing "x<rc>" keeps trailing newlines and the reader's status.
  content="$("$G_HEAD" -c 16385 2>/dev/null <"$file" | "$G_TR" '\000' '\001'; printf 'x%s' "${PIPESTATUS[0]}")"
  rdrc="${content##*x}"; content="${content%x"$rdrc"}"
  if [ "$rdrc" != 0 ]; then conf_err 0 "unreadable"; return 1; fi
  if [ "${#content}" -gt 16384 ]; then conf_err 0 "file over 16 KiB"; return 1; fi
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
  done <<<"$content"
  [ "$CONF_ERR_N" -eq 0 ]
}

# ---- R15 (G14-3 i, ii): the code tree and every ancestor of it ----
# The agent's code directory and its ancestors must not be writable by anyone but the agent and root, else another uid could rename the directory and plant bin/guardian.sh.
# One scanner serves the installer (which repairs what the agent user owns and refuses the rest) and the agent (which is killed on any finding). Read-only.
# tree_node and tree_walk_anc print findings as "CLASS|what" and "CLASS|what|path": X = not repairable by the installer (refuse), R = owned by the agent user, repairable.

# tree_acl_list <path> <anc|strict>: prints the index of each ACL entry that is not acceptable, one per line; "?" when ls cannot say (fail closed).
# anc: the macOS default entry "group:everyone deny delete" is acceptable. strict: any entry is not.
tree_acl_list() {
  local out line n=0 txt idx
  out="$("$G_LS" -led "$1" 2>/dev/null)" || { echo '?'; return 0; }
  [ -n "$out" ] || { echo '?'; return 0; }
  while IFS= read -r line; do
    n=$((n + 1))
    [ "$n" -gt 1 ] || continue
    txt="${line#"${line%%[![:space:]]*}"}"
    idx="${txt%%:*}"
    case "$idx" in ''|*[!0-9]*) echo '?'; continue ;; esac
    if [ "$2" = anc ] && [ "${txt#*: }" = "group:everyone deny delete" ]; then continue; fi
    echo "$idx"
  done <<<"$out"
}

# tree_node <path> <d|f> <anc|strict>: no output = acceptable. A symlink is never acceptable, except a root-owned one on an ancestor path (/var, /tmp, /etc on macOS).
tree_node() {
  local p="$1" want="$2" kind="$3" out uid mode typ me g o acl
  out="$(conf_path_stat "$p" P)" || { echo "X|stat"; return 0; }
  uid="${out%% *}"; out="${out#* }"; mode="${out%% *}"; typ="${out#* }"
  case "$typ" in
    [Ss]ymbolic*|[Ss]ymlink*)
      if [ "$kind" = anc ] && [ "$uid" = 0 ]; then return 0; fi
      echo "X|symlink"; return 0 ;;
  esac
  case "$want" in
    d) case "$typ" in [Dd]irectory*) ;; *) echo "X|not a directory"; return 0 ;; esac ;;
    f) case "$typ" in [Rr]egular*) ;; *) echo "X|not a regular file"; return 0 ;; esac ;;
  esac
  me="$("$G_ID" -u)"
  case "$uid" in ''|*[!0-9]*) echo "X|owner"; return 0 ;; esac
  if [ "$uid" != 0 ] && [ "$uid" != "$me" ]; then echo "X|owner"; return 0; fi
  case "$mode" in ''|*[!0-7]*) echo "X|mode"; return 0 ;; esac
  mode=$((8#$mode)); g=$(((mode >> 3) & 7)); o=$((mode & 7))
  if [ $((g & 2)) -ne 0 ] || [ $((o & 2)) -ne 0 ]; then
    if [ "$uid" = 0 ]; then echo "X|writable"; else echo "R|writable"; fi
    return 0
  fi
  acl="$(tree_acl_list "$p" "$kind" | "$G_TR" '\n' ' ')"
  if [ -n "${acl// /}" ]; then
    if [ "$uid" = 0 ]; then echo "X|acl"; else echo "R|acl:${acl% }"; fi
  fi
  return 0
}

# tree_walk_chain <absolute path> <allow-missing 0|1>: every prefix of the path from / down, each through tree_node (anc). The path itself is included.
tree_walk_chain() {
  local p="$1" miss="$2" cur="" rest comp r
  rest="${p#/}"
  r="$(tree_node / d anc)"; [ -z "$r" ] || echo "$r|/"
  while [ -n "$rest" ]; do
    case "$rest" in */*) comp="${rest%%/*}"; rest="${rest#*/}" ;; *) comp="$rest"; rest="" ;; esac
    case "$comp" in '') continue ;; .) continue ;; ..) echo "X|dot-dot component|$p"; return 0 ;; esac
    cur="$cur/$comp"
    if [ ! -e "$cur" ] && [ ! -L "$cur" ]; then
      [ "$miss" = 1 ] || echo "X|missing|$cur"
      return 0
    fi
    r="$(tree_node "$cur" d anc)"; [ -z "$r" ] || echo "$r|$cur"
  done
  return 0
}

# tree_walk_anc <absolute path> [allow-missing]: the logical chain, then (when a link was crossed) the physical chain of the nearest existing directory.
# A root-owned link is followed and its target is walked too. An agent-owned link on the way is refused.
tree_walk_anc() {
  local p="$1" miss="${2:-0}" ex phys
  case "$p" in /*) ;; *) echo "X|not absolute|$p"; return 0 ;; esac
  tree_walk_chain "$p" "$miss"
  ex="$p"
  while [ ! -d "$ex" ] && [ "$ex" != / ] && [ -n "$ex" ]; do ex="${ex%/*}"; done
  [ -n "$ex" ] || ex=/
  phys="$(cd -P "$ex" 2>/dev/null && pwd -P)" || phys=""
  if [ -z "$phys" ]; then echo "X|unresolvable|$ex"; return 0; fi
  if [ "$phys" != "$ex" ]; then tree_walk_chain "$phys" 0; fi
  return 0
}

# tree_check_paths <code dir> <agent home>: rc 0 when the code directory, bin/, lib/, each file the agent sources or runs from its tree (strict: regular file or directory,
# owner root or the agent, not group/world-writable, no ACL at all) and every ancestor of the code directory and of the agent home (tree_walk_anc) pass. Sets G_TREE_WHY on a finding.
tree_check_paths() {
  local here="$1" home="$2" rel p r f first
  G_TREE_WHY=""
  for rel in "" bin lib; do
    p="$here${rel:+/$rel}"
    r="$(tree_node "$p" d strict)"
    if [ -n "$r" ]; then G_TREE_WHY="dir ${r#*|}: ${rel:-.}"; return 1; fi
  done
  for f in bin/guardian.sh lib/common.sh lib/conf.sh lib/collect.sh lib/killswitch.sh lib/faulttree.sh lib/heal.sh lib/probe.sh lib/canary.sh; do
    p="$here/$f"
    # an older install has no canary.sh and the tick then skips it
    if [ "$f" = lib/canary.sh ] && [ ! -e "$p" ] && [ ! -L "$p" ]; then continue; fi
    r="$(tree_node "$p" f strict)"
    if [ -n "$r" ]; then G_TREE_WHY="file ${r#*|}: $f"; return 1; fi
  done
  first="$(tree_walk_anc "$here" 0 | "$G_HEAD" -n1)"
  if [ -z "$first" ] && [ "$home" != "$here" ]; then first="$(tree_walk_anc "$home" 0 | "$G_HEAD" -n1)"; fi
  if [ -n "$first" ]; then
    r="${first#*|}"
    G_TREE_WHY="ancestor ${r%%|*}: ${r#*|}"
    return 1
  fi
  return 0
}

# tree_check: the agent's run-time self-check, called at start and on every tick before any act path. Run mode only; library tests skip it (G_TREE_BAD=0).
# G_TREE_BAD is 1 until the check passes, so a path that never ran it is killed too. One audit line per state change, never per tick.
tree_check() {
  local cur prev f="$STATE_DIR/tree_state"
  if [ "${G_RUNMODE:-}" != 1 ]; then G_TREE_BAD=0; return 0; fi
  # shellcheck disable=SC2153
  if tree_check_paths "$HERE" "$GUARDIAN_HOME"; then G_TREE_BAD=0; cur="ok"; else G_TREE_BAD=1; cur="bad $G_TREE_WHY"; fi
  "$G_MKDIR" -p "$STATE_DIR" 2>/dev/null
  prev="$("$G_CAT" "$f" 2>/dev/null)"
  if [ "$prev" != "$cur" ]; then
    printf '%s\n' "$cur" >"$f" 2>/dev/null
    audit "code tree check ${prev:-none} -> $cur"
  fi
  [ "$G_TREE_BAD" = 0 ]
}
