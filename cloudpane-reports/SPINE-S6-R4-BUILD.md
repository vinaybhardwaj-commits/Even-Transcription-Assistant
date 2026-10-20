# SPINE-S6-R4-BUILD: branch spine/s6-free on bc003104. Fixes the R3 refute (F6b, release head-of-line, server/box window disagreement).
## Changed
- lib/spine/artefact.ts: object_key is a CLOSED shape: exactly `consult.flac`, or `tracks/{layer}.{engine}__{version}__{cfg8}.json`. layer.engine from a closed lane map (acoustics.room_profile_acoustics, diar.nemotron, stt.koyal; medasr dropped, N18), version per lane (v<1-3 digits>; nemotron also 8 hex; koyal box-t4-koyal-<1-3 digits>), cfg8 = 8 lowercase hex. No free parts, no directories, no word-list fallback.
- lib/spine/retry.ts: `release` sets next_attempt_at = now + 60 s (RELEASE_BACKOFF_MS); still no tick, attempt given back.
- lib/spine/window.ts: server window reads SPINE_HOURLY_FROM_MIN / _TO_MIN with the box's parse and fallbacks (hourlyWindowMin; default :25-:45, budget from :20).
- Tests: tests/unit/spine-s6-r4-adv-pg.test.ts (refuter's 17 TS tests ported, attacks always on), tools/eta-spine/tests/test_adv_r3.py (29), tests/unit/spine-artefact-r4.test.ts, spine-window.test.ts additions. Adjusted for the backoff: spine-queue-pg, spine-s6-pg (N3). spine-s6-r3-pg: medasr key no longer accepted.
## Tests
- pytest tools/eta-spine: 165 passed.
- Gate (.bc/gate.log): typecheck 0, typecheck:tests 0; vitest `Tests 2 failed | 9457 passed | 5 skipped (9464)`. The 2 failures are the base pair (e11-silent-room-window, no-identity-literals; none of the flagged paths is a spine file). The && chain stopped there, so build and check:silent were run separately: build 0 (.bc/r4-build.log); check:silent exit 1 with the 9 accepted findings, none in spine (.bc/r4-silent.log). Swift N/A on Linux. Vitest needs --minWorkers=1 on this 24-core host.
- Attack tests: 11/11 refused with OREF_ATTACK behaviour always on.
## Mutants
- Python (scratch copy): 44/45 killed; survivor R1-2 PAID_STAGES (equivalent, as before).
- TypeScript: 34 run, 33 killed; survivor R1-T7 (uid in shadow claim, equivalent, as before). New R4-1..R4-15 (free dir/file part accepted, version unscreened, lane list open, cfg8 loose, suffix match, medasr readmitted, version uncapped, release without backoff, backoff 1 s, window ignores env, inverted env, env range, budget removed, window <=) all killed.
## Assumptions
- Real version forms from clip_lanes.py: acoustics "v1", nemotron NEMOTRON_REV[:8] (8 hex, may be all digits), koyal "box-t4-koyal-1". I also let nemotron take v<n> and capped digit counts at 3.
- The 60 s backoff also applies to the N3 shadow-to-live requeue (same release path). Its test now advances the clock.
- Server env: the server must be deployed with the same SPINE_HOURLY_* as the box; a mismatch now only costs a bounced release with 60 s backoff.
## Open risks
- Carried: F5 (two active links), F7 (non-deterministic FLAC sha gives sha_conflict), no production enqueuer or spine_link writer. A future lane or version form needs a code change to TRACK_LANES.
