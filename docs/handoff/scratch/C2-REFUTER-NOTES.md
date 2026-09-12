# C2 Refuter — evidence log (scratch)

## Gates I ran (5bcc862, clean tree)
- `npx tsc --noEmit` → TSC_EXIT=0, 0 errors.
- `npm test` → typecheck:tests clean; Test Files 97 passed (97); Tests 2061 passed (2061); TEST_EXIT=0.
All three Builder numbers reproduce exactly.

## D1 — ruling 2 violated (PROVEN, not read)
Probe: turn 0–1000ms; segs idx0 0–600 (MATCHED doc_fake0001), idx1 600–1000 (unmatched).
Boundary at 600 is strictly inside the turn. Row written:
  {"source_ref":"straddle","speaker_idx":0,"overlap_ms":600,
   "clinician_id":"doc_fake0001","role":"clinician","match_confidence":0.82}
400ms of patient speech recorded wholesale as the clinician. `bindTurnsToSpeakers`
(lib/stt/speaker-clusters.ts:201-221) is UNCHANGED from base — pure overlap-max, ties to lower idx.
diarize-window.ts:12-13 admits the smear in prose and ships it. Builder test
c2-diarize-roles.test.ts:110 asserts the smear ("binds each turn to the speaker it overlaps most");
its geometry (turns 1000-3000/4000-6000 vs segs 1000-3500/4000-6500) never straddles. No straddle test exists.

## D2 — ruling 1 not implemented
lib/stt/adapters/ekascribe.ts:131 still `async: true`; no submit/poll on the adapter.
c2-async-seam.test.ts:25 exception set `DECLARES_ASYNC_WITHOUT_IMPLEMENTING = new Set(["ekascribe"])` present;
:38 asserts violations EQUAL that set; bespoke test :43-49 present and is a pure source grep (:46-48).
BREAK PROOFS (general invariant is real, both directions):
- whisper.ts:6 async:false→true  ⇒ "expected Set{'whisper','ekascribe'} to deeply equal Set{'ekascribe'}" (1 failed | 7 passed)
- route.ts:150 submit renamed    ⇒ "expected Set{'ekascribe','route'} to deeply equal Set{'ekascribe'}" (3 failed | 5 passed)
Both files restored from docs/handoff/scratch/*.bak; tree clean.

## D3 — ruling 3 not implemented
lib/jobs/kinds/stubs.ts:42 `stub("diarize_clip", "invoke", ...)` still registered.
tests/unit/tier2-jobs.test.ts:413,415 still carry it in the EXACT kind list. Two kinds, not one.

## D4 — diarize_window is inert on every real room window
LEASE_MS=240_000 (lib/jobs/types.ts:38). WINDOW_MS=900_000 (lib/bench-window.ts:84).
diarizeFits: 900*1.5*1000+45_000 = 1_395_000 > 240_000 ⇒ REFUSED.
Max audio that fits = (240000-45000)/1500 = 130 s. Every 15-min room window fails
`diarize_would_exceed_budget` at admission. No sub-window split path exists; the kind takes window_id only.
Builder KNEW: c2-diarize-roles.test.ts:162-166 asserts diarizeFits(900).fits === false as correct.
So "the first live speaker attribution this system has had" cannot fire on production data.

## D5 — validated threshold 0.65 is never sent
diarize-window.ts:97-100 calls runDiarize with {encounterId, clinicianCentroids} only.
lib/diarize.ts:187 sends batch_threshold ONLY if opts.batchThreshold is a number.
~/eta-diarize/server.py:134 `batch_threshold: float = Form(0.70)`.
Live threshold is therefore the service's undeclared default 0.70, not the validated 0.65.
Fail-safe in direction (stricter ⇒ fewer attributions) but it is an unvalidated number governing identity,
in a codebase whose readThreshold() (speaker-clusters.ts:251) refuses to default this exact class of value.

## 0085 CHECK — tested in ephemeral postgres:16, 0074 shape + 0085 DDL verbatim (container removed)
ACCEPTED  role=clinician + id + conf
REJECTED  role=clinician, NO clinician_id      → room_turn_speaker_clinician_ck
REJECTED  role=clinician, NO match_confidence  → room_turn_speaker_clinician_ck
REJECTED  role=clinician, neither              → room_turn_speaker_clinician_ck
REJECTED  role='doctor'                        → room_turn_speaker_role_ck
ACCEPTED  role=unattributed / role=NULL, both identity cols null
D6 holes (schema does not enforce what 0085's comment claims):
ACCEPTED  role='unattributed' WITH clinician_id='doc_x'   (indexed by idx_room_turn_speaker_clinician)
ACCEPTED  role=NULL           WITH clinician_id='doc_x'   (same index; identity with no claim)
ACCEPTED  match_confidence=-5 and 0.01 with role=clinician (no range, no threshold floor)
ACCEPTED  clinician_id='' with role=clinician              (empty string is NOT NULL)
Current TS never writes these (roleForSpeaker trims + pairs), so gaps are schema hardness, not live defects.
Answer to the brief: YES, it rejects a role without a clinician_id. It does NOT constrain the converse.

## 0084
Created for C1 step 6: flips stt_routing room rows english+indic from sarvam to `route`.
Held by its own header: the drain transcribed a 900 s window inline under a 300 s route ceiling.
That named blocker ("the drain must ENQUEUE a route_transcribe job") LANDED in C1 (6b2347e) and C2
Part A moved it behind adapter.submit/poll with router_job_id persisted before anything else can fail,
so the resubmit-on-retry concern is addressed too.
D7 stale premise: 0084:44-45 rests its reversal on "0083's (room,'default') row". 0083 was created in
df1fd49 and DELETED deliberately in edf27ef (a default row "would have turned a loud no_engine into a
silent" fallback). No migration creates a (room,'default') stt_routing row now. 0084's stated safety net
does not exist, so the documented DELETE-both-rows reversal would yield no_engine, not sarvam.
0085 DEPENDENCY: none. 0085 only ALTERs room_turn_speaker; it touches stt_routing nowhere and applies
independently of 0084. (Functionally the diarize job is operator-submitted, not gated on the route switch.)

## D8 — kill-switch observability regression
room-drain.ts previously recorded detail "router_job_disabled" when ROUTER_JOB_ON() was false.
That branch is deleted; the switch now returns ok:false from routeAdapter.submit and the job row
records "async_submit_failed". Kill switch still works; the row can no longer distinguish
"we turned it off" from "the provider broke".

## D9 — minor, cluster_id drift
diarize-window.ts:126-131 ON CONFLICT DO UPDATE replaces speaker_idx but not cluster_id.
A row first written by diarize-job.ts:378 (which uses ON CONFLICT DO NOTHING, so it never clobbers a
role — that direction is safe) keeps a cluster_id from the older clustering while speaker_idx is replaced.

## Invariant attack — what HELD
- roleForSpeaker reads only clinician_id + confidence; requires BOTH; trims blank ids. Index never an input.
- server.py:218-225 sets clinician_id/confidence together and only at/above batch_threshold — trust warranted.
- Missing/empty speakers[] ⇒ empty role map ⇒ every span UNATTRIBUTED. Error path returns before any write.
- Only two writers to room_turn_speaker; the older one cannot overwrite a role (DO NOTHING).
- MCP scribe_window_speakers returns no transcript text; counts, ids, timings only.
- SttAsyncInput keeps BOTH audioUrl and audio (types.ts) — ruling 4 intact.
