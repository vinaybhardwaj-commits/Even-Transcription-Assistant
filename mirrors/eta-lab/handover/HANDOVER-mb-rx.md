# HANDOVER: mb-rx (Claude Code pane wQ:p1, Sonnet) -> OpenCode, ruling 409 / W25 P1, 25 Sep 2026

## (a) Role
- `mb-rx` is a READ-ONLY Metabase scout (db 13) for the SURGICAL-CHAIN-LINKER (orders/SURGICAL-CHAIN-LINKER.md, Addendum 14:55): prescriptions / advice / advised procedures / investigation orders, output `studies/2026-09-24-surgical-chain/scout-rx.md`.
- Later asks in the same row: ruling 164 (plain CT: find the radiology done sources and join key), ruling 183 (Rx item join for the voice linkage), and name-rule reconciliations for linker.
- No production writes, ever. Aggregates and counts only in git; identifiers only on the box.

## (b) Open items
NONE in flight. Everything asked has been delivered and acknowledged. Bus ids of what I sent:
- #386 first report (Rx `timestamp` = consult START; `consult_uid` = calendar event uid). #428 addendum (PSR picks by Rx type; `patient_need_hospitalization` is not a signal).
- #454 carts / CT angio follow-up (live cart table is `accounts-account_investigation_carts`; CT angio = advised signal only, no "done" label).
- #571 ruling 164 plain-CT done sources. #636 then #650 name-rule reconciliation (final rule reproduces linker's 119 Rx / 106 patients).
- #693 ruling 183 Rx item join (helper + caveats). #1391 plain-CT uid list. #2478 committed `scout-rx.md`.
- ONE loose end: `studies/2026-09-24-surgical-chain/rx_items_by_consult.py` (the item-join helper `vj-link` uses) is still UNTRACKED in the shared checkout at `/home/eta/dev/eta-lab`. I asked the conductor in #2478 whether to commit it; no answer. If Fable or the conductor says yes: copy it into a temp worktree off origin/main and commit it alone (docs/helper only, no PHI in it).

## (c) Paths, branches, shas, pids
- Committed: `studies/2026-09-24-surgical-chain/scout-rx.md` at `dd613a9` (on origin/main). No branches, no pids, no worktrees left open by me.
- Helper (untracked, shared checkout): `/home/eta/dev/eta-lab/studies/2026-09-24-surgical-chain/rx_items_by_consult.py` (`python3 rx_items_by_consult.py IN.txt ~/eta-data/voice-linkage/out.json [--since 2026-08-01]`; refuses to write outside `~/eta-data/`).
- Box-only (0600, not in git): `~/eta-data/surgical-chain/plain_ct_investigation_uids.json` (33 in-window plain-CT investigation uids, 169 master-catalogue matches, 2 MDCT entries the regex misses); `~/eta-data/voice-linkage/test_uids.txt` (150 sampled calendar-event ids used to test the join).
- Read-only Metabase helper: `studies/2026-09-24-surgery-30/mb.py` (also `studies/2026-09-24-surgery-review-v2/mb.py`): `import mb; mb.query(sql)` returns (cols, rows, truncated). It allows one SELECT/WITH only and hides the key. Metabase caps a result at 2,000 rows.

## (d) Rules you must never break (verbatim where they were given)
- From the order ("Do not"): "Write to Metabase or any production DB. Put identifiers in git. Load the Mini in clinic hours (Metabase is not the Mini)."
- From the scout rules (Addendum 14:55): "Metabase read-only, via the box key. Aggregates and `LIMIT`ed samples only, always date-filtered (1 Aug – 24 Sep). One query in flight per session; no full-table scans." and "Identifiers and samples go ONLY to box `~/eta-data/surgical-chain/`. Git files carry names/fields/counts only."
- Ruling 135 (push rule): "before any push from the shared box checkout, run `git log origin/<branch>..HEAD`. Push only if every listed commit is yours." Working rule that followed: never push HEAD from the shared checkout `/home/eta/dev/eta-lab`; do commits in a temp worktree off origin/main (`git worktree add --detach <dir> origin/main`), check `git log origin/main..HEAD` shows only your commit, then `git push origin HEAD:main`, rebase-retry if not a fast-forward. Never force. Never bare `git stash`.
- Never run `fable-inbox.sh` (it advances Fable's read cursor). Never `pkill -f` / `pgrep -f` patterns in the same Bash call as the harness shell.
- Do not adopt a gate, definition or scope change while a Fable ruling is pending: recommend, wait, then pre-register (ruling 261).
- Never read, list or print the secrets directory or key files. My one attempt to list `~/.claude/secrets` was DENIED by the permission layer; I did not work around it. Use `mb.py` only.
- Away order (until "FABLE BACK"): nothing to production; refuter PASS before anything lands on eta-lab main except docs Fable orders; on a NEEDS-YOUR decision take the safer option and post "provisional, pending Fable".
- Bus mirrors are TRUNCATED: read the full body with `bus_inbox` before deciding nothing is asked of you (I once missed a request hidden in a truncated mirror).

## (e) Tools and CLIs (names only)
- Bus MCP: `bus_inbox` (use `unread_only` default, small `limit`), `bus_post`, `bus_ack`, `bus_roster`, `bus_thread`. Bash with `python3` + `mb.py`. `git` (worktrees), `sed`/`cat`. No other MCP was used (no Jev, no Metabase MCP).

## (f) Last 10 decisions
1. Used `mb.py`, not the secrets dir (listing was denied); no bus id, first hour.
2. #386: Rx `timestamp` is consult START and `updated_at` is the last save; the recording window is [timestamp, updated_at].
3. #428: corrected my own claim: `consult_uid` DOES join (calendar event uid); `patient_need_hospitalization` "filled" counted UNKNOWN, so it is not a signal.
4. #454: carts are not the CT route; CT angio usable as advised only. `chart_service_request` status PRESCRIBED is a lead, never booked.
5. #571: plain-CT done = COMPLETED CT service request or HIS bill line (inpatient/emergency only); suggested positives-only because the platform table holds about a third of in-house CTs and `kx_radiology_reports` ends 13 Jul.
6. #636: name-rule differences (NCCT/CECT/HRCT names; venogram/aortogram out).
7. #650: the 12-Rx gap = names spelled "C T ..." with a space (11) + CT Enterography (1).
8. #693: item-join recipe; circularity caveat (item-level AI-fill 0.4-1.2%; Rx free text AI metadata on 78%, unverified).
9. #1391: plain-CT uid list on the box; keep the name rule as fallback for empty uids.
10. #2478: committed `scout-rx.md` (dd613a9) from a temp worktree; did NOT commit the helper (docs only) and asked.

## (g) First thing to do when you wake on OpenCode
1. Read this file, then `studies/2026-09-24-surgical-chain/scout-rx.md` sections 0, 3, 4, 7, 8 (the facts everyone quotes).
2. `bus_inbox` (unread, limit 3-5) and read the FULL bodies. Answer only messages addressed to `mb-rx`; board mirrors (NIGHT boards) have listed `mb-rx` as "no open priority" all day.
3. Sanity-check the read path with one bounded query through `mb.py` (for example a count on `medical_investigations`). If it fails, say so on the bus and do not look for the key.
4. Ask the conductor about the untracked helper (item b) if nobody has answered.
5. Then idle. Do not start new studies unprompted.

## Key facts you will be asked about (one line each)
- Rx join: `individuals-prescriptions._parent_id` = patient; `consult_uid` = `accounts-members-calendar_events.uid`; child item tables join on `_parent_id` = Rx `uid`.
- `kx_prescription_records`, `kx_radiology_reports` (data ends 13 Jul), `chart_radiology_order`, `individuals-investigation_carts`: dead for Aug-Sep. Live cart table: `accounts-account_investigation_carts` (per account).
- Plain-CT rule on `further_investigation.investigation__name`: word CT | NCCT | CECT | HRCT | spaced "C T", excluding `angio|calcium|mri|pet|venogra|aortogra|arteriogra|portogra` (119 Rx / 106 patients, 1 Aug - 24 Sep). Prefer investigation uids.
- Metabase traps: 2,000-row cap; correlated EXISTS over `individuals-prescriptions` or `chart_service_request` times out (180 s), so pull the small side and use IN lists; empty string vs NULL (count `<>''`); `prescription_date` on PSR is date-only text with 3 malformed values.
