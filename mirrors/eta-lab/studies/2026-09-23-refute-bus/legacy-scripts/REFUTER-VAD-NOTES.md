# REFUTER ruling — merge 5c184ea (vinay/s1-auto-drain), local only

## F1 (BLOCKING) — `outcome` is read from the wrong level; it is ALWAYS null in production

The router emits `outcome` **inside `segmentation`**, never at the top level.

- `~/eta-router/router_server.py:660-661` (sync `/route`) — `"segmentation": {..., "outcome": window_outcome(...)}`, and separately `"status": status` at top level.
- `~/eta-router/router_server.py:587-588, 597` (the no-speech early return) — same: `outcome` inside `segmentation`, `status` at top level.
- `~/eta-router/router_server.py:765-773` (`job_verdict`) — returns `(status, segmentation_dict)`; `outcome` is a key of the segmentation dict.
- `~/eta-router/router_server.py:828` — `job["status"], job["segmentation"] = job_verdict(...)`. There is **no** `job["outcome"]` anywhere in the file.

The TS side reads it top-level only:
- `lib/stt/adapters/route.ts:100` — `outcome: (r as Record<string, unknown>).outcome`
- `lib/stt/route-run.ts:166` — `isOutcome(router.outcome)`; `seg` is read for `n_engine_segments`, `windows_total`, `windows_skipped` but **never for `seg.outcome`**.

Corroborating: neither `RouterResult` (`lib/stt/eta-router.ts:16-27`) nor the newly-extended `RouterJobStatus`
(`lib/stt/eta-router.ts:73-83`, which this merge added `status` and `segmentation` to) declares an `outcome`
field — because there isn't one. The adapter casts past the type to reach a key that does not exist.

Consequence: every `route_outcome` record written from now on has `outcome: null`.
`engine_no_text` vs `engine_text` — two of the three outcomes the merge exists to separate — are
never stored. Only `engines_skipped` (from top-level `status === "silent_skipped"`) and the
`windows_*` counts survive, so the row can say skipped/ran/unknown but cannot say
"an engine ran and heard nothing" except by the old empty-transcript guess.

## F2 (BLOCKING) — live regression: `silent_window` is now always false on the route job path

`lib/jobs/kinds/route-transcribe.ts:192`

    silent_window: outcome.known ? outcome.outcome === "engine_no_text" : chars === 0,

`outcome.known` is true whenever `route_outcome.engines_skipped` is a boolean, which is true
whenever the router sent a `status` — i.e. always. By F1, `outcome.outcome` is always `null`.
So the ternary always takes the known branch and always evaluates `null === "engine_no_text"`
=> **false**. Pre-merge this field was `chars === 0` and was correct for a quiet window.

Every genuinely quiet route job now reports `silent_window: false`. This inverts exactly the
distinction the merge claims to establish, on the live path, silently.

## F3 (BLOCKING) — the new tests pass because their fixture is not the router's shape

`tests/unit/vad-starvation-job-path.test.ts:35-58` — `jobReply()` puts `outcome: "no_engine"`
at the **top level**, beside a `segmentation` block that contains no `outcome`. The real
`GET /route/job/{id}` body is the opposite. The same inversion is in
`tests/unit/route-metrics-truth.test.ts`, which calls `buildRouteMetrics(..., { status, outcome, segmentation })`
with `outcome` as a sibling of `segmentation`.

The fixture was written to match the TS code, not the router, so every assertion about
`outcome`/`engine_no_text`/`engine_text` is self-confirming. The `windows_total`/`windows_skipped`
assertions are sound (those ARE read from `segmentation`), but the outcome assertions would pass
with the production code wrong — and it is wrong.

## F4 (BLOCKING) — `assembleTape` is imported and then deliberately not called

`tests/unit/vad-starvation-job-path.test.ts:124-151`, describe
"reading it cold: the tape separates a window that reached an engine from one that never did".

The test imports `assembleTape`, builds a full `base` input object, and then ends with
`void base; void assembleTape;`. The three-way assertion is made against an **inline
re-implementation** of the production expression:

    const rendered = r.known ? (r.skipped ? "skipped" : "ran") : "unknown";

which is a copy of `lib/room-day/admin.ts:533`. Inverting or deleting the production ternary in
`admin.ts` would not fail this test, or any other: `grep` for `engines_detail` across `tests/`
returns nothing, and the two other `assembleTape` callers (`room-day-tape.test.ts`,
`repeat-runs.test.ts`) predate the merge and do not exercise `metrics_json.route_outcome`.
All 17 changed lines in `lib/room-day/admin.ts` are untested.

## F5 (NON-BLOCKING) — partial starvation is not visible on the surface this merge added

`lib/room-day/admin.ts:119-130, 528-536`. The `TapeSlot` transcript block gains `engines`
("skipped"|"ran"|"unknown") and `engines_detail`, both derived from whole-job fields only.
`windows_total` / `windows_skipped` are read by `readEngineOutcome` and then dropped. A window
with `windows_skipped: 4, windows_total: 5` renders as `engines: "ran"`, `engines_detail: "ok"`
(and never "engine_text", per F1). The counts are on the DB row in `metrics_json`, so a rebuild
by SQL is possible; the operator-facing tape still cannot see partial starvation.

## F6 (NON-BLOCKING) — `engines_skipped` is never cross-checked against the counts

`lib/stt/route-run.ts:168-175`. `engines_skipped` is set purely from `status`/`outcome`. There is
no check that `windows_skipped <= windows_total`, nor that `windows_skipped === windows_total > 0`
implies `engines_skipped`. A reply carrying `windows_total: 5, windows_skipped: 5` with
`status: "ok"` would be stored as `engines_skipped: false` and rendered "ran" by the tape.
The live router is self-consistent here (`job_verdict` derives status from aggregated
`n_engine_segments`), so this is latent, not live.

Zero windows: `num()` is `typeof v === "number" && Number.isFinite(v)`, so `0` stores as `0`, not
null — `windows_total: 0, windows_skipped: 0`. A reply with only those two keys and no status
would be written with `engines_skipped: false` ("ran" on zero windows). Not reachable from the
current router, which returns `status: "silent_skipped"` for an empty `window_results`.

No off-by-one or double counting: `job_verdict` does `windows_total = len(window_results)` and
increments `windows_skipped` once per sub-window whose own `status == "silent_skipped"`, in one
pass. `job_verdict` is called per-iteration inside the loop (router_server.py:828) so a
*running* job carries partial counts, but `state` only becomes `"done"` at line 837 and
`routeAdapter.poll` only reads the result on `state === "done"`.

## F7 (NON-BLOCKING) — route runs with no timeline now acquire an empty `language_timeline` block

`lib/stt/room-drain.ts:1101-1103`. The guard became
`asr.languageTimeline || asr.routerOutcome`. `toSttResult` now sets `routerOutcome` to an object
**unconditionally** on any successful route reply (`lib/stt/adapters/route.ts:96-101`), so that
disjunct is always true for the route engine. Previously a route run whose `language_timeline`
was not an array wrote **no** `language_timeline` key at all; it now writes
`{span_count: 0, engine_mix: {}, language_mix: {}, spoken_seconds: 0, chars: 0, spans: []}`.
The nine other adapters are unaffected (they leave `routerOutcome` undefined), so the stated
"byte-identical for other engines" property holds — but readers of route runs that distinguish
"no timeline key" from "span_count 0" see a changed corpus. The new test
("...is otherwise additive") checks key *names* inside the block, not that an absent block stays
absent.

## What IS sound

- `readEngineOutcome` genuinely withholds the answer: the union has no `skipped` field until
  `known` is true, so "unknown" cannot collapse into "ran" or "skipped" by accident. Legacy rows
  (no `route_outcome` key) read `{known: false}` and do not crash — verified against
  `null`, `{}`, a string payload, and a record missing `engines_skipped`.
- `buildRouteOutcome` is spread last in `buildRouteMetrics`, so a stale record arriving via
  `extra` cannot survive a regeneration. Asserted, and correct.
- `windows_total` / `windows_skipped` do flow end to end on the drain's real transport
  (`routeAdapter.poll` -> `toSttResult` -> `roomWindowPoll` -> `writeRoutedRun` ->
  `buildRouteMetrics`), because they are read from `segmentation`, where the router puts them.
- Emitting no key at all (rather than `engines_skipped: false`) when the router said nothing is
  the right call for backward compatibility.
- `lib/jobs/kinds/route-transcribe.ts` is a standalone job kind; the drain does not use it
  (`roomWindowPoll` is the drain's path), so F2's blast radius is that job kind's results, not
  the room corpus. It also never persists `windows_total`/`windows_skipped`: they are computed
  at line 175 and dropped at `doneWith` (lines 177-196).
