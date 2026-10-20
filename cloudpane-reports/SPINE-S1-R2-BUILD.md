# SPINE-S1-R2-BUILD — fix round on branch spine/s1-signals (from 86771abd; S0 R2 merged as d69a320e)
## What changed
- lib/spine/ingest-store.ts: priors keep raw Date/string timestamps (no String()); storeSignals retries a lost rev race (max 3 tries, re-read, rev+1) else counts `conflict`; timeline read is newest-first; insert RETURNING per-row.
- lib/encounter-hypotheses.ts: readHypothesesSince = latest ACOUSTIC run per room-day only (encounter_hypothesis_run.source), run_id selected; pre-0118 fallback unscoped (as readLatestAcousticRun). lib/spine/ingest.ts: run_id in attrs.ids, hash takes Date.
- lib/spine/phi-screen.ts (new): key screen (NFKC, drop Mn/Cf, lower-case, Cyrillic/Greek lookalike fold; words text|name|phone|patient|transcript|email|uhid|mrn|mobile|dob|aadhaar|addr|address); value rules (ids allowlist + token, closed close_reason/quality enums per proxy, source_key/room_id token). signal-validate.ts uses it; value refusals are 422.
- lib/spine/auth.ts (new): exact "Bearer " scheme (any case) + timing-safe compare, used by POST and the cron route. config.ts: kill_switch string = malformed = killed.
- tools/eta-spine/post_signals.py: same screens; a refused row is skipped and counted, rest still posted, rc 0 reports `refused`. Shared cases: tests/fixtures/spine-phi-cases.json (read by tests/unit/spine-phi.test.ts and tools/eta-spine/tests/test_phi_screen.py; both assert their enums equal the fixture).
## Tests (own logs .bc/gate.log, build.log, silent.log)
- typecheck, typecheck:tests: green. Full vitest (4 workers, min 1): "Test Files  2 failed | 455 passed | 1 skipped (458)" / "Tests  2 failed | 9401 passed | 5 skipped (9408)". The 2 failures are the pre-existing e11-silent-room-window and no-identity-literals (tools/eta-consult-steward conftest), same as at base e9f7e6a2 per the refute.
- npm run build: exit 0 (run after the vitest step, since `&&` stopped at the 2 pre-existing failures). check:silent: "Found 9 silent-failure handler(s)" = the accepted 9, none in spine files. swift: N/A on Linux.
- pytest tools/eta-spine: 17 passed before the phi file, plus test_phi_screen.py (all green). pg tests (postgres:16): spine-ingest-pg 5 passed; spine-ingest-realmig-pg 7 passed (all 173 migrations).
## Mutants
- TS: 28 run (oref's 15 plus NFKC dropped, Cf strip dropped, ids key allowlist dropped, enum -> any token (both), lookalike fold dropped, retry cut to 1, conflict counted as duplicate, String() priors, acoustic source filter dropped, timeline ORDER, kill_switch decode): 27 killed; M25 (a pattern that did not apply) is the same defect as M28 (acoustic filter dropped), which was killed.
- Python: NFKC dropped, Cf strip dropped, ids allowlist dropped, enum check dropped: 4/4 killed.
## Assumptions
- Acoustic source_key: no stable hypothesis identity exists in the schema, so key stays the hypothesis row id and only the LATEST acoustic run per room-day is ingested. A rerun still adds new signals (new ids), but old runs are no longer re-read.
- Enum sets: pulse 0123, acoustic/timeline 0146/0156 closed_by; pqm close_reason {pqm}, quality {pqm,suspect}; cutter statuses {cut,skipped,error,planned,deferred,deferred_long} plus pulse/pqm sets (from tools/eta-consult-cutter). caa has none. If the box emits a value outside these it is refused client-side and counted.
- Key words are matched on the normalised key only; separators (_ . space) are not stripped.
- Python and TS depth rule aligned: only containers count toward depth 12.
## Open risks
- Two rev-less rows for one key in ONE batch that both lose a race can land out of order (box sends one per key).
- Lookalike fold covers common Cyrillic/Greek letters only; Node and Python Unicode tables may differ for exotic characters.
