#!/bin/zsh
# usage: hsend.sh "<message>" agent1 agent2 ...   (appends to scratch/hsend.log)
# Portable across the Mini (herdr in /opt/homebrew) and the box (herdr in
# ~/.local/bin, not on PATH by default -- confirmed live, 23 Sep) -- both
# added unconditionally; a nonexistent one is a silent no-op on the other host.
export PATH=/opt/homebrew/bin:$HOME/.local/bin:$PATH
M="$1"; shift
# realpath, not $(dirname "$0") or zsh's ${0:A:h}: eta-lab/hsend.sh at the repo root is a
# SYMLINK to kit/hsend.sh (found live by eta-refuter-2) -- dirname on an unresolved $0 gives the
# SYMLINK's directory (the repo root), not this script's real one, so invoking it as
# ~/dev/eta-lab/hsend.sh put the log at ~/dev/scratch/hsend.log, outside the repo. A zsh-only
# ${0:A:h} fix broke the same way again if this file is ever run via `bash hsend.sh` (found live
# right after fixing it that way -- bash doesn't understand :A:h and produced worse garbage than
# the original bug). realpath resolves symlinks identically under either interpreter.
O="$(dirname "$(realpath "$0")")/../scratch/hsend.log"
mkdir -p "$(dirname "$O")"
# PANES-TO-E2E move (23 Sep 2026): a herdr "machine" (e.g. eta-lab-t4) is a
# separate herdr server with its own agent namespace — a moved pane no
# longer shows up in the plain (Mini-local) `agent list` at all. Try local
# first (the common case), fall back to the box by name.
KNOWN_MACHINES=(eta-lab-t4)
for a in "$@"; do
  HFLAGS=()
  if ! herdr agent list 2>/dev/null | grep -q "\"name\":\"$a\""; then
    for m in $KNOWN_MACHINES; do
      if herdr --machine "$m" agent list 2>/dev/null | grep -q "\"name\":\"$a\""; then
        HFLAGS=(--machine "$m"); break
      fi
    done
  fi
  if [ "${#HFLAGS[@]}" = "0" ] && ! herdr agent list 2>/dev/null | grep -q "\"name\":\"$a\""; then
    echo "$(date '+%H:%M:%S') -> $a : unknown-agent (checked default + ${KNOWN_MACHINES[*]})" >> $O
    continue
  fi
  R=$(herdr "${HFLAGS[@]}" agent prompt "$a" "$M" 2>&1 | grep -o -E '"(type|code)":"[a-z_]*"' | tr '\n' ' ')
  echo "$(date '+%H:%M:%S') -> $a : $R" >> $O
done
