# tailscale-shell run_on drops the FIRST command's arguments

Observed 23 Sep 2026 ~00:55 IST. Reproducible.

`run_on host=mini command="ls -l /path/file"` returns a listing of $HOME:
the leading `ls` keeps only its verb, both `-l` and the path are discarded.
Every command AFTER the first in the same line keeps its arguments.

Consequences seen tonight:
- `/bin/zsh /Users/.../dispatch.sh` ran as bare `/bin/zsh` on empty stdin:
  exit 0, ~150ms, NO OUTPUT and NOTHING SENT. Three agent prompts were
  silently lost for four minutes.
- `cd /path && ...` silently ran in $HOME.

## Rule
Always prefix the command with `true; `.

    true; /bin/zsh /Users/vinaybhardwaj/dev/_fable/dispatch.sh

A bare single-token path with no arguments (e.g. `/Users/.../d36.sh`) is
unaffected, because it has no arguments to lose.

## How to verify a dispatch actually landed
`hsend.sh` appends one timestamped line per agent to
`~/dev/_fable/scratch/hsend.log`. If the run produced no new lines in that
log, nothing was delivered - re-run with the `true; ` prefix.
