# herdr-ctl

A control script for an orchestrator to manage Claude Code agents running
inside `herdr` on V's Mac Mini, without ever touching the herdr TUI or the
`herdr` CLI's raw JSON directly.

Location: `/Users/vinaybhardwaj/dev/eta-lab/kit/herdr-ctl.sh` (a compat symlink
also resolves at `/Users/vinaybhardwaj/dev/_fable/herdr-ctl.sh`)

## The run_on `true; ` quirk

If you invoke this over the `tailscale-shell run_on` MCP tool, the FIRST
command on the line has its arguments silently dropped. Always prefix with
`true; `, e.g.:

```
true; /bin/zsh /Users/vinaybhardwaj/dev/eta-lab/kit/herdr-ctl.sh status
```

Never call the script with a bare command as the first token in a `run_on`
call — it will run with no arguments. This is a `run_on` artifact, not a
herdr-ctl bug.

Also: `minidisk write_file` clears the executable bit on every write, so
always invoke the script as `/bin/zsh herdr-ctl.sh ...`, never
`./herdr-ctl.sh ...`.

## Usage

```
/bin/zsh herdr-ctl.sh [--session NAME] [--dry-run] <subcommand> ...
```

- `--session NAME` — target a named herdr session instead of the live
  default session (e.g. `--session ctl-test`). Must come before the
  subcommand.
- `--dry-run` — print what the subcommand would do (including the herdr
  calls it would make) without sending anything. Also before the
  subcommand.

Every mutating action appends one line to
`/Users/vinaybhardwaj/dev/eta-lab/scratch/herdr-ctl.log`:
`TIMESTAMP | sess=SESSION | SUBCOMMAND | TARGET | RESULT`.

A small JSON registry at `/Users/vinaybhardwaj/dev/eta-lab/kit/herdr-registry.json`
tracks, per session name, each agent's `pane_id`, `cwd`, `session_id`,
`model`, and `task` tag. `status` refreshes `pane_id`/`cwd`/`session_id` for
every live agent on each run; `model` and `task` are written by the `model`
and `tag` subcommands (and by `spawn`).

## Subcommands

### `status`

One row per live agent (name, pane, lifecycle state, BUSY, CTX, UPDATE,
model, task), plus a full JSON dump written to
`scratch/herdr-status.json`. Read-only — safe to run against the live
default session any time.

- **BUSY** — the pane's footer mentions a nonzero count of background
  shells or monitors (`"N shell(s)"` / `"N monitor(s)"`, or the
  `"N shells still running"` line shown next to a `done` status). Parsed
  from `herdr pane read --source recent-unwrapped --lines 50`.
- **CTX** — the `/clear to save NNNk tokens` hint from the footer, if
  present, shown as `NNNk`.
- **UPDATE** — the footer shows `Restart to update`.
- **MODEL** — from the registry (herdr does not reliably surface the
  active model in the pane text); `?` if never recorded.
- **TASK** — the last `tag` set for that agent in this session, or `-`.

Column widths in the printed table cap around ~7-8 chars; the JSON in
`scratch/herdr-status.json` has the untruncated values.

### `send NAME "MSG"`

`herdr agent prompt NAME "MSG"` (no `--wait`). Logs the returned
`type`/`code` the same way `hsend.sh` does. No refusal rules beyond
"agent must exist" (exit 4 if unknown).

### `tag NAME "TASK"`

Display-only. Sets the pane's title via
`herdr pane report-metadata PANE --source herdr-ctl --title "TASK"` and
stores `TASK` in the registry. **Never** renames the agent (`herdr agent
rename` is never called) — dispatch by name must stay stable.

### `compact NAME`

Refuses unless the agent is `idle` or `done`, not `blocked`, and not
BUSY. Sends `/compact`, then `herdr agent wait NAME --timeout 600000`,
then reports the CTX hint before and after.

**Observed quirk:** herdr's lifecycle classifier does not always treat
the compaction progress bar as "working", so `agent wait` can return
before the compaction animation finishes on screen. The compaction itself
still completes correctly in the background (verified in testing); the
before/after context-hint report can occasionally be captured slightly
early. Harmless, but don't treat the "after" number as gospel if it looks
unchanged from "before".

### `clear NAME --ledger-ok`

Same refusals as `compact`, **plus** it refuses without the literal
`--ledger-ok` flag (a distinct exit-3 refusal, checked before dry-run/send
so it fires even in dry-run mode... actually dry-run is checked after —
see Refusal order below). This exists so nothing gets `/clear`ed without
a human/orchestrator having confirmed a ledger entry was made first.
Sends `/clear` on success.

### `model NAME MODEL`

`MODEL` must be one of `sonnet|opus|haiku`, else exit 2 (usage error, not
a safety refusal). Same refusals as `compact`. Sends `/model MODEL`
directly — Claude Code applies it immediately with no further
interaction needed (confirmed in testing: `/model sonnet` and
`/model haiku` both applied instantly, no picker menu). Reports the pane
content after 2s so the confirmation line (`Set model to ... and saved as
your default for new sessions`) is visible, and stores the new model in
the registry.

### `restart NAME`

For picking up a Claude Code binary update. Same refusals as `compact`.

1. Records `pane_id`, `cwd`, `session_id` (from the live agent, not the
   registry — the registry can be stale, e.g. after a `/clear` changes
   the session id) and the registry's last known `model`.
2. Checks `herdr pane process-info` for `--dangerously-skip-permissions`
   in the current `claude` process's command line, so the flag is
   preserved (or not) on restart.
3. Sends `/exit`. Confirmed in testing: Claude Code's `/exit` prints
   "See ya!" and returns cleanly to the shell prompt — no ctrl-c fallback
   was needed in testing, but the script still polls
   `herdr pane process-info` for up to 20s waiting for the pane's
   foreground process to no longer be `claude`, and if it's still `claude`
   after 20s, sends `ctrl+c` twice and polls up to another 10s.
4. If the pane never reaches a shell prompt, it **stops and prints the
   exact pane state** (`process-info` + a `pane read`) rather than
   retrying blindly, per spec, and exits 1.
5. Otherwise runs
   `herdr agent start NAME --kind claude --pane PANE --timeout 120000 -- --resume SESSION_ID -n NAME [--model MODEL] [--dangerously-skip-permissions]`.
6. Verifies the agent comes back `idle`/`done` under the same `NAME`
   with the **same session id** before declaring success. Any mismatch
   is printed and the script exits 1 without retrying.

Verified end-to-end in testing: a haiku test agent was told `/exit`,
came back to the shell prompt, was restarted with
`--resume <same-session-id> -n ctltest --model haiku`, picked up a newer
Claude Code build (v2.1.280 vs. the v2.1.278 seen elsewhere), and resumed
with the same session id and full history intact.

### `transcript NAME [--tail N]`

Finds `~/.claude/projects/*/SESSION_ID.jsonl` for the agent's current
session id, extracts the last `N` (default 40) user/assistant turns —
skipping tool-result bodies (replaced with `[tool result omitted]`) but
keeping tool names (`[tool: Bash]` etc.) — and writes them as Markdown to
`scratch/transcripts/NAME-<timestamp>.md`. Prints only the file path,
message count, and file size — never the transcript body. Read-only
against the source session (only reads the JSONL file and the live agent
list to find the session id).

### `spawn NAME CWD MODEL [--skip-permissions]`

`herdr workspace create --label NAME --cwd CWD --no-focus`, then
`herdr agent start NAME --kind claude --pane PANE -- --model MODEL -n NAME [--dangerously-skip-permissions]`.
Records the new agent in the registry (`pane_id`, `cwd`, `session_id`,
`model`, empty `task`).

**Observed quirk:** the very first time Claude Code opens a `cwd` it
hasn't seen before, it shows an interactive "Do you trust this folder?"
dialog and `agent start` returns `agent_not_ready` (a `blocked` agent,
not a hard failure — the name is still usable for `agent get`/`agent
read`/`agent send-keys`). `spawn` does not auto-answer this dialog (it
would be unsafe to blindly accept trust prompts). If `spawn` reports the
agent is not yet visible after starting, resolve the dialog manually
(e.g. `herdr --session NAME agent send-keys AGENT down enter` to pick
"Yes, I trust this folder") and then re-run `status` — the registry can
be repaired by any subsequent `status` call, which refreshes
`pane_id`/`cwd`/`session_id` for any agent it can see.

## Refusal rules (exit codes)

- **Unknown agent name** → exit 4, always, for every subcommand that
  takes a `NAME`.
- **`compact` / `clear` / `model` / `restart`** refuse (exit 3, one-line
  reason on stderr) unless the agent's lifecycle state is `idle` or
  `done` — never `blocked`, `working`, or `unknown` — **and** the pane is
  not BUSY (no background shells/monitors still running, even if the
  lifecycle state itself says `done`/`idle`). This second check matters:
  Claude Code can report `done` while a backgrounded shell command is
  still running, and testing confirmed the BUSY refusal correctly fires
  in exactly that case.
- **`clear`** additionally refuses (exit 3) without the literal
  `--ledger-ok` flag, checked after the state/BUSY gate.
- **Bad `--model` value** (not `sonnet`/`opus`/`haiku`) → exit 2 (usage
  error, distinct from the safety-refusal exit 3).
- **`restart`** that can't get the pane back to a shell prompt, or whose
  post-restart state/session-id doesn't verify → exit 1, with the pane's
  exact state printed; it never retries automatically.
- **`spawn`** whose `workspace create` or `agent start` doesn't produce a
  visible, named agent → exit 1, with a pointer to check manually
  (e.g. a startup trust dialog).

`--dry-run` is checked **after** the state/BUSY/flag refusals for
`compact`/`clear`/`model`/`restart`, so a dry-run still tells you if the
action would have been refused, rather than pretending it would succeed.

## Examples

```bash
# Read-only: see everyone's state
/bin/zsh herdr-ctl.sh status

# Message one agent
/bin/zsh herdr-ctl.sh send eta-refuter "Any update on the levels re-check?"

# Tag what an agent is working on (display-only, no rename)
/bin/zsh herdr-ctl.sh tag scribe3 "overnight-translate round 3"

# Compact an idle agent
/bin/zsh herdr-ctl.sh compact refuter-gate

# Refused: agent is working or has background shells running
/bin/zsh herdr-ctl.sh compact fleet
#   refuse: fleet is BUSY (background shells or monitors still running in its pane)
#   (exit 3)

# Clear requires the explicit flag
/bin/zsh herdr-ctl.sh clear refuter-gate
#   refuse: clear refuter-gate requires --ledger-ok ...  (exit 3)
/bin/zsh herdr-ctl.sh clear refuter-gate --ledger-ok
#   cleared refuter-gate

# Switch a model
/bin/zsh herdr-ctl.sh model eta-assistant sonnet

# Restart to pick up a Claude Code update
/bin/zsh herdr-ctl.sh restart eta-refuter

# Pull a recent transcript
/bin/zsh herdr-ctl.sh transcript eta-refuter --tail 30

# Spawn a new agent in an isolated named session
/bin/zsh herdr-ctl.sh --session ctl-test spawn ctltest /tmp haiku

# Dry-run before touching anything
/bin/zsh herdr-ctl.sh --dry-run restart fleet
```

## Safety notes for whoever runs this against the live default session

- `send`, `tag`, `compact`, `clear`, `model`, `restart` all mutate a live
  agent's pane. Always check `status` first and respect BUSY/state.
- Never pass a named test session's agent name against the default
  session by mistake — always pass `--session NAME` explicitly when
  targeting anything other than the live default 12-agent session.
- `restart` and `spawn` are the two subcommands that touch panes/workspaces
  most invasively; test them against `--session ctl-test` (or another
  throwaway named session) before ever pointing them at a live agent.
