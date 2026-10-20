# SPINE-S4-BUILD — observability + shadow reconciliation (branch spine/s4-recon, host ASUS)
## What changed
- lib/spine/pipeline-view.ts (new): `pipelineOrNull(istDate)` (4 s timeout, 10 s memo per date, single-flight, never throws, one closed-class log line), pure `shapePipeline`, `readPipeline` (3 SELECTs on spine_signal / spine_encounter / spine_job). Per room: signals by proxy, encounters candidate/confirmed/rejected/merged + ambiguous (counted, never hidden), per stage done/queued/failed/dead, oldest queued age.
- app/api/rooms-live/now/route.ts: started beside coverage, merged per room as `pipeline` beside mic_guard. Existing fields untouched.
- lib/room-access/tool-reads.ts: `SPINE_STORE_TABLES` + `spineTableCounts()` (moved here because eta_encounter_windows is a room-data table: room-access gate). lib/mcp/tools/stores.ts: `spine_tables` in scribe_store_stats. lib/mcp/tools/health.ts: the 3 missing stores + 7 spine tables in scribe_system_map (detail=full).
- tools/eta-spine/spine_recon.py + tests/: per IST date, ledger vs spine (+ daily_recon), counts/reason codes only to `--out` (0600); R2 only with `--upload --bucket --cred`.
- Tests: tests/unit/spine-pipeline-view.test.ts (10), tests/unit/spine-mcp-stores.test.ts (3), tools/eta-spine/tests/test_spine_recon.py (14).
## Gate (own .bc/gate.log, `--maxWorkers=4 --minWorkers=1`)
- typecheck, typecheck:tests: pass. `Test Files  2 failed | 451 passed | 1 skipped (456)`, `Tests  2 failed | 9362 passed | 5 skipped (9407)`.
- The 2 failures are NOT in files I touched: e11-silent-room-window "THE SWEEP" (counts services/eta-*/ and tools/router-fix python `inference` hits: 41 vs 34) and no-identity-literals (tools/eta-consult-steward/tests/*.py). Not re-run on base: UNVERIFIED as pre-existing, but both scan untouched files only. Run 1 also had 2 failures of mine (room-access-gate, warehouse-join degraded); fixed and re-run green.
- build run separately: exit 0. check:silent: exit 1 with the 9 accepted findings (0 new; I added no `.catch(() => {})`). swift build/test N/A on Linux.
- pytest tools/eta-spine: `14 passed`. Mutants (spine_recon): confirmed-check dropped, merged resolve dropped, split detection off, extras filter off: 4/4 killed.
## Assumptions
- Ledger shape UNVERIFIED (consult_ledger.py withheld): lines with consult_uid, a date (ist_date|date|day or derived from ts), and `stages{}` or `stage`+`state`; last line wins. daily_recon default path `<eta-data>/consult/recon/<date>.json`.
- spine_recon takes a JSON export of spine rows (--spine) instead of a DB client; the export SQL is in its docstring. Ambiguity is not a column, so the view counts `reason ILIKE '%ambiguous%'` and the recon reads an `ambiguous` flag from the export: UNVERIFIED until S2's writer stores it.
- `pipeline` is admin-only like mic_guard (staff/open payload byte-identical). Spine counts in store_stats never degrade the tool (a pre-0173 table reads null).
- Per-stage "equal" needs artefacts in the export and a ledger done-state set (done/ok/written/sealed/ready): a guess.
## Open risks
- Shadow gate itself (one real clinic day, 19 Oct baseline Presence 17 etc.) NOT run: no ledger, DB or box here. `--expect pulse=17,pqm=0,caa=0` is ready for it.
- No timer installed. No migration touched (0173 still S0's).
