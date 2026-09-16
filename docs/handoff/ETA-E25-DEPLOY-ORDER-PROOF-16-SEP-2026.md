# ETA-E25 — The deploy-order constraint, proven by execution · 16 Sep 2026 · Builder

Worktree `-e16`, branch `vinay/e16-emotion-speech-fraction`, on top of `cb35001`. Everything below ran against
EPHEMERAL postgres:16 containers started and removed by the test harness. No live database was written. No
migration was applied anywhere but those containers. Items 1–3 are a committed test,
`tests/unit/e25-deploy-order.test.ts`. Item 4 ran from a scratch file that was deleted after it ran; its output is
quoted verbatim here.

## 1. The break — real error text, pre-0099

Schema: everything E24 depends on except 0097 and 0099 (0057, 0074's two tables, 0085, 0088, 0089, 0090), which is
where production stood on 15 Sep 2026 (highest recorded migration 93).

**Path A — the diarize INSERT** (`recordDiarizeWindow`, E24 code):

```
ERROR:  column "segments_run_id" of relation "room_diarize_window" does not exist
LINE 2: ...room_day_id, state, speakers_json, segments_json, segments_r...
```

**Path B — the emotion prepare SELECT** (`emotion_window` job, step `prepare`):

```
ERROR:  column d.segments_run_id does not exist
LINE 1: ...AS diarize_state, d.last_run_id, d.segments_json, d.segments...
```

The job does not crash the runner: the kind catches it and fails by name, with the database's message truncated
to 160 characters —

```
{"kind":"fail","error":"emotion_window_failed: prepare: Command failed: ...\nERROR:  column d.segments_run_id does not exist\n"}
```

So the observable shape of a reversed deploy is: **every diarize window job fails at its window-row write, and
every emotion window job fails at `prepare`, named `emotion_window_failed`.** Nothing is scored and nothing is
diarized, for as long as the order is wrong.

## 2. The fix — 0097 then 0099, through the real runner

Applied by `app/api/run-migrations/route.ts` itself (its own discovery, its own `splitSql`, its own
`sql.transaction` call), from a temporary directory holding the two real files:

- response `200`, `{"applied":["0097_room_span_emotion_speech","0099_room_diarize_segments_run_id"],"skipped":[],"errored":null}`;
- `schema_migrations` then holds versions 97 and 99 — each file recorded itself inside the runner's transaction;
- Path A then writes, and the row carries `segments_run_id = 'run_after'`;
- Path B then reads past the column and no longer fails on it.

Both files carry a semicolon inside a header comment, so a splitter that did not track line comments would have cut
them mid-comment. The test asserts that property of the files, so it cannot silently stop proving it.

## 3. The straddle — 0099 applied, pre-E24 code still writing

The pre-E24 writer is `a05d750`'s `lib/stt/diarize-window.ts`. The test asserts against that commit's own source
that it names `segments_run_id` nowhere, then writes the row the way that code writes it.

- The row lands. Nothing crashes. `segments_run_id` is NULL, `last_run_id` is the straddling run.
- E24 then reads it and fails by name with R17's text, verbatim:
  `diarize_segments_stale: diarize segments have no recorded writer run (segments_run_id is NULL); which run wrote them is unknown`
- The test asserts that text contains no `predate`, no `before 0099`, and no `older migration`.
- The window is marked `diarize_stale` with `stale_segments_run_id` NULL, so the next ok diarize run cures it.

## 4. 0100 through the real runner

`db/migrations/0100_bench_window_auto_drain_refused_idx.sql` is not on this branch; it was read from commit
`8ee8d29` and applied in a temp directory after 0057 and 0092. Its header carries **4** line comments containing
semicolons, including the owed `EXPLAIN (ANALYZE, BUFFERS) … ;` block — the exact shape the splitter question was
about.

```
200 {"applied":["0057_bench_window","0092_bench_window_auto_drain_refusal","0100_bench_window_auto_drain_refused_idx"],"skipped":[],"errored":null}
index: [{"indexname":"idx_bench_window_auto_drain_refused_at"}]
recorded: [{"version":57,...},{"version":92,...},{"version":100,"name":"0100_bench_window_auto_drain_refused_idx"}]
```

The runner applies it, the index exists, and the file records itself. The semicolons-in-comments question is closed
by execution. This is not committed as a test, because 0100 does not exist on this branch and pulling another
branch's migration into a committed test would tie it to a commit sha on a branch this one does not own.

## 5. What this does not prove

- The driver is a stand-in. The database, the migration files and the runner are real, but `@/lib/db` is the psql
  harness, so Neon HTTP's own transaction semantics and error strings are not exercised. The Postgres error text
  above is the server's; a Neon client would wrap it differently.
- Nothing here was run against the live database, by order.
- `EXPLAIN` on the live index (owed by 0100's own header) is still owed at apply time. This run only proves the file
  applies.
