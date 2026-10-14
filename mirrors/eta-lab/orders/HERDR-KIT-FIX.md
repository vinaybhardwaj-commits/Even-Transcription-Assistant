# herdr-ctl + eta-bus: fix round (Fable, 23 Sep 11:45)

You are the Builder (pane herdr-kit). Both tools FAILED review. Read the full verdict first:
/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/VERDICT.md
Code: /Users/vinaybhardwaj/dev/_fable/herdr-ctl.sh (+README, scratch/herdr-ctl-TEST.md) and
/Users/vinaybhardwaj/dev/eta-bus-mcp/ (server.mjs, lib/, test/, README, TEST-REPORT, PANE-PROTOCOL, FABLE-CONFIG).
herdr skill: /Users/vinaybhardwaj/dev/_fable/scratch/herdr-skill.md. You are inside herdr (HERDR_ENV=1).

Containment already done by Fable: eta-bus REMOVED from Claude Code user scope (do not re-add; Fable
does after the re-check). ~/.claude/settings.json model restored "haiku" -> "opus[1m]": the previous
Builder's ctl-test `/model haiku` rewrote the GLOBAL default - Claude Code's /model persists to
settings.json.

## HARD SAFETY RULES
- Send NO input of any kind to any agent in the default session other than yourself. Read-only
  (agent list/get/read, pane list/read) only.
- NEVER type /model anywhere, in any session - it rewrites the global default model.
- Mutating tests only in an isolated herdr session you create (`--session kit-test`), haiku agents
  started with an explicit --model flag; tear it down after. Never `herdr server stop` the default.
- Do not edit ~/.claude/settings.json or ~/.claude.json. Snapshot both (sha256) before and after
  your tests and prove they are unchanged.

## Rulings (settled - build exactly these)
herdr-ctl.sh
1. No /model path anywhere. `model NAME MODEL` = restart with --model MODEL (session-scoped).
2. restart: read the model from the agent's own session (last assistant turn's message.model in its
   transcript jsonl, mapped to a --model value) and the permission mode from the live process
   (command line, or the footer: "auto mode on" / "bypass permissions"); ALWAYS relaunch with
   --model and the matching permission flag (find the exact Claude Code flag for auto mode:
   `claude --help`). After relaunch VERIFY model and permission mode match; on mismatch exit
   non-zero - never "OK".
3. Per-agent lock (flock, /Users/vinaybhardwaj/dev/_fable/scratch/locks/NAME.lock) held by every
   mutating subcommand AND by send; re-check state (idle/done, not busy, not blocked) inside the
   lock immediately before typing.
4. Refuse if the agent's input box is not empty.
5. BUSY = footer line only, covering every wording the Refuter found ("background agent",
   shells, monitors, running tasks). If /exit opens any dialog: send Esc, report failure, stop -
   never let a dialog default fire.
6. Registry: lock + temp file + atomic rename. `status` never writes the registry. mktemp per run,
   no shared scratch files.
eta-bus-mcp
7. Nudge text is a FIXED string with no sender content: "[bus] You have unread messages. Call
   bus_inbox." Reject control characters and newlines in subject.
8. "fable" only when ETA_BUS_AS=fable AND HERDR_PANE_ID is unset; refuse any pane whose herdr
   agent name is "fable"; never cache unknown; identity cache 10 s keyed by pane id.
9. bus_inbox: whole reply <= 24 KB; mark read ONLY what is returned; claim-then-return in one
   transaction (two processes with one identity cannot both receive a message). bus_post inserts
   in one transaction.
10. Secrets filter: specific patterns on subject AND body - sk-..., ghp_/gho_/github_pat_,
    xox[abpr]-, JWT (eyJ...\.eyJ...), Bearer <token>, -----BEGIN, URIs with user:password@.
    Remove the generic long-hex/base64 rule (git shas, UUIDs, embeddings must pass).
11. herdr_transcript is ORCHESTRATOR-ONLY, like the control tools.

## Verify
A regression test for EVERY Refuter finding, each proven to FAIL on the old code and pass on the
new. Rerun all existing tests. settings.json / .claude.json hashes unchanged.

## Output
Write /Users/vinaybhardwaj/dev/_fable/scratch/herdr-kit-FIX-REPORT.md (finding -> fix -> test).
Final message at most 15 lines. Last line: WAITING ON Refuter.
