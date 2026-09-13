# C2 Refuter — Round 2 evidence log (scratch)

Commit under test: ed19f9a on vinay/tier2-c2. Clean tree at start.

## Gates I ran myself
- `npx tsc --noEmit` → TSC_EXIT=0, 0 errors.
- `npm run typecheck:tests` → clean, exit 0.
- `npm test` → Test Files 97 passed (97); Tests 2066 passed (2066).
All three Builder numbers reproduce exactly.

## PART 1 — D1-D9

- **D1 FIXED IN THE SLICE STEP, THEN UNDONE BY THE STITCH.** `bindTurnsExclusive`
  (speaker-roles.ts:116-141) reports `exclusive`, and diarize-window.ts:134 refuses a role on
  `!exclusive || seam`. The Refuter's exact case is a real test (c2-diarize-roles.test.ts:99).
  BUT `applyStitch` (diarize-window.ts:191-196) promotes ANY `role='unattributed'` row to
  `'clinician'` when its identity has a clinician. A straddled row IS `role='unattributed'`, and
  the row carries no marker saying WHY it is unattributed, so the stitch cannot tell
  "two speakers held this turn" from "the service matched nobody". See NEW DEFECT 1.
- **D2 FIXED.** ekascribe.ts:135 `async: false`. `DECLARES_ASYNC_WITHOUT_IMPLEMENTING` and its
  bespoke grep are gone (c2-async-seam.test.ts:20 comment confirms); the invariant is unqualified.
- **D3 FIXED in the registry.** `diarize_clip` gone from stubs.ts and tier2-jobs.test.ts:415.
  Registered kinds are transcribe_range, stitch, route_transcribe, room_window, diarize_window +
  4 stubs = 9. LEFTOVER: lib/mcp/tools/jobs.ts:64 still advertises `diarize_clip` to operators and
  omits diarize_window/route_transcribe/room_window. See NEW DEFECT 5.
- **D4 FIXED ARITHMETICALLY, STILL INERT IN PRACTICE.** SLICE_MS=120_000; 8 slices for 900 s;
  sliceFits true for each (225 000 ms vs LEASE_MS 240 000). The enshrining test is gone. But the
  slices load ZERO turns on real data — see NEW DEFECT 2. D4's replacement test passes only
  because its DB mock ignores the WHERE clause.
- **D5 FIXED.** DIARIZE_BATCH_THRESHOLD=0.65 passed as `batchThreshold` on every runDiarize call
  (diarize-window.ts:114). Stitch floor SPEAKER_STITCH_THRESHOLD=0.65 too.
- **D6 FIXED — verified in ephemeral postgres:16 (0074 shape + 0085 verbatim, container removed).**
  REJECTED role='unattributed' WITH clinician_id   → room_turn_speaker_identity_ck
  REJECTED role='clinician', match_confidence=-5   → room_turn_speaker_confidence_ck
  REJECTED role='clinician', clinician_id=''       → room_turn_speaker_clinician_ck
  ACCEPTED role='clinician', 'doc_x', 0.9
  All four round-1 holes closed.
- **D7 FIXED, with a self-contradiction left in the same file.** 0084:45-51 now says the reversal is
  the two UPDATEs and that DELETE is not a rollback. But 0084:32 still lists "0083's safety net"
  among what works without the file. 0083 was deleted in edf27ef. Half-fixed. See NEW DEFECT 6.
- **D8 FIXED.** room-drain.ts:1124 records `router_job_disabled` when that is the submit error,
  `async_submit_failed` otherwise.
- **D9 FIXED.** diarize-window.ts:149 `cluster_id = EXCLUDED.cluster_id` in the DO UPDATE.

### D4's replacement test — is it asserting a mock's shape?
It drives the REAL `sliceBounds` and the REAL `diarizeSlice` (real bindTurnsExclusive, rolesByIndex,
crossesSeam, real INSERT parameter list captured), with only @/lib/db and @/lib/diarize mocked at the
boundary. 8 slices in, 8 rows out. In that sense: genuine, not a mock-shape assertion.
IN THE DECISIVE RESPECT IT IS. The db mock returns `DB.turns` for any query containing "FROM cue",
ignoring the window filter. The real query cannot match (NEW DEFECT 2), so the test asserts 8 rows
where production writes 0. It also never drives the JOB step machine — 8 slice steps + 1 stitch step
advancing through the runner is unproven by it.

## PART 2 — ATTACKS

- **(a) ORDER DEPENDENCE — HELD for well-formed input, BROKE with duplicates.**
  `stitchSpeakers` sorts by (slice, idx) internally, so shuffling the input array gives an identical
  grouping; proved with 3 permutations. BUT with two entries for the SAME (slice, idx) — which a
  re-run produces, see (g) — the answer flips with array order:
    order1 → `0:0 -> rsc_1 doc_y 0.8`   order2 → `0:0 -> rsc_1 doc_x 0.9`
  Two different doctors, same slot, same window, decided by array order.
  Note the doc comment at diarize-slicing.ts:109 says a speaker "joins the FIRST existing identity"
  it matches; the code (line 131 `c > joined.cos`) joins the BEST. Comment is wrong, code is better.
- **(b) ABSENT SPEAKER — HELD.** Present slices 1-3, absent 4-5, back 6-8 → ONE identity.
  Comparison is always against the group's opener, so a gap costs nothing.
- **(c) LATE ARRIVAL — HELD.** A new voice first heard in slice 7 opens its own identity and is
  never named. The same voice arriving late joins and inherits correctly.
- **(d) TWO ENROLLED IDS IN ONE GROUP — HELD, but bypassable.** `ids.size === 1 ? ... : null`
  leaves the group unnamed with null confidence; confirmed. Downstream, applyStitch's CASE requires
  `id.clinician_id IS NOT NULL`, so an unnamed identity changes only cluster_id. Nothing treats
  unnamed as patient: `SpanRole` has exactly two shapes and 'patient' appears nowhere as a role.
  THE BYPASS: the protection only fires when the two ids land in the SAME group. In the duplicate
  case (g) they land in DIFFERENT groups under the SAME map key, so the guard never runs and the row
  gets a confident wrong name.
- **(e) MIN PROPAGATION — BROKE for the opener.** A joiner gets
  min(service, stitch) correctly: `1:0 -> doc_x 0.660`. But when the NAME arrives from a joiner and
  the OPENER was unmatched, the opener's hop is `cosines[0] = 1`, so it records the service number in
  full: `0:0 -> doc_x 0.9`. Its link is opener --0.66--> joiner --0.9--> doc_x, worth <= 0.66.
  This is precisely what diarize-slicing.ts:96-100 says it prevents. See NEW DEFECT 3.
- **(f) PARTIAL FAILURE — THE RULING IS NOT IMPLEMENTED.** The stitch step has no completeness
  check of any kind. Driven directly with 6 of 8 slices stored it returns
  `{"kind":"done","slices":8,"speakers_seen":6,"rows_stitched":6}` — and `slices: 8` comes from
  sliceBounds, not from what was stored, so the result actively misreports 8 slices over 6 slices'
  data. With ZERO slices stored it still returns `{"kind":"done","speakers_seen":0}`.
  The invariant currently lives only in the step ordering: every non-ok slice path returns
  `failWith`, and runner.ts:116 calls `failJob`, which is terminal. So within ONE job a failed slice
  does stop the stitch. Nothing enforces it in the stitch itself, and the cross-job path defeats it.
- **(g) IDEMPOTENCY — BROKE.** Proved in postgres: the DO UPDATE at diarize-window.ts:126-133
  appends `|| [{index:i,...}]` with no dedupe by index, so slice 0 running twice leaves
  `entries=2, indices=[0,0]`. Re-running the stitch over that gives `speakers_seen: 2` for one slot;
  `out.set(key(slice,idx))` collapses them to ONE map entry, last group processed winning.
  REACHABLE WITH NO OPERATOR ACTION: a slice projects to 225 s against a 240 s lease (15 s margin).
  One slow slice → the slice's writes have already committed (plain un-transacted statements) →
  `saveStep` returns 0 rows → runner.ts:118 `lease_lost`, progress NOT advanced → another runner
  re-claims at the same slice_index → the slice re-runs → duplicate index. See NEW DEFECT 4.

## PART 3.1 — SEAM LOSS: NOT COMPUTED, AND WHY

I could not compute this without breaking the repo's data rule, so I did not compute it.
Turn bounds live in the `stt_turn` cue payload, and `buildTurns` (bench.ts:1276-1288) writes
`payload: { text, start_ms, end_ms, ... }` — the transcript text is in the same object. The only
doors are `scribe_list_cues include_payload=true` (returns the payload, text and all) and its
80-char `summary` (first 80 chars of the payload JSON, and `text` is the first key). Both put
transcript text in my transcript, which this repo forbids absolutely. `stt_window_measure` (0071)
carries level-meter ms only — no turn count, no speech ms — so there is no text-free aggregate.
The live DB IS reachable from here through the Scribe MCP door; the block is the data rule, not access.

HAND-OVER: this aggregate returns COUNTS AND MILLISECONDS ONLY — no text, no ids, no labels. I ran
it in ephemeral postgres against a synthetic case with a known answer (5 turns, 3 crossing, one
ending exactly on a boundary correctly NOT counted) and it returned turns=5, turns_crossing=3,
pct_of_turns=60.00, pct_of_speech_seconds=66.67. VERBATIM, and INFERRED as to the live schema:

    WITH t AS (
      SELECT (c.payload->>'start_ms')::bigint           AS s,
             (c.payload->>'end_ms')::bigint             AS e,
             (c.payload->'window'->>'start_ms')::bigint AS ws,
             (c.payload->'window'->>'end_ms')::bigint   AS we
        FROM cue c
       WHERE c.type = 'stt_turn'
         AND COALESCE(c.source,'') <> 'replay'
         AND c.payload ? 'window'
    ), v AS (
      SELECT (e - s) AS dur,
             floor((s     - ws)::numeric / 120000) AS slice_start,
             floor((e - 1 - ws)::numeric / 120000) AS slice_end
        FROM t
       WHERE e > s AND s >= ws AND e <= we
    )
    SELECT count(*)                                                   AS turns,
           round(sum(dur)/1000.0, 1)                                  AS speech_sec,
           count(*) FILTER (WHERE slice_start <> slice_end)           AS turns_crossing,
           round(sum(dur) FILTER (WHERE slice_start <> slice_end)/1000.0, 1) AS speech_sec_crossing,
           round(100.0*count(*) FILTER (WHERE slice_start <> slice_end)/NULLIF(count(*),0), 2) AS pct_of_turns,
           round(100.0*sum(dur) FILTER (WHERE slice_start <> slice_end)/NULLIF(sum(dur),0), 2) AS pct_of_speech_seconds,
           round(avg(dur)) AS mean_turn_ms,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY dur) AS p50_ms,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY dur) AS p95_ms
      FROM v;

ANALYTIC ANSWER, so the ruling is not left unsupported. Slice L=120 s, turn starts ~uniform, turn
duration d: P(cross) = d/L, so
  fraction of TURNS crossing        = E[d]/L
  fraction of SPEECH SECONDS lost   = E[d^2]/(L*E[d]) = (mean/L)*(1+CV^2)
  mean 3 s → 2.5% of turns   mean 4 s → 3.3%   mean 6 s → 5.0%   mean 8 s → 6.7%
  seconds, CV=1: mean 4 s → 6.7%   mean 6 s → 10.0%     CV=0.7: mean 4 s → 5.0%   mean 6 s → 7.5%
READ: a few percent of turns and under ~10% of speech seconds for any plausible whisper segment
length. The seconds cost is about DOUBLE the turn cost, because longer turns are likelier to cross —
so it is not free, but it is not large either. The seam rule is worth its price at 120 s. It would
not be at a much smaller slice: the loss scales as 1/L.

## PART 3.2 — REAL-VECTOR SEPARATION (READ ONLY; no DB write, no enrolment, no wav copied)

Computed twice — once in python, once through the SHIPPED `decodeEmbedding`/`cosine` from
lib/stt/diarize-slicing.ts. Identical to 4 dp. 6 distinct real 192-float32 vectors on disk after
byte-deduping (8 of the 14 files are duplicates of another file's vector).

SAME VOICE (n=1 computable):
  0.9508  fakedocc centroid  vs  fakedocc-enroll.match.json speakers[0]  (a real captured /diarize
                                 response) — PASSES >= 0.65 with 0.30 of margin.

CROSS-DOCTOR (n=14, all pairs, all five doctors):
  0.1653 fakedoce/fakedocg   0.1534 fakedoce/fakedocc  0.1451 fakedoce/fakedocc  0.1357 fakedoce/fakedoci
  0.0620 fakedoce/fakedocb 0.3920 fakedocg/fakedocc    0.3659 fakedocg/fakedocc    0.1751 fakedocg/fakedoci
  0.3021 fakedocg/fakedocb   0.2808 fakedocc/fakedoci 0.1741 fakedocc/fakedocb  0.3114 fakedocc/fakedoci
  0.1717 fakedocc/fakedocb 0.1240 fakedoci/fakedocb
  max = 0.3920, mean = 0.2113, pairs >= 0.65: ZERO. Margin below the floor: 0.2580.

VERDICT ON 0.65: supported by this data. Nothing cross-doctor comes close; the nearest miss is
0.392, which is 0.258 below the floor.
HONEST LIMIT: the Fakedoce holdouts the brief asked for DO NOT CARRY VECTORS on disk. Only the
verdict is recorded — `same_day_holdout[].attached: true`, `next_day[].attached: true,
threshold_used: 0.65`, and `enroll_vs_mean_chunk_embs: 0.944`. So the SAME-VOICE side of this test
rests on ONE computed pair plus two recorded numbers I cannot recompute. Getting the Fakedoce
same-day/next-day cosines needs /diarize on the holdout wavs, which this round forbids.
(Patient labels appear in that metadata as chunk/job names; I have not reproduced them.)

## PART 4 — tsconfig

The exclusion is fine, but THE STRAY FILE IS NOT DELETED — it is COMMITTED.
`docs/handoff/scratch/refuter-straddle.test.ts` is tracked as of ed19f9a (git ls-files confirms).
Removing "docs" from tsconfig.json exclude gives:
  docs/handoff/scratch/refuter-straddle.test.ts(39,13): error TS2339: Property 'diarizeWindow' does
  not exist on type 'typeof import(".../lib/stt/diarize-window")'
So the build IS relying on the exclusion to tolerate a file that should not exist — and that file is
now dead as well as stray, because it calls a symbol the fix renamed away. (tsconfig.json restored.)
Round 1's own probe is the file at fault; I ran this round's probes in tests/unit/ and deleted them.

## NEW DEFECTS

1. **applyStitch reinstates D1's smear.** diarize-window.ts:191-196. A straddled or seam-crossing
   row is `role='unattributed'`; the stitch promotes every such row in the cluster to
   `role='clinician'`. PROVED in postgres with the exact UPDATE:
   BEFORE  straddle/seamcross/nomatch  = unattributed, null, null
   AFTER   all three                   = clinician, doc_x, 0.66
   0085 does not catch it because the stitch sets role and clinician_id together, satisfying every
   check. The 400 ms of patient speech from round 1 is back on the record as the doctor's, one step
   later. The row needs to record WHY it was refused (e.g. role='straddled' / 'seam') so the stitch
   can leave those alone. WORST DEFECT OF THIS ROUND.
2. **The slice steps load ZERO turns on every real window.** `loadWindowTurns` filters
   `payload->'window'->>'start_ms' = $2 AND ->>'end_ms' = $3` (diarize-window.ts:61-62), but
   diarizeSlice passes SLICE bounds (diarize-window.ts:121). `buildTurns` stamps
   `window: asked` — the 900 s WINDOW — on every turn cue (bench.ts:1286). 120 s slice bounds can
   never equal 900 s window bounds. PROVED with a db mock that honours the WHERE clause: 40 real
   turns in the window, 8 slices, turns_loaded=0 on every slice, rows_written=0; control query with
   window bounds loads all 40. measure-job.ts:280-283 does the same join correctly, against WINDOW
   bounds, which is the second witness. So D4 is not fixed in effect: instead of refusing at
   admission the job now makes 8 real /diarize calls (~30 min of Mini time per window, serialized
   behind the depth-1 gate), writes nothing, and reports `done` with turns_named: 0.
3. **The stitch overstates a two-hop identity at the opener.** diarize-slicing.ts:148-152. The
   opener's hop is hard-coded to 1 (`cosines: [1]` at line 135), so when the clinician name arrives
   from a joiner the opener records the service confidence in full (0.9 measured, should be <= 0.66).
   Contradicts the module's own comment at lines 96-100.
4. **A re-run slice duplicates its speakers_json entry, and the stitch trusts both.** Proved:
   `indices=[0,0]`. Reachable with no operator action via lease loss on a 15 s margin (see (g)).
   Consequences: `speakers_seen` inflated; the (slice,idx) map key collapses two different voices to
   one arbitrary winner; and the two-enrolled-ids guard (d) is bypassed because the duplicates sit in
   different groups. Net effect is a confident wrong clinician name chosen by array order.
   The ON CONFLICT should replace the entry for index i, not append.
5. **The MCP job door advertises a kind that no longer exists.** lib/mcp/tools/jobs.ts:64 lists
   `diarize_clip` (deleted in this commit) and omits `diarize_window`, `route_transcribe` and
   `room_window`. It also still says "five of the seven kinds"; there are 9 registered, 4 stubs.
   diarize_window is operator-submitted by design, so the door not naming it matters.
6. **0084 still cites the deleted 0083 at line 32** while lines 45-51 of the same file correctly say
   0083 was deleted on purpose. One file, two answers.

## What HELD under attack
- roleForSpeaker still reads only clinician_id + confidence, both required, id trimmed; index is a
  lookup key and never an input. Reordering/relabelling speakers changes nothing.
- No usable embedding ⇒ own identity, never named. cosine returns null on length mismatch and on a
  zero vector, so an unusable vector cannot become a match.
- 'patient' is not a role anywhere; SpanRole has exactly two shapes.
- Both shipped floors are 0.65, and 0.65 is separated from real cross-doctor data by 0.258.
- Embeddings go to room_diarize_window.speakers_json, not to `progress` — a read-scope token cannot
  list a voiceprint via scribe_job_status.
- A failing slice step is terminal within its job (failWith → runner.ts:116 failJob).
