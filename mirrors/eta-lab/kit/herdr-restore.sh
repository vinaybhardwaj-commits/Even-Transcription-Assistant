#!/bin/zsh
# Restore every Claude Code session into herdr on the Mini.
# Safe to run any time: a session that is already live in herdr is SKIPPED, never restarted.
# Only needed if the Mini rebooted or the herdr server stopped. A dropped ssh from V's Air
# does NOT kill these sessions - they belong to the herdr server, not to the connection.
# usage:  /bin/zsh ~/dev/eta-lab/herdr-restore.sh
export PATH=/opt/homebrew/bin:$PATH
E=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant
H=/Users/vinaybhardwaj
T=(
  "eta-refuter|ETA-Refuter|$E|e5d1ef49-11d1-4be8-b60e-e84c4013a41b"
  # MOVED to eta-lab-t4 (PANES-TO-E2E.md stage 2, 23 Sep 2026 ~19:20): lives on the box now, not the Mini.
  # Restore the pane there with: herdr --machine eta-lab-t4 agent start fleet --kind claude --pane wB:p1 --timeout 120000 -- --resume 51df0efe-55e7-4a7a-afae-f4a920a646e6 -n fleet --model sonnet --permission-mode auto
  #"fleet|fleet|$E|51df0efe-55e7-4a7a-afae-f4a920a646e6"
  # fleet-watch (ruling 399, 25 Sep 2026): lives on eta-lab-t4 as its OWN herdr WORKSPACE "fleet-watch" (not a Claude session, nothing to --resume).
  # Restore it there with: bash $HOME/fleet-watch/herdr-start.sh   (idempotent: does nothing if the workspace exists; its pane runs pane-run.sh, which tails the logs if the loop already holds the lock, else starts the loop; ~/fleet-watch/MODE = dry|live)
  # MOVED to eta-lab-t4 (PANES-TO-E2E.md stage 2, 23 Sep 2026 ~18:00): lives on the box now, not the Mini.
  # Restore the pane there with: herdr --machine eta-lab-t4 agent start lx --kind claude --pane w9:p1 --timeout 120000 -- --resume 59f6f674-d26e-4e34-b26b-4f8b0afaf2a3 -n lx --model opus --permission-mode auto
  #"lx|lx|$E-linux-bootstrap|59f6f674-d26e-4e34-b26b-4f8b0afaf2a3"
  # MOVED to eta-lab-t4 (PANES-TO-E2E.md stage 2, 23 Sep 2026 ~17:45): lives on the box now, not the Mini.
  # Restore the pane there with: herdr --machine eta-lab-t4 agent start scribe --kind claude --pane w7:p1 --timeout 120000 -- --resume decbfc3a-582a-43f0-9cce-c6d195def34e -n scribe --model opus --permission-mode auto
  #"scribe|scribe|$E|decbfc3a-582a-43f0-9cce-c6d195def34e"
  # CLOSED 23-Sep (Fable) -- do not restore: "scribe3|scribe3|$E|aef14449-cd2b-4a1a-a38e-fbf4658ec178"
  # MOVED to eta-lab-t4 (PANES-TO-E2E.md stage 2, 23 Sep 2026 ~17:47): lives on the box now, not the Mini.
  # Restore the pane there with: herdr --machine eta-lab-t4 agent start split-speaker --kind claude --pane w8:p1 --timeout 120000 -- --resume 2f5b94c5-8b78-4006-9ea0-0a11a0163b0c -n split-speaker --model opus --permission-mode auto
  #"split-speaker|split-speaker|$E|2f5b94c5-8b78-4006-9ea0-0a11a0163b0c"
  # MOVED to eta-lab-t4 (PANES-TO-E2E.md stage 1, 23 Sep 2026 ~16:35): lives on the box now, not the Mini.
  # Restore it there with: herdr --machine eta-lab-t4 agent start yoga-drain --kind claude --pane w3:p1 --timeout 120000 -- --resume fdccb850-3bc4-4692-a053-c8fe7fad38ae -n yoga-drain --model sonnet --permission-mode auto
  #"yoga-drain|yoga-drain|$E|fdccb850-3bc4-4692-a053-c8fe7fad38ae"
  "minibot|minibot|$H/whisper.cpp|b015950d-b85b-4027-9cf6-127fb31c0e1a"  # cwd fixed 24-Sep (Fable): was $H, real project is whisper.cpp; pane also moved wF:p1->wT:p1 during the 24-Sep fix
  # CLOSED 23-Sep (Fable) -- do not restore: "minibot-2|minibot-2|$H|3290ce50-1144-4b87-81c3-283aa8f79caa"
  # CLOSED 23-Sep (Fable) -- do not restore: "refuter-gate|refuter-gate|$E|ea785bab-d969-4057-b766-192db6b2e229"
  "herdr-kit|herdr-kit|$H/dev/eta-lab|7708e3d7-39ce-4b93-9c60-a6a17c04fb7e"
  # MOVED to eta-lab-t4 (PANES-TO-E2E.md stage 1, 23 Sep 2026 ~16:42): lives on the box now, not the Mini.
  # 2 background shells (a port-8087 check, a cd into a worktree scratchpad) were NOT killed on the Mini —
  # moved to a Claude Code background session instead, id dd7d5507 (`claude logs dd7d5507` / `claude stop
  # dd7d5507` on the Mini); indic-mt or Fable should confirm whether either is still needed.
  # Restore the pane there with: herdr --machine eta-lab-t4 agent start indic-mt --kind claude --pane w5:p1 --timeout 120000 -- --resume 095ca91a-8b3d-4d6c-989a-efb6e2f2f17f -n indic-mt --model sonnet --dangerously-skip-permissions
  #"indic-mt|indic-mt|$H/dev/eta-lab|095ca91a-8b3d-4d6c-989a-efb6e2f2f17f"
  # MOVED to eta-lab-t4 (PANES-TO-E2E.md stage 1, 23 Sep 2026 ~16:39): lives on the box now, not the Mini.
  # A GPU-watcher background shell it had running on the MINI was NOT killed (moved to a Claude Code
  # background session instead, id 10de3cf5 — `claude logs 10de3cf5` / `claude stop 10de3cf5` on the Mini);
  # diar-lab or Fable should confirm whether that Mini-side watcher is still needed now that diar-lab itself
  # is on the box.
  # Restore the pane there with: herdr --machine eta-lab-t4 agent start diar-lab --kind claude --pane w4:p1 --timeout 120000 -- --resume 0ecd451f-c4f6-4c3a-af94-dc080559f001 -n diar-lab --model sonnet --dangerously-skip-permissions
  #"diar-lab|diar-lab|$H/dev/eta-lab|0ecd451f-c4f6-4c3a-af94-dc080559f001"
  # MOVED to eta-lab-t4 (PANES-TO-E2E.md stage 2, 23 Sep 2026 ~17:37): lives on the box now, not the Mini.
  # Restore the pane there with: herdr --machine eta-lab-t4 agent start lab-mover --kind claude --pane w6:p1 --timeout 120000 -- --resume 0a4388cc-1a6a-4a1e-af2d-fc4b2fbd6eb3 -n lab-mover --model sonnet --dangerously-skip-permissions
  #"lab-mover|lab-mover|$H/dev|0a4388cc-1a6a-4a1e-af2d-fc4b2fbd6eb3"
  # CLOSED 23-Sep (Fable) -- do not restore: "eta-assistant|eta-assistant|$E|7b267c55-9d09-4574-8781-946206d65db7"
  # eta-refuter-2 (second Opus Refuter, added 23 Sep): lives on eta-lab-t4 only, never had a Mini pane.
  # Restore the pane there with: herdr --machine eta-lab-t4 agent start eta-refuter-2 --kind claude --pane wD:p1 --timeout 120000 -- --resume 38fee64c-7cbd-499e-9f3e-7a43c7cd3a10 -n eta-refuter-2 --model opus --permission-mode auto
  #"eta-refuter-2|eta-refuter-2|$E|38fee64c-7cbd-499e-9f3e-7a43c7cd3a10"
)
# BUSY as of 24-Sep ~05:xx IST (own background job): diar-lab (w4:p1, GPU/CI monitor), fleet (wB:p1, Metabase
# probe loop), split-speaker (w8:p1, watch.py). Do not restart any of these three via herdr-ctl.sh or the
# commands above until the job has finished or been handed over -- restarting mid-job kills it.
if ! herdr status server >/dev/null 2>&1; then
  echo "herdr server not running - starting it"
  nohup herdr server >/dev/null 2>&1 &
  sleep 3
fi
LIVE=$(herdr agent list 2>/dev/null | python3 -c "
import json,sys
try: a=json.load(sys.stdin)['result']['agents']
except Exception: a=[]
print(' '.join(x.get('name','') for x in a))")

# H1 fix, applied here too (23 Sep, E2E-LAB-BOX order): a `--resume SESSION`
# launch with no explicit --model silently comes back on Claude Code's
# GLOBAL DEFAULT model, not whatever that session actually last ran as —
# the exact bug the herdr-ctl.sh fix rounds spent four rounds closing there.
# This script never got that fix. Read each session's own last assistant
# model from its transcript before resuming it; refuse to guess if unknown.
model_for_session() { # $1=session id -> short model name or empty
  local sess="$1" file
  file=$(zsh -c 'setopt nullglob; for f in ~/.claude/projects/*/'"$sess"'.jsonl; do print -r -- $f; done' | head -1)
  [ -z "$file" ] && return
  python3 -c '
import json,sys
model=None
with open(sys.argv[1], encoding="utf-8", errors="replace") as f:
    for line in f:
        line=line.strip()
        if not line: continue
        try: o=json.loads(line)
        except Exception: continue
        if o.get("type")=="assistant":
            m=(o.get("message") or {}).get("model")
            if m: model=m
short=""
if model:
    ml=model.lower()
    if "haiku" in ml: short="haiku"
    elif "sonnet" in ml: short="sonnet"
    elif "opus" in ml: short="opus"
print(short)
' "$file"
}

for row in $T; do
  N=${row%%|*}; r=${row#*|}; L=${r%%|*}; r=${r#*|}; C=${r%%|*}; S=${r#*|}
  if [[ " $LIVE " == *" $N "* ]]; then echo "live     $N"; continue; fi
  if pgrep -f "claude --resume $S" >/dev/null; then echo "RUNNING OUTSIDE HERDR  $N  (session $S) - left alone, tell Fable"; continue; fi
  MODEL=$(model_for_session "$S")
  if [ -z "$MODEL" ]; then
    echo "SKIPPED  $N  (session $S) - could not read its last model from the transcript; refusing to guess, tell Fable"
    continue
  fi
  R=$(herdr workspace create --label "$L" --cwd "$C" --no-focus 2>&1)
  P=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['root_pane']['pane_id'])" 2>/dev/null)
  [ -z "$P" ] && { echo "FAILED   $N  workspace: $R"; continue; }
  sleep 2
  herdr agent start "$N" --kind claude --pane "$P" --timeout 120000 -- --resume "$S" -n "$L" --model "$MODEL" >/dev/null 2>&1
  echo "restored $N  model=$MODEL (rc=$?)"
done

# ---------------------------------------------------------------------------------------------------------------
# OpenCode panes ("<name>-oc"), W25 (Fable r407 + the 25 Sep bus-identity finding, proven on linker-oc #2553).
# An OpenCode pane has NO bus identity until BOTH of these hold:
#   (1) `herdr integration install opencode` is installed on THIS machine (status line says "opencode: current"), and
#   (2) the pane is NAMED with `herdr agent rename <pane> <name>` and OpenCode is then RESTARTED, so the eta-bus MCP
#       re-resolves its identity from HERDR_PANE_ID. A pane that was started before it was named stays anonymous.
# Rows: "name-oc|workspace label|cwd|provider/model|opencode session id".  The session id is printed by `/exit`
# ("Continue  opencode -s ses_..."). Resume flags: -s <id>, -m <provider/model>. Never give the model a secret path.
# UNTESTED end to end (first real use is the first W25 switch): the relaunch-after-rename below follows Fable's proven
# sequence; if `agent start NAME` already names the pane before OpenCode starts, the second launch is a no-op restart.
# BOX panes (18 switched 25 Sep, Fable r409) are restored by kit/oc-restore.sh from ~/oc/REGISTRY.tsv (kept current by kit/oc-registry-snapshot.sh); this section is for Mini -oc panes.
# Empty until a pane is switched (nothing has been moved yet: P0). Add rows here in the same change as the switch.
O=(
  # "linker-oc|linker-oc · link 3 · box|/home/eta/dev/eta-lab|opencode/gpt-5.3-codex|ses_XXXX"   # box pane: restore there, not here
)
if [ ${#O} -gt 0 ]; then
  herdr integration status 2>/dev/null | grep -q '^opencode: current' || {
    echo "opencode integration not current: installing (writes ~/.config/opencode/plugins/herdr-agent-state.js, herdr-tui-session.js, tui.jsonc)"
    herdr integration install opencode
  }
  for row in $O; do
    N=${row%%|*}; r=${row#*|}; L=${r%%|*}; r=${r#*|}; C=${r%%|*}; r=${r#*|}; M=${r%%|*}; S=${r#*|}
    if [[ " $LIVE " == *" $N "* ]]; then echo "live     $N"; continue; fi
    if pgrep -f "opencode.* -s $S" >/dev/null; then echo "RUNNING OUTSIDE HERDR  $N  (session $S) - left alone, tell Fable"; continue; fi
    R=$(herdr workspace create --label "$L" --cwd "$C" --no-focus 2>&1)
    P=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['root_pane']['pane_id'])" 2>/dev/null)
    [ -z "$P" ] && { echo "FAILED   $N  workspace: $R"; continue; }
    sleep 2
    herdr agent start "$N" --kind opencode --pane "$P" --timeout 120000 -- -s "$S" -m "$M" >/dev/null 2>&1
    herdr agent rename "$P" "$N" >/dev/null 2>&1          # step (2a): name the pane
    herdr agent prompt "$N" '/exit' >/dev/null 2>&1        # step (2b): stop OpenCode so the bus MCP restarts with the name
    sleep 4
    herdr agent start "$N" --kind opencode --pane "$P" --timeout 120000 -- -s "$S" -m "$M" >/dev/null 2>&1
    echo "restored $N  model=$M session=$S (rc=$?)  - check bus identity: bus_roster must list $N"
  done
fi
