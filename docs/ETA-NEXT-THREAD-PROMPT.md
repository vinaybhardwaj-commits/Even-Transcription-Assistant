# ETA Next-Thread Boot Prompt

**Copy everything below the `---` line into the first message of a new thread.**

---

You're picking up the Even Transcription Assistant (ETA) project mid-flight. Sprints 0-5 shipped end-to-end in the previous Cowork session. Full state is in `Daily Dash EHRC/ETA/ETA-CARRYOVER.md` — read it first.

Quick orientation:

**Live URLs:**
- Doctor app: https://eta.llmvinayminihome.uk/dr-vinay-bhardwaj-cjzs (PIN 1234)
- Admin: https://eta.llmvinayminihome.uk/admin (vinay.bhardwaj@even.in / <REDACTED>)
- Health: https://eta.llmvinayminihome.uk/api/health

**Latest capstone:** `sprint-5-shipped` at commit `31c05c4` on `vinaybhardwaj-commits/Even-Transcription-Assistant` main. Vercel `prj_8nVH2HdbeDy6aJ8oeWqfkhYijM9Z` on `team_yu1wWpsKdjsf90haai1ETJDG` (bom1).

**Sandbox bootstrap:**
```bash
cd /tmp && rm -rf eta
git clone https://vinaybhardwaj-commits:<REDACTED>@github.com/vinaybhardwaj-commits/Even-Transcription-Assistant.git eta
cd eta && git log --oneline -5  # should show 31c05c4 capstone
```

**Recurring traps to remember** (each is in memory as a `feedback-*` file):
- SWC: `\u{XXXX}` invalid in JSX text content — codegen tools that emit it produce broken JSX
- Cookie scope: Path-scoped cookies don't reach sibling /api routes — move APIs into scope or widen path
- Neon HTTP: timestamps come back as strings, not Date — wrap with `new Date(...)` before `.toISOString()`
- TS narrowing: discriminated union returns need explicit `Promise<T>` annotations; nullable vars need explicit `T | null` type aliases
- OLLAMA_BASE_URL already includes /v1 — don't append another one
- Vercel webhook can lag 5+ min — empty `git commit --allow-empty` nudges it

**Pending backlog** (none critical, V chooses thrust): /admin obscure-path middleware (PRD §4.16); admin trace dashboard for llm_traces table; inbound Resend reply handling; per-encounter cancel button mid-stream; APP_URL Vercel env still set to stale eta.even.in (canonicalAppUrl() helper covers).

Start by reading `Daily Dash EHRC/ETA/ETA-CARRYOVER.md` for the full picture, then ask V what they want to push on next.
