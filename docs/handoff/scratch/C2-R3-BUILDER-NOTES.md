# C2 fix round 3 — Builder notes (scratch)

## Item 0 — the e2e test, and what it caught
tests/unit/c2-e2e-runner.test.ts + tests/support/pg-harness.ts.
Ephemeral `postgres:16` (container eta-c2-e2e, `docker rm -f` in afterAll; `docker ps -a` → 0 rows).
No raw-Postgres driver exists in this repo (only @neondatabase/serverless), so the harness proxies
the `sql` tagged template through `psql` inside the container. Real DDL: 0082 verbatim, 0074's
room_turn_speaker + room_diarize_window verbatim, 0085 verbatim. Faked: /diarize, R2, join service.

Order of discovery while building it — every one a REAL behaviour, not a harness artefact:
1. pg_isready answers YES during the image's own bootstrap, before initdb restarts the server.
   Fixed with two consecutive successful SELECTs.
2. json_agg pretty-prints and COPY escapes the newlines, so the JSON that came back was not the
   JSON that went in. Fixed with compact jsonb_agg and no COPY.
3. 0074's tables carry REFERENCES bench_window(id) — app tables must be created first.
4. `no_audio_in_range`: the window is epoch 0..900000, so the seeded chunk must cover that.
5. **rows_stitched: 0 — DEFECT 1, caught exactly as intended.**
Mutation proof: reverting the applyStitch/applyClusterIds swap reproduces
`expected 0 to be greater than 0` on rows_stitched.

The fixture had to be made harder before it could catch D1 at all: with the service matching the
clinician in EVERY slice there is nothing to propagate, and rows_stitched is legitimately 0. It now
matches on even slices only, which is what a borderline cosine does in practice.

## Snap sweep (4000 layouts, shipped code vs the R2 algorithm reimplemented as an oracle)
    layouts=4000 interior_cuts=31767 splits_before=926 splits_after=0 over_cap=0
"before" is 926 here against the Refuter's 2732 — different random layout generator, same
direction and same conclusion. after=0 because with a 110 s stride and ±10 s, a clean edge is
almost always reachable in these layouts; the fallback path is still exercised by the
one-900-s-turn case, which produces hard cuts and no over-cap.

## stt_turn recheck — NO type filter, NO source filter
6 rooms x 7 IST dates = 42 room-days through scribe_list_cues, include_payload=true, limit 500,
counts only into the transcript.
    cues of ANY type: 7        stt_turn cues: 0        by source: n/a
The Refuter's TURN_CUE_SOURCE="replay" correction is real but changes nothing here: I applied no
source filter of any kind and the count is still zero. There are no turn cues in the live database.

## What the plan freeze looks like
`readPlan(ctx.progress)` first; only if absent does the step call loadWindowTurns +
snappedSliceBounds. Every returned progress carries `slice_plan: writePlan(slices)`. The stitch
branch contains no call to snappedSliceBounds at all (asserted).
