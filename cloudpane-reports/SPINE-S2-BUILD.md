# SPINE-S2-BUILD (round 1: pure merge only)
Branch spine/s2-merge off origin/main e9f7e6a2.
## Changed
- lib/spine/types.ts (SPINE-PLAN §2 names; times are epoch ms), lib/spine/merge.ts (mergeSignals(signals, merge_version, prior, now), encounterIdCandidate, mintEncounterId), tests/unit/spine-merge.test.ts (35 tests).
- NOT built (round 2): merge-store.ts, the pg writer test, any migration.
## Tests (own runs)
- `npx vitest run tests/unit/spine-merge.test.ts`: Tests 35 passed (35).
- Full gate, .bc/gate.log: typecheck ok, typecheck:tests ok, vitest `Test Files 2 failed | 449 passed | 1 skipped (452)`, `Tests 2 failed | 9363 passed | 5 skipped (9370)`. The 2 failures (e11-silent-room-window, no-identity-literals) fail identically at base e9f7e6a2 (checked in a clean worktree): new failures vs base = 0.
- Chain stopped at vitest, so build and check:silent ran separately: `npm run build` exit 0; `npm run check:silent` exit 1 on pre-existing findings, none in lib/spine (0 hits).
- swift build/test: N/A on Linux. Kiosk suite not touched.
- The brief's `--maxWorkers=4` alone throws "minThreads and maxThreads must not conflict" on this host; used `--maxWorkers=4 --minWorkers=1`.
## Mutants (8, all killed; each run = 1-4 failing tests)
drop M4; 50%->40%; 120 s->60 s; rank swap pulse endConsult/pqm; M7 tie to later encounter; survivor = newer; 72 h->48 h; remove 8-digit check.
## Assumptions
- Did NOT reuse .bc/asus-draft; written from scratch.
- Added 4th param `now` (clock-free purity; needed for M1 90 min cap, D7 horizon, no_tape +24 h). `prior` also carries per-signal `encounter_id` on SpineSignal; output includes `assignments`, `flags` (not columns), `boundary_moved`.
- Same room_id required for every merge, including key matches. A pulse group is identified by consult_key (not consult_uid) so one enc id on two machines gives two encounters (multi_machine). pulse_overlap flag (pqm too) uses the >=50% threshold, not any overlap.
- Frozen (now >= IST day start + 72 h): an existing encounter's row is returned as in prior (status too), links still update; frozen encounters are never merge losers.
- Ids: HMAC-SHA256 with a fixed domain-separator key, 10 bytes -> 16 base32; counter rehash on 8-digit run or collision. New encounters start boundary_rev 0.
- Migration number: 0173 is TAKEN on origin/oauth-email-squashed and origin/scribe/oauth-email-code (0173_mcp_blacklist_applied). Round 2 must pick another number. Not needed this round.
## Open risks
- Greedy, sort-ordered grouping is deterministic but order-sensitive in edge cases (weak groups grow as members join). Clinical meaning of ambiguous/candidate handling is unreviewed.
- Zero-length spans never overlap (shorter interval must be > 0).
