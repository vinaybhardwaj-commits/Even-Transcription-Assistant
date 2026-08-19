# Builder note — Operator MCP

19 Aug 2026. From Vinay / Scribe Designer.

Start this **today on this branch** (`feat/operator-mcp`) while the two-room Bench capture runs on production `main`.

**Do not** merge to `main`, run a new prod migration, or ship any `RoomRecorderClient` change to evenscribe.app until today's Purnima / Ankit day is ended and the tapes are on R2.

Live kiosk stays what is already shipped (Start day, Pause, Mark consult, tape → R2). This work is the operator door: `/api/mcp`, cue GET, command bus, independent brain write, extract-by-time, supervisor tools (diff / watch / transcribe range / pin as a cue).

Read in this folder:

1. [EVEN-SCRIBE-MCP-PRD-19-AUG-2026.md](./EVEN-SCRIBE-MCP-PRD-19-AUG-2026.md) — requirements
2. [SCRIBE-MCP-STACK-INVENTORY-19-AUG-2026.md](./SCRIBE-MCP-STACK-INVENTORY-19-AUG-2026.md) — what actually exists at `b907bc50`

Preview deploy of this branch is fine. If the live day needs a hotfix, that goes to `main` first; rebase this branch after.

Designer is design-only. Questions back to Vinay.
