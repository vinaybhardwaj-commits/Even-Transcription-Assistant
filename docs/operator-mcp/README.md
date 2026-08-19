# Builder note — Operator MCP

19 Aug 2026, rev 3d. From Vinay / Scribe Designer.

**This folder is for the orchestrator.** The designer does not implement. The coder does not treat the PRD as a ticket list.

## Seats

| Seat | Job |
|---|---|
| Orchestrator | Read the PRD + inventory. Use the Scribe tree and the Pulse monorepo (read-only) to write coder instructions. |
| Coder | Build the slice you scoped, on `feat/operator-mcp`. Report done / blocked to you. |
| Designer | Reviews what you report. Revises the PRD if a lock was wrong. |

Loop: designer → orchestrator → coder → orchestrator → designer. That is the intended loop.

## Start today on this branch

`feat/operator-mcp` (off `main` @ `b907bc50`). Preview is fine.

**Do not** merge to `main`, run a new prod migration, or ship any `RoomRecorderClient` change to evenscribe.app until today’s Purnima / Ankit day is ended and the tapes are on R2.

Live kiosk stays what is already shipped (Start day, Pause, Mark consult, tape → R2). This work is the operator door: `/api/mcp`, cue GET, command bus, independent brain write, extract-by-time, supervisor tools (diff / watch / transcribe range / pin as a cue).

## Read in this folder

1. [EVEN-SCRIBE-MCP-PRD-19-AUG-2026.md](./EVEN-SCRIBE-MCP-PRD-19-AUG-2026.md) — locks, tools, acceptance. §1b is the team contract.
2. [SCRIBE-MCP-STACK-INVENTORY-19-AUG-2026.md](./SCRIBE-MCP-STACK-INVENTORY-19-AUG-2026.md) — what actually exists at `b907bc50`. Cite these files in coder briefs.

A coder brief names the slice, the real files, the §18 rows that close it, and what is out (production kiosk, Pulse writes, Slack).

Preview deploy of this branch is fine. If the live day needs a hotfix, that goes to `main` first; rebase this branch after.

Questions that need a product lock come back to Vinay / this designer. Implementation questions stay with the orchestrator.

Draft PR (do not merge): https://github.com/vinaybhardwaj-commits/Even-Transcription-Assistant/pull/1
