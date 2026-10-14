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
# first (the common case), fall back to the other machines.
#
# FABLE 430(1): eta-ci-c3 and the rest of the fleet added, BY ID -- `herdr machine list`'s label
# for several of these (e.g. "eta-ci-c3 · E2E 24-core") is not what `--machine` accepts; the short
# name does not resolve (confirmed live). The id (a plain hex string) has no spaces or punctuation
# to quote correctly in this array, unlike the label. eta-lab-t4 is left as its existing working
# name -- not broken, not touched.
#
# eta-refuter-2 #3512: these ids are Mini-local (this host's own saved SSH machines, from `herdr
# machine list` on the Mini) -- the box's herdr has NO saved machines at all ("No saved SSH
# machines"), so this array is a no-op when this script runs on the box; reaching c3/hf-1/hf-2
# panes FROM the box needs `herdr machine add` there, a separate Fable-approved change, not this
# one. Mapping, so a reviewer never has to re-run `herdr machine list` to check an id:
#   85baa2e0f8428b0b03a3e8606f826e43 = eta-ci-c3 (E2E 24-core)
#   7a85bf5a3d2c157a56f679d63ed8e0e9 = hf-1 (Hugging Face Space)
#   04f2e17989784cd4a8e330f7ecf36d55 = hf-2 (Hugging Face Space)
#   20ed39e4a438a2d8c80db7011bc41e8a = orbox3
#   2d451dbd3f48fdd926db30924345abb1 = ehrc-audiometry
#   500d35dad11c282c0763c759f31ec947 = air
#   0901f12e74544272161d0b45a4bae75b = UbuntuYoga
KNOWN_MACHINES=(eta-lab-t4 85baa2e0f8428b0b03a3e8606f826e43 7a85bf5a3d2c157a56f679d63ed8e0e9 04f2e17989784cd4a8e330f7ecf36d55 20ed39e4a438a2d8c80db7011bc41e8a 2d451dbd3f48fdd926db30924345abb1 500d35dad11c282c0763c759f31ec947 0901f12e74544272161d0b45a4bae75b)
for a in "$@"; do
  # eta-refuter-2 #3512 ask 2 (checking every machine for every name, so a name found on two
  # machines at once is refused rather than silently sent to the first match): tried it, reverted
  # it -- it made every call pay for querying every machine, including the slow/SSH-tunneled ones
  # (hf-1/hf-2), so a single hsend to a purely local name like conductor could hang on a remote
  # machine being slow. Confirmed empirically live (a two-name test call did not return). First-
  # match-wins stands for now; a real fix needs a cheaper way to check for collisions (e.g. one
  # cached agent-list pass per machine, reused across all names in this invocation) -- flagged for
  # eta-refuter-2, not solved here. No collision exists today (checked live across all 8 machines
  # before this revert).
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
