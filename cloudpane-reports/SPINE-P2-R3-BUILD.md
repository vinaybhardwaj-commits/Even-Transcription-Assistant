# SPINE-P2-R3-BUILD — RULING B: confirmed_single_proxy (branch spine/p2-writer on 16668bc1)
Built by Sonnet. Migration 0176 was free on origin/main and every live branch (checked `git ls-tree`). Shadow only; nothing doctor-facing changes.

## Changed
- db/migrations/0176_spine_encounter_single_proxy.sql (DROP IF EXISTS + ADD, 5-value CHECK; registers itself; no seed); db/rollbacks/0176_..down.sql (rows -> candidate, 4-value CHECK back).
- lib/spine/merge.ts: new status for exactly the timeline-only shape (set of weak proxies in the group == {timeline}, no strong anchor, not rejected/silent), reason `single_proxy_timeline`. merge-store.ts MERGE_VERSION p2-1 -> p2-2. types.ts widened.
- lib/spine/enqueue.ts: confirmed_single_proxy gets the confirmed stage set (no freescript if ambiguous); status is ALWAYS shadow, input_key `sp:`+hash. enqueue-store.ts: SUPERSEDE_SQL also supersedes sp: rows once the encounter is no longer sp (and non-sp rows of an sp one).
- Readers (grep of every spine_encounter.status reader: explorer-read, pipeline-view; artefacts/other libs do not read it): own bucket `confirmed_single_proxy` in dayView and the pipeline view; never added to `confirmed`.
- Tests: spine-p2-r3.test.ts (6), spine-p2-r3-pg.test.ts (7), spine-0176-pg.test.ts (7). Existing tests edited ONLY where they asserted the timeline-only shape or the exact status-count key set (spine-merge, spine-p2, spine-p2-pg [loads 0176; fixtures], spine-p2-oref-pg, pipeline/explorer count literals).

## Shapes before -> after
| shape | before | after |
|---|---|---|
| timeline alone (any span) | candidate/weak_single | confirmed_single_proxy/single_proxy_timeline |
| acoustic / doctor_activity / nemotron alone | candidate/weak_single | unchanged |
| pulse or pqm (+ anything) | confirmed/<strong> | unchanged |
| timeline + acoustic or doctor_activity, span>=120 s | confirmed/weak_agree | unchanged |
| two weak, span<120 s | candidate/weak_short | unchanged |
| timeline + cutter silent_audio / blind_room_day | confirmed/silent / rejected | unchanged |
| sp + later pulse / 2nd weak | n/a | confirmed (same id; sp: jobs superseded, normal rows enqueued) |

## Gate (.bc/gate.log)
- typecheck, typecheck:tests: pass. `Test Files 519 passed | 1 skipped (520)`, `Tests 10412 passed | 7 skipped (10419)`: 0 failures. build: pass.
- check:silent: `Found 9 silent-failure handler(s)` = the accepted pre-existing 9 (none in files I touched); it makes the gate line `gate=1`.
- swift build/test: N/A on Linux. check-number-words.sh: not applicable (no lexicon change).
## Mutants (10, all killed): no sp branch (6 fail); any single weak -> sp (1); sp uncapped under live (2); no sp: prefix (4); sp ignores ambiguous (2); no sp supersede (1, pg); pipeline bucket dropped (1); 4-value migration (3); explorer bucket dropped (3); sp gets no stages (6).
## Assumptions
- Reason string `single_proxy_timeline` (spec named none). "Timeline-only" = no other weak proxy present at all in the group (a timeline + non-overlapping doctor_activity stays candidate/weak_single).
- The promotion by a 2nd weak proxy follows the existing weak_agree rule (needs span >= 120 s; otherwise weak_short candidate).
## Open
- Not run against the live DB. After 0176 is applied in prod, the merge must run only once the migration is in (the CHECK rejects the new status before).
