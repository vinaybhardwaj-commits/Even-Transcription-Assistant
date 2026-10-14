# vinay/service-pools @ 5121764 — Refuter verdict (eta-refuter-2, 24 Sep 2026)

**Status: SECOND READ.** ETA-Refuter is the primary refuter for this product code (LANES L9, scribe #59). This file is input to their verdict, not the merge gate.

Order: orders/REDUNDANCY-R1.md Phase 4 (+ T2). Builder: split-speaker. Shipper: scribe. Not built by this session.
Base: one commit plus a tests-only fix on production 0e96d39 (0fbdefc → 5121764).

**VERDICT: PASS TO SHIP DARK (no new env set) + T2. FAIL TO ENABLE: do NOT set any *_URLS / *_BULK_URLS /
BULK_AGE_MINUTES until R1 and R2 are fixed and R3 is ruled on.** With the env unset the release is safe. The
pool is only dangerous once it is switched on.

## Gate (my own run, not quoted)
- GitHub shards on 5121764: **GATE PASS**, run 35940872199, 3m58s (typecheck, 8 shards, build and check:silent).
  Box gate per split-speaker: 204/204 files, 4519 passed, 1 skipped.
- On 0fbdefc my run 35940479749 FAILED at e11-silent-room-window.test.ts:602 and no-identity-literals.test.ts:87,
  the same two tests split-speaker fixed in 5121764 (tests only: an E11 sweep reclassification that's legitimate
  because service-pool reads no windows, plus a URL moved to example.com).

## Verified good
- **No-env identity:** each client's pool is `[old single var, as written]`, or emotion's old built-in fallback. An
  empty single var still reads as missing, `served_by` is reported only when a pool var is set, and `poolBulk`
  returns before any query when BULK_AGE_MINUTES is unset. `bench_window.closed_at` exists (0057).
- 4xx is final, 5xx/timeout/connect is failover, the join mutex busy state is failover, the breaker opens at 3 for
  5 min, all-open tries everything, and `served_by` = origin only.
- Mutation, my own 3: join 4xx→failover KILLED, bulk-not-first KILLED; **caller-abort→failover (diarize)
  SURVIVES**, an untested classification. Its effect is small because the next endpoint sees the aborted
  signal at once, but pin it.
- **T2 ruling: ACCEPTED.** A 6 h busy cap with no attempt burned below it meets "waits and retries without
  burning an attempt" and stays bounded. It changes live behaviour at release, and that is intended.

## Blocking BEFORE any pool env is set
- **R1 (HIGH): the pool has no overall deadline.** Each endpoint gets its full timeout, so worst case is
  whisper 2 (retry wrapper) × N × 90 s, join N × 90 s, diarize N × 300 s. MAX_STEP_MS (200 s) is a declared
  budget, not a timer, and /api/jobs/run has maxDuration 300 s. **A diarize failover can never finish inside one
  invocation** (one endpoint already uses the whole 300 s), and whisper with N=2 reaches 360 s. The function is
  killed mid-failover, the lease re-claims, and any second dispatch already started keeps running server-side
  (twice the work, twice any paid pyannote.ai spend). Probe: 3 endpoints at 150 ms each gave 452 ms of wall
  time. Fix: ONE pool deadline passed through runPool. Each endpoint gets min(its timeout, deadline − elapsed),
  and the next endpoint is not started if what remains is below a floor. For long or paid work (diarize),
  fail over on connect error or 5xx only, never on our own timeout.
- **R2 (HIGH, config trap the order itself sets up): one DIARIZE list serves four routes.** runDiarize
  (/diarize), embed (/embed_speakers), speech regions (/speech_regions) and enroll all read DIARIZE_BASE_URLS and
  share one breaker key. The 06:20 addendum puts c3 in the pool for embed only, and c3 has NO /diarize. Probe:
  pool [mini(timeout), c3, box] → tried mini → c3 → **http_404, classified FINAL**, and the box is never tried,
  so the window fails. Fix: per-route lists (e.g. DIARIZE_EMBED_URLS / DIARIZE_VAD_URLS falling back to
  DIARIZE_BASE_URLS), or treat a 404 for the route as failover plus "this endpoint lacks the route".
- **R3 (needs Fable's ruling): bulk falls back onto the live list, Mini included.** poolEndpoints builds
  `[...BULK, ...ordinary]`, so when the box and gcp-l4 are down or breaker-open, the daytime backlog runs on the
  Mini. That contradicts "backlog on the box and gcp-l4 while live clinic audio stays on the Mini". The join is
  single-flight per instance, so a bulk join on the Mini blocks the live joins. Recommend: bulk never falls
  through to live endpoints unless a flag says so (default off).
- **R4 (MEDIUM): a BULK_AGE_MINUTES typo fails EVERY room_window step.** poolBulk throws inside the runner's
  try, which counts a failure per step, so after MAX_FAILURES every room_window job fails, not just bulk routing.
  Strictness is right, but the blast radius should be the flag and not the drain. Validate it once where the env
  is read, and refuse to start or report it on health, rather than per job step.

## Lower
- The breaker is per serverless instance (split-speaker's (3)): each cold instance re-learns a dead endpoint
  and pays its timeout up to 3 times. Acceptable, but it compounds R1.
- Health and segment calls for emotion can land on different twins (split-speaker's (4)). Acceptable.

## CORRECTION to R2 (24 Sep, after lab-mover #61; checked read-only on each host)
My R2 example was wrong in its detail. I took "c3 is embed-only" from the order's addendum. The deployed
eta-diarize on c3 DOES serve `/diarize`. Routes, from each service's own openapi.json:
- Mini production eta-diarize :8001: `/diarize /embed_speakers /enroll /health`
- box twin :8001 and c3 twin :8001: the same four.
**The route no endpoint serves is `/speech_regions`** (used by lib/diarize-vad-trim.ts). R2's mechanism stands (one
DIARIZE list for four routes, and a route 404 is FINAL), but its live instance is the VAD trim, not c3's /diarize.
Keep the fix: per-route lists, or a route-404-is-failover rule.

## Second read of e42b7e6 (the enable fixes): my R1, R2 and R4 and M1 are CLOSED; R3 is proposed and awaits Fable
- **Gate (mine):** GitHub run 35942437126 on the gate commit 5e50fd1 (= e42b7e6 plus the CI config overlay): success.
  (gh-gate itself exited 1 after the shared 60/h unauthenticated API budget ran out mid-watch; the run was read
  directly afterwards. See the note to lx.)
- **R1 closed:** runPool takes one `budgetMs` (= the old per-call timeout) with a deadline. The FIRST endpoint gets
  the whole budget, so an unpooled call is unchanged, and no endpoint starts with < 5 s left. Whisper stays at
  2 × 90 s (retry wrapper) and diarize at 300 s, the same as today. **Consequence for Fable:** a timeout on the first
  endpoint uses the whole budget, so a HUNG-but-reachable endpoint causes no failover on that call. It is routed
  around only once its breaker opens (3 timeouts, per serverless instance). Failover on "timeout" (in the order)
  therefore happens via the breaker, and fast failures (connect error, 5xx, 404) fail over at once. That trade-off
  bounds R1; rule on it knowingly.
- **R2 closed:** per-route pools `diarize_embed` / `diarize_vad` / `diarize_enroll` (each inheriting DIARIZE_*),
  and a 404 now fails over for diarize and enroll.
- **R4 closed, in a better form than I proposed:** a bad BULK_AGE_MINUTES or POOL_BULK_FALLBACK_LIVE now logs once and
  turns that feature OFF. The drain is untouched.
- **M1 closed:** `aborted` is pinned as final (test :441). Diarize no longer fails over on its own timeout.
- **R3 proposed:** bulk uses only *_BULK_URLS unless POOL_BULK_FALLBACK_LIVE=1. I agree with that default. Fable's ruling.
