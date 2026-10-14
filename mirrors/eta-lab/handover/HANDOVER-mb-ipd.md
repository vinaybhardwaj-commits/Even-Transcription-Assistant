# HANDOVER mb-ipd (Claude Code Sonnet -> OpenCode, W25 P1, 25 Sep ~15:45 IST)

## (a) Role
- mb-ipd = read-only Metabase scout for the SURGICAL-CHAIN-LINKER order (orders/SURGICAL-CHAIN-LINKER.md, addendum 14:55): IPD admissions, discharge, day-care/procedure billing.
- Output was ONE file: studies/2026-09-24-surgical-chain/scout-ipd.md. It is DONE and on main (blob e81c5e4, via linker's 113946d). Fable closed the scouts in ruling 142.
- No work is open. The pane is idle and parked (board: "no open priority fits").

## (b) Open items (bus ids, state)
- None owned. #381 (linker's "don't re-probe" brief): my asks were answered in scout-ipd.md. Still unmeasured: day-care flags in kx_ip_admissions (try `encounter_type`, `is_part_of_care_plan`).
- #445 ruling 142 (scouts done): acked. #2474 ruling 406 ("commit your scout"): nothing to commit, already on main; I told the conductor (#2535).
- #2499 (stray fleet_watch.py --once): NOT mine; no reply was needed.
- #2591: conductor board confirms mb-ipd scout already on main.
- Open questions left in scout-ipd.md for others: HIS doctor id -> OPD doctor id map (uuid-style vs numeric/DR-nn billing codes); where discharge-summary text lives (no kx_* table has it; cdmss_discharge_extracts had 4 rows on 22 Sep).

## (c) Paths, branches, shas, pids
- Repo file: studies/2026-09-24-surgical-chain/scout-ipd.md (origin/main, blob e81c5e4). No branches, no pids, no pinned shas of mine.
- Box: ~/eta-data/surgical-chain/ holds other scouts' files only; I wrote nothing there (no identifiers were pulled).
- Ephemeral (session scratchpad, may vanish): mbq.py (tiny Metabase native-query helper), meta13.json / meta16.json (table metadata).
- Linker's read-only helper: studies/2026-09-24-surgery-review-v2/mb.py (`import mb; mb.query(sql)`; hides the key).
- The shared checkout has a stale untracked copy of scout-ipd.md; it becomes tracked once local main catches up. Do not touch the shared checkout.

## (d) Rules never to break (verbatim from the order unless marked)
- "Metabase read-only, via the box key. Aggregates and LIMITed samples only, always date-filtered (1 Aug – 24 Sep). One query in flight per session; no full-table scans."
- "Identifiers and samples go ONLY to box ~/eta-data/surgical-chain/. Git files carry names/fields/counts only."
- "Do not: Write to Metabase or any production DB. Put identifiers in git. Load the Mini in clinic hours (Metabase is not the Mini)."
- Never print the Metabase key (~/.claude/secrets/metabase_api_key) or put it on argv/logs.
- Ruling 135 (verbatim): "before any push from the shared box checkout, run `git log origin/<branch>..HEAD`. Push only if every listed commit is yours." Memory rule: never push HEAD from the shared checkout; use a temp worktree off origin/main.
- Never run kit/fable-inbox.sh (advances Fable's read cursor); read for-fable.jsonl with tail only.
- Away order (~08:50 25 Sep): nothing to production; take the SAFER option on any new decision and record "provisional, pending Fable".
- Metabase caps a result at 2,000 rows (page by date). Linker's cast notes: queue text columns need nullif(x,'')::timestamptz; correlated NOT EXISTS on "individuals-prescriptions" is very slow.

## (e) Tools and CLIs (names only)
- eta-bus MCP: bus_inbox, bus_ack, bus_post. even-jev MCP exists but I never used it.
- curl to the Metabase API (/api/database, /api/database/<id>/metadata, /api/dataset); python3; git. DBs: 13 "Firestore to Postgres (prod)", 16 "Even Hospital Ops (Postgres)".
- Key files by name only: ~/.claude/secrets/metabase_url, ~/.claude/secrets/metabase_api_key.

## (f) Last decisions
1. Asked V which scout row I was (the order did not say); answer: mb-ipd.
2. Read metadata first; ran aggregate-only, date-filtered queries, one at a time.
3. Treated kx_ip_admissions as the spine (encounter_id = identifier, 1,433 rows; 882 IP + 551 ER).
4. Found discharge tables carry no procedure/diagnosis; procedure = kx_billing_records (859/859 join on encounter_id, identifier and uhid).
5. Flagged billing order times as NOT the OT time (Surgery lines median ~2 h after admission).
6. Dropped rh_ehbr_ipd_detail for the window (ends 18 Jun, 0 rows) and ipd_claims/_v2 (0 rows); ipd_claims_v1 has 85 rows.
7. Fixed a wrong count in my file (medical_ipd_claims = 838) before finishing.
8. Bus was down at the 16:30 deadline: reported to V in text with a paste-ready message; did not write into bus/msgs by hand.
9. #2535: posted a one-line correction that scout-ipd.md reached main via linker's 113946d, not my commit.
10. Did not act on any later bus mirror (all informational); acked #381, #445, #450, #1269 through #2591.

## (g) First thing on OpenCode
- Read this file, then check the bus. Do nothing unless a message names work for you.
- Likely asks: (1) day-care flags in kx_ip_admissions; (2) HIS doctor-id -> OPD doctor-id mapping; (3) procedure text in discharge summaries (not in Metabase kx_* tables). Always obey (d).
- Model note: the inventory picked qwen3.8-flash for this pane (PHI: paid ZDR only). Re-run any number before quoting it; scout-ipd.md is the source of record.
