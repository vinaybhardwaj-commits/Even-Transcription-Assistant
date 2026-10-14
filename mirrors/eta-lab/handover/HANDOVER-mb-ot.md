# HANDOVER mb-ot (Claude Code, Sonnet, herdr pane wR:p1) -> OpenCode, ruling 409 (25 Sep ~15:30 IST)

No patient data in this file (aggregates and field names only). Nothing was in flight when written; the pane is idle.

## (a) Role, 3 lines
- Read-only scout on the surgical-chain P0 (orders/SURGICAL-CHAIN-LINKER.md, Addendum 14:55): OT bookings, OT schedule, OT notes and procedure master, over Metabase db 13, window 1 Aug - 24 Sep.
- Output is `studies/2026-09-24-surgical-chain/scout-ot.md` (151 lines, on origin/main via linker's commit 113946d, byte-identical to my copy). SCHEMA.md (linker) folded it in.
- Status: DONE and PARKED since ~14:00 (boards list mb-ot under "No open priority fits"). Nobody has assigned me anything since linker's #455.

## (b) Open items
None owned by me. Closed items, for the record:
- P0 scout row: reported (bus #360), follow-ups on linker's open items answered (#429), follow-up 2 (case_history profile + PRESCRIBED overlap) reported (#448).
- Part (a) of linker's #440 (doctor flag `requires_surgery_or_procedure` vs cases/OT notes/admissions): NOT done by me. My read of `~/eta-data/surgical-chain/dpipe_flag_rx_uids.json` was denied by the auto-mode classifier (PII). Linker ran it himself (#455, SCHEMA.md section 7). Do not redo, and do not re-read that file: linker made it 0600 in a 0700 dir on purpose.
- Not done, on purpose: note-vs-case procedure matching and anything that scores links (P1, owned by linker/linker-oc + eta-refuter-2).
- Bookkeeping: conductor's 14:00 board wrongly said mb-ot committed its scout under r406; corrected by me (#2533) and conductor confirmed in the 15:00 board.

## (c) Paths, branches, shas, pids
- Scout file: `studies/2026-09-24-surgical-chain/scout-ot.md` (origin/main, commit 113946d). SCHEMA.md in the same dir is linker's merge.
- Read-only Metabase helper: `studies/2026-09-24-surgery-review-v2/mb.py` (`import mb; cols, rows, truncated = mb.query(sql)`; db 13; refuses anything but one SELECT/WITH; hides the key; 2,000-row cap, so page by date). An older copy is at `studies/2026-09-24-surgery-30/mb.py` (same guard).
- Credentials: `~/.claude/secrets/metabase_url` and `~/.claude/secrets/metabase_api_key` (paths only; never print or paste them). `metabase_api_key.bad-20260924` is a rejected key: do not use it.
- Query scripts I wrote live only in the Claude Code scratchpad (`/tmp/claude-1000/-home-eta-dev-eta-lab/eb5d819f-.../scratchpad/q1.py ... s4.py`); not committed, not needed: every number is in scout-ot.md with its definition.
- Box-only identifier area (not for git): `~/eta-data/surgical-chain/`. I wrote nothing there.
- Branches/pids: none. No commits or pushes of mine in the shared checkout. The shared checkout has unpushed conductor commits that are NOT mine.

## (d) Rules I must never break (verbatim where they exist)
From orders/SURGICAL-CHAIN-LINKER.md:
- "Do not: Write to Metabase or any production DB. Put identifiers in git. Load the Mini in clinic hours (Metabase is not the Mini)."
- "NO patient identifiers in git; examples go to box `~/eta-data/surgical-chain/` only."
- Addendum 14:55 rules for every scout: "Metabase read-only, via the box key. Aggregates and `LIMIT`ed samples only, always date-filtered (1 Aug - 24 Sep). One query in flight per session; no full-table scans." and "Identifiers and samples go ONLY to box `~/eta-data/surgical-chain/`. Git files carry names/fields/counts only." and "Write only your own scout-*.md".
- Linker #440: "Please do NOT start note-vs-case procedure matching or anything that scores links: that is P1 and waits for Fable to read P0." "If either of you is blocked or the Metabase load looks heavy, stop and tell me."
Standing rules from Fable (all panes):
- Ruling 135: before any push from the shared box checkout run `git log origin/<branch>..HEAD`; push only if every listed commit is yours. Practical rule (memory): never push HEAD from the shared checkout; use a temp worktree off origin/main and push from there.
- Away order (~08:50, until "FABLE BACK"): nothing to production; a new decision that needs Fable takes the SAFER option (changes less, undoable), post "provisional, pending Fable: <what>" to conductor, or park it.
- Permission denials are final: do not retry the same outcome by another tool, path or route (I applied this to the flag-uid file). Report and let the user/Fable decide.
- Do not adopt a gate/definition/scope change on your own while a ruling is pending: recommend, wait, then pre-register (ruling 261).
- Never run `fable-inbox.sh` (it advances Fable's read cursor); check for-fable.jsonl with tail if you must look.
- `pkill -f` / `pgrep -f` in the same shell call matches your own shell; use PIDs or the `[x]` trick.
- Do not read secrets, .ssh or .env files; never send patient text or credentials over the bus.

## (e) MCP tools and CLIs I use
- Bus (mcp eta-bus): `bus_inbox`, `bus_post`, `bus_roster`, `bus_thread` (thread id `surgical-chain`). Post with `wake:false` for bookkeeping.
- Shell: python3 (with mb.py), git (fetch/diff/worktree only), grep, sed.
- File tools: Read, Write, Edit. Nothing else needed. No Jev, no Scribe, no production tools were used.

## (f) My last 10 decisions
1. Identified my row (mb-ot, pane wR:p1) from the bus roster because the order did not name it; scoped to OT tables only (IPD/discharge left to mb-ipd, Rx to mb-rx). No bus id.
2. Used the existing SELECT-only mb.py instead of a raw HTTP client. No bus id.
3. Reported that `ot__status=COMPLETED` means "OT scheduled", not "surgery done" (it covers future slots) and that `prescription_uid` is empty on all cases. Bus #360.
4. Answered linker's three open items (24/31 Aug slot dip = slot under-recording, one scheduler handover; surgeon name -> uid = 81% by name-or-KX-id; PRESCRIBED cases start 14 Sep, auto-created by one creator). Bus #429.
5. Softened my own claim "the 80 PRESCRIBED cases are the platform-URL cases" until row overlap was measured, then measured it (81 = 81, exact). Bus #448.
6. Stopped at the permission denial on the flag-uid file (PII): did not retry, did not rebuild the list from Metabase; asked for a decision. Bus #448. Linker ran it himself (#455).
7. Did not start P1 note-vs-case matching or link scoring, per #440. No bus id.
8. On ruling 406 ("commit your scout"): checked origin/main first, found it already there (113946d) and byte-identical, so made no worktree/commit/push. Reported in #2533.
9. Answered conductor #2499: my pane did not run fleet_watch.py --once (in #2533).
10. Corrected the conductor's 14:00 line 8 (I did not commit the scout). Bus #2533.

## (g) First thing to do when you wake on OpenCode
1. Do NOT act on old bus messages. Read the bus inbox and the surgical-chain thread once; act only on a message addressed to `mb-ot` that is newer than this file.
2. Read `studies/2026-09-24-surgical-chain/scout-ot.md` and SCHEMA.md sections 5-7 so you know the numbers; do not re-probe anything they cover.
3. If asked for more OT-side facts: use mb.py, read-only, aggregates, date-filtered, one query at a time; add a dated follow-up section to scout-ot.md; never put identifiers in git.
4. If asked to score links or match procedures: refuse and point to linker/linker-oc + eta-refuter-2 (P1).
5. Key facts to keep in mind: OT note (final, `kx_clinical_template_ot_notes.created_at`) is the only "done" evidence in this scope; `surgery_cases.ot__start_at` is under-recorded for the 24 Aug - 14 Sep weeks; `source=PRESCRIBED` cases (from 14 Sep) are auto-created leads, never a booking decision; doctor ids on OT notes join to `doctors` only partially (KX-id text-contains route plus name match).
