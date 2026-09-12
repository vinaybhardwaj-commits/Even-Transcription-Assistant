# C2 Refuter — Round 3 evidence log (scratch)

Commit under test: 7dea3bb on vinay/tier2-c2. Clean tree at start and at finish (HEAD unmoved).
All probes written under tests/unit/__r3probe/ and DELETED afterwards; ephemeral postgres removed.

## Gates I ran myself
- `npm run typecheck` → exit 0, 0 `error TS` lines.
- `npm run typecheck:tests` → exit 0, 0 `error TS` lines.
- `npm test` → exit 0. Test Files 97 passed (97); Tests 2074 passed (2074).
All three Builder numbers reproduce exactly. (Note: `$?` after a pipe reads the LAST command's
status, so the first tsc run I did was re-run writing to a file to get a true exit code.)

## PART 1 — D1..D6

- **D1 — RULE FIXED, REACHABILITY ZERO.** `applyStitch` (diarize-window.ts:239-251) keys on
  `no_role_reason = 'no_match'`, so straddle and seam rows survive. The test at
  c2-diarize-roles.test.ts:311 does assert ON THE ROWS AFTER the UPDATE (`byRef.get(...)!.role`),
  not on the return value — the brief's first question: YES.
  BUT it drives `applyStitch` IN ISOLATION. Production runs `applyClusterIds` FIRST
  (lib/jobs/kinds/diarize-window.ts:104-105), which rewrites `cluster_id` from `s0:0` to `rsc_0`;
  `applyStitch` then searches `cluster_id = 's0:0'` and matches nothing.
  PROVED by driving the real stitch branch with a row store honouring both UPDATEs:
    as shipped   → rows_stitched: 0, both no_match rows keep role NULL
    lines swapped→ rows_stitched: 2, straddle + seam STILL untouched
  Instrumented SQL, as shipped:
    R3_SQL_CLUSTERIDS {"win":"bw_1","cluster":"s0:0","to":"rsc_0"}
    R3_SQL_CLUSTERIDS {"win":"bw_1","cluster":"s1:0","to":"rsc_0"}
    R3_SQL_STITCH     {"win":"bw_1","cluster":"s0:0","cid":"doc_x"}   -> 0 rows
    R3_SQL_STITCH     {"win":"bw_1","cluster":"s1:0","cid":"doc_x"}   -> 0 rows
  So the smear cannot recur in production — because the stitch writes nothing at all.
  MY OWN MOCK WAS WRONG FIRST TIME: applyStitch's query ALSO begins
  "UPDATE room_turn_speaker SET cluster_id", so my first branch swallowed it and I briefly read a
  false 0 for the swapped control too. Corrected by testing the stitch branch first. See DEFECT 1.
- **D2 — FIXED, AND COUNTED.** loadSliceTurns (diarize-window.ts:71-83) identifies the window by
  `payload->'window'` and SELECTS on the turn's own bounds, overlapping. The test counts
  `seen.size === 40` over real `snappedSliceBounds` output with a fake that honours the predicate
  (tests/unit/c2-diarize-roles.test.ts:74-97 — I read the fake; it applies both window and slice
  predicates). `outcome.turns = turns.length` is per slice. diarize-job.ts:353-362 is an
  independent third witness with an identical predicate.
  DOUBLE-WRITE: a turn crossing a boundary IS loaded by BOTH slices and written twice. Proved
  (118 000-122 000 across the 120 000 cut):
    R3_D2B_SLICE 0 {"turns":1,"bound":1,"named":0,"seam_skipped":1}
    R3_D2B_SLICE 1 {"turns":1,"bound":1,"named":0,"seam_skipped":1}
    writes: [{ref:"cross",cluster:"s0:0",role:null,why:"seam"},{ref:"cross",cluster:"s1:0",role:null,why:"seam"}]
  Both writes are identical except cluster_id and both say 'seam', and production's
  ON CONFLICT (window_id, source_ref) collapses them to one row (the later slice's cluster_id).
  No smear. But `seam_skipped` is counted once PER SLICE for one turn, so the job's
  `turns_seam_skipped` double-counts every boundary-crossing turn. See DEFECT 4.
- **D3 — FIXED.** diarize-slicing.ts:194 `cosines: [cosine(emb, emb) ?? 0]`, and 210-218 bound the
  claim by min(sourceConf, weakestNamedHop, ownHop). Test at :346 asserts <= 0.67 for an opener
  named through a 0.66 joiner. No hard-coded 1 remains.
- **D4/(g) — FIXED IN THE STATEMENT, NOT ENFORCED ANYWHERE.** The ON CONFLICT at
  lib/jobs/kinds/diarize-window.ts:156-162 strips index i with
  `WHERE (e->>'index')::int <> $i` then appends. The test for it (:427) is a SOURCE GREP plus a
  pure-JS re-implementation of strip-then-append — it never executes the SQL. And the stitch's own
  self-check does not test uniqueness: fed `[0,0,1..7]` it reports `slices: 9` and PROCEEDS.
- **D5 — FIXED.** lib/mcp/tools/jobs.ts builds its enum and prose from JOB_KIND_NAMES /
  STUB_KIND_NAMES; the test asserts set equality and the absence of `diarize_clip`.
- **D6 — FIXED.** 0084:32 no longer cites "0083's safety net"; 0084:45 still narrates the deletion.
  One file, one answer now.

## PART 2 — ATTACKS

### (a) SNAPPING — HELD on every invariant; the forward half of the window is unreachable.
10 hand-built adversarial layouts + 4000 randomised layouts. In ALL of them:
  slice length <= 120 000 ms          violations: 0
  boundaries strictly monotonic       violations: 0
  slices tile [start,end): no hole, no coverage overlap, index sequential   violations: 0
  cut equals the nearest legal clean edge, or the nominal mark when none    suboptimal: 0
    (checked against an independently recomputed oracle, not the shipped code)
Hand cases, all maxLen 120000 / overCap 0 / tiles true / mono true:
  A turn longer than 120 s (0-300 000)          8 slices, 2 cuts inside a turn, 7 on the clock
  B every candidate splits a turn (130 s turns)  8 slices, 7 cuts inside a turn  -> fallback taken
  C clean gap EXACTLY at nominal +10 000         8 slices, cut stayed at 120 000, SPLIT a turn
  D clean gap EXACTLY at nominal +10 001         identical to C
  E clean gap EXACTLY at nominal -10 000         SNAPPED to 110 000; cascades to 9 slices
  F clean gap at nominal -10 001 (109 999)       NOT snapped (correctly outside)
  G all turns in the first 200 s                 8 slices, 0 cuts inside a turn
  H no turns at all / I one 900 s turn / J happy case   all clean
THE FINDING: `hi = Math.min(from + sliceMs, nominal + snapMs)` and `nominal = from + sliceMs`, so
`hi === nominal` ALWAYS. The snap window is [-10 000, 0], never ±10 000. Cases C and D are
therefore indistinguishable — the "+10 s vs +10.001 s" boundary the brief asked about does not
exist, because no forward snap is reachable at any offset. The cap is RIGHT to outrank (a forward
edge would make the slice exceed 120 s and break the 225 000 vs 240 000 arithmetic), but the
docstring at diarize-slicing.ts:70 and the commit message both say "±SNAP_WINDOW_MS" / "±10 s",
which is false. Cost, measured: in the 4000-case sweep, 2732 interior cuts landed INSIDE a turn
while a clean edge existed within (nominal, nominal+10 000]. See DEFECT 3.

### (b) BRANDED TYPES — NOT DECORATIVE. 24 of 26 escape paths blocked by tsc.
BLOCKED: direct assignment; spread of a SliceBound; spread-over-window-then-override; destructure
and reassemble; array index (union `SliceStartMs | SliceEndMs`); tuple index; generic identity
`<T>(x:T)=>x`; generic constrained `<T extends number>`; inferred object literal of plain numbers;
plain numbers inline; arithmetic `SL.start + 0`; `Math.min`/`Math.max` laundering; `ms()` round trip
with NO re-assertion; the REVERSE (window bound into the slice parameter); reverse via spread;
`snappedSliceBounds(...)[0]` straight into the window parameter; `Record<string,SliceBound>`
indexed access; union narrowing; `satisfies`; a function typed `(x: SliceStartMs) => number`;
`Object.assign({}, SL)`; a `Plain {start:number;end:number}` interface; mixed brands in one literal.
Errors are TS2322 on the field and TS2345 on the whole argument.
COMPILED (the two holes):
  1. `JSON.parse(JSON.stringify(SL))` — returns `any`, which defeats any brand. Universal `any`
     hole, not specific to these types. NOT reachable in shipped code: the only `as` casts on these
     types are the four constructors inside window-bounds.ts itself (grep confirms), and the only
     four constructor call sites are diarize-window.ts:69 and diarize-slicing.ts:50, 93, 104 —
     each at the point where the answer is genuinely known.
  2. `sliceStart(ms(WIN.start))` — a FALSE assertion at the constructor. This is the brand's
     inherent limit: it proves someone DECLARED which quantity a number is, never that the
     declaration is true. Reintroducing D2 as `sliceStart(windowNumber)` would compile silently.
     (`windowStart(ms(SL.start))` is the same shape and is the intended escape hatch.)
VERDICT: load-bearing, and it does block every structural path a careless edit would take.

### (c) STITCH SELF-CHECK — HELD on missingness, one-sided on everything else.
  two NON-ADJACENT deletions (2 and 5) → fail: "stitch refused: 2 of 8 slices missing (2,5)"
                                          BOTH indices named. HELD.
  zero stored                           → fail: "8 of 8 slices missing (0,1,2,3,4,5,6,7)"
                                          (R2's "done with speakers_seen 0" is gone)
  all 8 present                         → done, slices: 8, slices_planned: 8
  an EXTRA entry index 99 + all 8        → done, slices: 9, slices_planned: 8  — PROCEEDS
  duplicate index 0 (`[0,0,1..7]`)       → done, slices: 9, slices_planned: 8  — PROCEEDS
`slices` is the OBSERVED count (`entries.length`) in every branch that reports one, and
`slices_planned` is reported separately and never substituted — the brief's question: YES.
THE FAILURE BRANCH REPORTS NO OBSERVED COUNT AT ALL. Its message is
`${missing.length} of ${slices.length}`, and `slices.length` is the PLANNED count. That is the
right denominator for "how many are missing", but a reader of the failure never learns that 6 were
stored. And the check tests PRESENCE only — never uniqueness, never that an index is in the plan.

## PART 3 — 0085 IN A REAL POSTGRES
Method: ephemeral `postgres:16` (container c2r3pg, port 55439), `schema_migrations` + the
room_turn_speaker DDL copied verbatim from db/migrations/0074:138-156, then
db/migrations/0085_room_turn_speaker_role.sql piped in VERBATIM, no edits. Container `docker rm -f`
at the end; `docker ps -a` shows 0 rows for the name. All six CHECK constraints installed.

role NULL <-> no_role_reason:
  REJECTED  role NULL, reason NULL                      room_turn_speaker_no_role_ck
  ACCEPTED  role NULL, reason 'straddle' / 'seam' / 'no_match'
  REJECTED  role 'clinician' + reason 'no_match'        room_turn_speaker_no_role_ck
  ACCEPTED  role 'clinician' + reason NULL
no_role_reason vocabulary — all REJECTED by room_turn_speaker_reason_ck:
  'unattributed', 'patient', '', 'STRADDLE' (case), 'straddle ' (trailing space)
round-1 constraints, still holding:
  REJECTED  role clinician, NO clinician_id             room_turn_speaker_clinician_ck
  REJECTED  role clinician, NO match_confidence         room_turn_speaker_clinician_ck
  REJECTED  match_confidence -5                         room_turn_speaker_confidence_ck
  REJECTED  match_confidence 1.5                        room_turn_speaker_confidence_ck
  REJECTED  clinician_id ''                             room_turn_speaker_clinician_ck
  REJECTED  clinician_id '   ' (whitespace)             room_turn_speaker_clinician_ck
  REJECTED  role 'patient'                              room_turn_speaker_role_ck
  REJECTED  role 'unattributed' (the R1 value)          room_turn_speaker_role_ck
TWO THAT DID NOT HOLD — the converse constraint went vacuous:
  ACCEPTED  clinician_id 'doc_x', role NULL, reason 'no_match'     <- must reject
  ACCEPTED  match_confidence 0.9, role NULL, reason 'no_match'     <- must reject
  Row on the table afterwards: d7 | (role null) | doc_x | | no_match
  CAUSE, computed in the same postgres:
    room_turn_speaker_identity_ck = CHECK ((clinician_id IS NULL AND match_confidence IS NULL)
                                            OR role = 'clinician')
    first disjunct            -> false
    NULL::text = 'clinician' -> NULL
    FALSE OR NULL            -> NULL
    and a SQL CHECK PASSES unless it evaluates to FALSE.
  So identity_ck is vacuous for EVERY row with role IS NULL — exactly the rows it was written to
  police. This is a REGRESSION introduced by this commit: in R2 the unattributed row carried
  `role='unattributed'`, so the comparison was FALSE and the check bit (R2 verified that REJECTION
  in this same harness). Moving to `role IS NULL` silently disabled it. 0085:15-17 claims "no row
  can carry a name it does not assert"; as written, a row can.
  Fix shape: `OR COALESCE(role,'') = 'clinician'`, or `OR role IS NOT DISTINCT FROM 'clinician'`.
  (room_turn_speaker_clinician_ck goes vacuous on role IS NULL for the same reason, but that one
  only ever intended to constrain rows claiming clinician, so its vacuity is harmless.)

THE SMEAR AS SQL — three forms, against the live constraints:
  FORM 1  the R2 defect-1 UPDATE, evidence left in place:
          UPDATE room_turn_speaker SET role='clinician', clinician_id='doc_x',
                 match_confidence=0.66 WHERE window_id='w' AND role IS NULL
          -> REJECTED, room_turn_speaker_no_role_ck. The database DOES catch this exact shape.
  FORM 2  the same UPDATE, erasing the evidence as it goes:
          UPDATE room_turn_speaker SET role='clinician', clinician_id='doc_x',
                 match_confidence=0.66, no_role_reason=NULL
           WHERE window_id='w' AND role IS NULL
          -> ACCEPTED. All three rows — straddle, seam, no_match — became doc_x @ 0.66.
  FORM 3  a turn the CODE knows was straddled, inserted as a clean clinician row:
          INSERT ... VALUES ('w','straddle_asserted',0,'doc_x','clinician',0.66,NULL)
          -> ACCEPTED.
PLAINLY: the database can catch a smear that FORGETS TO ERASE ITS EVIDENCE, and nothing more.
`no_role_reason` is a fact the code authors; postgres has no independent knowledge that a turn was
straddled or crossed a seam, so a writer that sets the role and clears the reason in one statement
satisfies every constraint. Only the code can catch the smear. 0085 is worth having — it converts
the precise R2 regression into a constraint violation — but it is not a backstop for the class.

## PART 4 — THE DORMANT DEPENDENCY TRACE
Traced, not assumed. Write path: room-drain.ts:471/575 `startMs = Number(w.start_ms)`,
`endMs = Number(w.end_ms)` read from the SAME `bench_window` row the diarize job reads
(lib/jobs/kinds/diarize-window.ts:28-32, 69). room-drain.ts:854-861 passes those as
`windowStartMs`/`windowEndMs` to `buildTurns`, which at bench.ts:1241-1243 floors them into
`asked = {start_ms, end_ms}` and stamps `window: asked` on EVERY cue of the window
(bench.ts:1283). `writeWindowCues` (bench.ts:1494) sends `room_day_id = w.room_day_id` — again the
same bench_window row — and `asBatchCue` (bench.ts:1460) carries `source_ref` explicitly.
So all four join keys line up: type, room_day_id, payload.window bounds (integer = integer, both
cast ::bigint), source_ref non-null. diarize-job.ts:353-362 runs a predicate identical in every
clause, which is an independent witness for the shape.
Corrected from my own R2 notes: TURN_CUE_SOURCE is `"replay"` (bench.ts:1146), so my R2 seam-loss
aggregate's `COALESCE(c.source,'') <> 'replay'` would have excluded EVERY turn cue. loadSliceTurns
and loadWindowTurns do not filter on `source` at all, so they are unaffected — but they will also
diarize genuinely replayed cues, which nothing currently distinguishes.
ANSWER: the JOIN needs no further code change. The ATTRIBUTION does — there are two further
dependencies and neither is a matter of stt_turn filling:
  1. DEFECT 1. Per-slice attribution from the service's own match still lands (diarizeSlice writes
     role='clinician' where the service matched). The CROSS-SLICE STITCH writes nothing, ever, so
     a doctor recognised in slice 3 and not in slice 4 stays unnamed in slice 4. Code change.
  2. ENROLMENT. loadClinicianCentroids (diarize-window.ts:39-47) reads
     `voice_print WHERE centroid IS NOT NULL` (table from 0007; the `scribe_voice_print` in the
     brief is the MCP tool name `scribe_list_voiceprints`, not a second table — no mismatch). With
     an empty centroid list the service matches nobody and EVERY row is 'no_match'. Whether
     voice_print.centroid is populated live is not something I can see from here and this round
     forbade loading one. Data, not code — but it gates the whole feature.
Not dependencies: SPEAKER_CLUSTERS_ENABLED (grep: referenced only in speaker-clusters.ts:227-231
and diarize-job.ts:107; diarizeWindowKind is in JOB_KINDS at kinds/index.ts:19 with no env gate),
and 0084 (unrelated to this join).
Conditional: `bench_window.room_day_id` must be non-null or the job fails "window has no room_day"
(bench-window.ts:367 backfills it when a roomDayId is known).

## NEW DEFECTS

1. **applyClusterIds consumes the key applyStitch matches on; `rows_stitched` is always 0.**
   lib/jobs/kinds/diarize-window.ts:104-105. applyClusterIds rewrites `cluster_id` from `s<slice>:<idx>`
   to the stitched `rsc_N`; applyStitch's WHERE is `cluster_id = 's<slice>:<idx>'`, which then
   matches nothing. PROVED against a row store honouring both UPDATEs: as shipped rows_stitched 0;
   with the two lines swapped rows_stitched 2, and straddle/seam still untouched. The entire
   cross-slice propagation — the point of C2 Part B's stitch step — is inert, and the D1 test
   passes because it calls applyStitch in isolation, never in the job's order. Same failure shape
   as R2 D2: a predicate that cannot be true. Fix: swap the two lines (verified sufficient and
   safe), and add one test that drives the stitch BRANCH rather than the function.
   WORST DEFECT OF THIS ROUND.
2. **0085's converse constraint is vacuous for every row it exists to police.**
   identity_ck evaluates to NULL when role IS NULL (FALSE OR NULL = NULL; a CHECK passes on NULL),
   so `clinician_id='doc_x', role=NULL` and `match_confidence=0.9, role=NULL` are both ACCEPTED in
   a real postgres. A regression against R2, which verified that rejection when the column held
   'unattributed'. 0085:15-17 states the opposite of what it enforces.
   Fix: `OR COALESCE(role,'') = 'clinician'`.
3. **The snap window is one-sided, and both the doc and the commit message say it is not.**
   diarize-slicing.ts:96 `hi = Math.min(from + sliceMs, nominal + snapMs)` with
   `nominal = from + sliceMs` gives `hi === nominal` always, so the reachable window is
   [-SNAP_WINDOW_MS, 0]. The cap is right to outrank; the CLAIM of "±SNAP_WINDOW_MS"
   (diarize-slicing.ts:70) and "±10 s" (commit message) is wrong. Measured cost: 2732 of the
   interior cuts in a 4000-layout sweep split a turn while a clean edge existed within
   (nominal, nominal+10 000]. Recoverable by walking nominal marks at SLICE_MS - SNAP_WINDOW_MS so
   the whole ± range fits under the cap — a design call, flagged not decided.
4. **`turns_seam_skipped` double-counts every boundary-crossing turn.** A turn crossing a slice
   edge is loaded by both slices by design, and each slice counts it in `outcome.seam_skipped`;
   lib/jobs/kinds/diarize-window.ts:171 accumulates both. Proved: one turn, seam_skipped 1 in
   slice 0 and 1 in slice 1, progress 2. `outcome.turns` per slice double-counts the same way.
   The ROW is correct (ON CONFLICT collapses to one, marked 'seam'); only the counters lie.
5. **The slice plan is derived state recomputed on every step, and drifts.**
   lib/jobs/kinds/diarize-window.ts:72-73 calls loadWindowTurns + snappedSliceBounds on EVERY step,
   including the stitch. The window-as-unit re-drain DELETEs and re-INSERTs all stt_turn cues for a
   window (brain/state.ts:288 WINDOW_DELETED_TYPES) and Whisper is explicitly non-deterministic —
   162 vs 165 segments, bench.ts:1466-1469 — so a re-drain concurrent with a diarize_window job
   changes the plan underneath it. PROVED both directions:
     9 slices ran, plan recomputed to 8  -> done, slices: 9, slices_planned: 8. PROCEEDS, stitching
       speakers whose audio geometry came from a different plan under the same index space.
     8 slices ran, plan recomputed to 9  -> fail, "stitch refused: 1 of 9 slices missing (8)" on a
       window that ran every slice it was told to run.
   Fix shape: plan once at the first slice step and carry the bounds in `progress`.
6. **The stitch self-check tests presence only.** An entry whose index is not in the plan
   (`[0..7,99]`) and a duplicated index (`[0,0,1..7]`) both PROCEED and both inflate `slices` to 9.
   Uniqueness and plan-membership are the two halves it does not check — and uniqueness is the
   invariant D4/(g)'s SQL exists to maintain, so nothing tests that the SQL worked. Related: the
   D4/(g) test (c2-diarize-roles.test.ts:427) is a source grep plus a JS re-implementation; it
   never executes the jsonb statement it is asserting about.
7. **The failure branch of the stitch reports no observed count.** "2 of 8 slices missing" uses the
   PLANNED denominator and never states that 6 were stored. Minor, but the brief asked.

## What HELD under attack
- Every snapping invariant, in 10 adversarial layouts and 4000 random ones: cap, monotonicity,
  exact tiling (no hole, no coverage overlap), sequential indices, and optimality of each cut
  against an independently recomputed oracle.
- The fallback to a hard cut is taken exactly when no legal clean edge exists, and never otherwise.
- The turn-selection overlap does NOT produce a smear: both writes say 'seam' and ON CONFLICT
  collapses them to one row.
- 24 of 26 branded-type escape paths blocked; the 2 that compile are `any` (unreachable in shipped
  code) and a false assertion at a constructor (inherent to brands).
- `slices` is the observed count in every branch that reports one; `slices_planned` is never
  substituted for it.
- Two non-adjacent missing slice indices are both named; a zero-slice stitch now refuses.
- D3's weakest-hop bound, D5's registry-derived job door, D6's 0084 consistency.
- 0085 rejects the entire round-1 set, the whole no_role_reason vocabulary including case and
  trailing space, and the naive form of the R2 defect-1 UPDATE.
