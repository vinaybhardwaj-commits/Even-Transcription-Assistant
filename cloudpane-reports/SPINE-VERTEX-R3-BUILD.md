# SPINE-VERTEX-R3-BUILD — tests + docs only (branch spine/vertex-no-openrouter, on 471a887a)
No runtime code changed (N16 already classed permanent: lib/gcp-auth.ts:37).
## Changes
1 tests/unit/vertex-auth-class.test.ts: real-mint test moved out to NEW tests/unit/vertex-gcp-auth-mint.test.ts (own module registry; no doUnmock leak). P03 tests are live in a whole-file run.
2 services/eta-router/test_vertex_oref.py: ETA_ROUTER_DIR defaults to the file's directory; tearDown rmtree's its mkdtemp (the /tmp/spine-vertex-oref-* count did not grow over a full run).
3 NEW services/eta-router/test_vertex_auth_leak.py (refuter's P03: ValueError/Exception/RuntimeError/RefreshError with a marker never reach translate_error, stdout/stderr or logs). NEW TS test in vertex-gcp-auth-mint.test.ts: invalid-JSON GCP_SA_KEY -> permanent, askJson llm_refused, nothing sent, no body leak (N16).
4 Docs: SPINE-VERTEX-BUILD.md slug sentence corrected to R2 behaviour. SPINE-VERTEX-R2-BUILD.md deploy block: <tip sha> = dfe31b75, <repo> = /home/eta/dev/Even-Transcription-Assistant; retention names the exact checks (Gemini cacheConfig disableCache=true; abuse-monitoring logging exemption or zero-retention agreement on record).
## Tests
- Plain `pytest services/eta-router` (ETA_ROUTER_DIR unset, /tmp venv): `146 passed, 2 skipped, 5 subtests passed` (144 + 2 new).
- `vitest run vertex-auth-class vertex-gcp-auth-mint`: `Test Files 2 passed (2)`, `Tests 7 passed (7)`.
- Gate (.bc/gate.log, 4 workers, foreground): typecheck + typecheck:tests green; `Test Files 524 passed | 1 skipped (527)`, `Tests 10412 passed | 7 skipped (10459)`, 0 failed, `Errors 4 errors` = worker "Timeout calling onTaskUpdate" (same load artefact as R1/R2) so gate=1; then `npm run build` exit 0; check:silent exit 1 = the 9 accepted findings. swift N/A (Linux). 0 new failures.
## Mutants
N12 (routedChat fallback warn appends r.error): whole-file vertex-auth-class run now `1 failed | 4 passed`, killed by the "non-2xx body" P03 test. Reverted (git diff on lib/ empty). N16 needs no code fix; its test passes against the unchanged classification (not mutation-run).
## Assumptions / risks
- A commit cannot contain its own sha: the deploy block names dfe31b75 (the tests commit); router_server.py is identical between it and the final head (docs-only commit after it). Re-pin if the branch moves again.
- Retention checks remain UNVERIFIED (not run).
