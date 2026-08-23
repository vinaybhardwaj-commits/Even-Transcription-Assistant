# Diarization dispatch — build report, 23 August 2026

**Production `5690328`. Migrations through 0063. Flags OFF for every room.**

Follows the measurement in `ETA-DIARIZE-TIMING-PROBE-22-AUG-2026.md`. Encounter path only:
no room window, no `bench_window`, no `speaker_cluster`, no flag, no change to what `/diarize`
returns or how embeddings are stored.

---

## The headline

`enc_7kszcrtwzc` diarizes. It had been a failed encounter since 1 June with
`timeout_90000ms`, and it is the row this build exists for.

```
diarize_status        complete
diarize_error         null
speaker_count         2
diarize_started_at    2026-08-23 04:49:04.820
diarize_completed_at  2026-08-23 04:49:44.352
wall                  38 099 ms   (service 36 441, transfer 1 658, queued 71)
```

Its note, CDS, transcripts and transcription runs are byte-identical to before: the re-run door
touches diarization fields and nothing else.

And a second thing, which was not in the brief and is arguably the more expensive finding:
**the background step machine's per-encounter lock had been throwing on every claim since
26 June.** See "What blocked it" below.

---

## What was built

**B1 — the clock starts at dispatch.** The timeout now covers only the dispatched call. It was
already the case that `runDiarize`'s abort timer started just before `fetch`; the queueing was
happening *inside the service*, after we had connected, with our clock already running. So B1
and B2 are the same mechanism: hold the caller until the service is free, then send, then start
the clock. Time spent waiting is reported as `queue_wait_ms` and charged to nothing.

**B2 — depth 1, across the whole app.** `lib/diarize-gate.ts`. One lease row in `diarize_slot`,
claimed by a single atomic upsert that only steals an EXPIRED lease, TTL'd at
`timeout + 60 s` so a worker killed mid-call frees the slot with nobody left to run a `finally`.

It is in Postgres and not in-process because an in-process mutex would prove nothing: two
encounters submitted together are two function invocations, quite possibly on two instances, and
those are exactly the two that collide at the Mini. It is a TTL lease and not
`pg_advisory_lock` because a session-scoped lock would have to be held across the whole
multi-minute call, and `APP_DATABASE_URL` is Neon's POOLED endpoint (pgbouncer, transaction
mode) where that is not safe. `lib/brain/lock.ts`'s xact-scoped lock is safe precisely because
it never outlives its transaction, and this hold must.

It fails open exactly once: a missing `diarize_slot` (deploy ahead of migration) admits the call
and says so in the log and in `timing.ungated`. Any other database error is treated as "not
available yet" — a transient blip is not permission to double-dispatch.

**B3 — the timeout is configurable, and its default carries its provenance.**

```ts
export const DIARIZE_TIMEOUT_MS_DEFAULT = 300_000;
```

The comment above it says, in the file, that 300 000 came from the probe's Q4 and was
**measured while a nine-hour recording ran on the same Mac Mini** — an upper bound, not a
calibration — and that it must be re-measured on a quiet machine before anyone treats it as
calibrated or tightens it. `DIARIZE_TIMEOUT_MS_PROVENANCE` carries the same sentence as data.
`DIARIZE_QUEUE_WAIT_MS_DEFAULT = 120_000` is named the same way and is explicitly NOT a
measurement: it is a budget chosen against the 300 s `maxDuration` it lives inside.

`git grep -E '300_?000' -- app lib components db scripts` returns two lines: the constant, and a
comment that names the string `timeout_300000ms`. A test asserts that exactly one of them is a
statement and that it is the named constant.

The production env var `DIARIZE_TIMEOUT_MS=90000` was **removed** (Production and Preview) so
the documented default is the operative value. Every run below records `timeout_ms: 300000`,
which is how we know.

**B4 — transfer separated from service.** `encounter.diarize_timing` (jsonb, migration 0063):
`queue_wait_ms`, `wall_ms`, `service_ms`, `transfer_ms`, `audio_bytes`, `timeout_ms`,
`timed_out`, `ungated`, `queued_at`, `dispatched_at`, `completed_at`. `transfer_ms` is
`wall − service` and is **null, not zero**, when the service reported no `latency_ms` of its own:
unknown is not the same as instant.

**B5 — re-running one encounter's diarization.** `?rediarize=1` on
`/api/admin/resume-processing`. `diarize_status='failed'` is terminal by design (`needDiarize`
excludes it), so a historically timed-out encounter could never be picked up again; the only
door that existed was `?reset=1`, which clears `note_json` and `cdmss_json`. Regenerating
months-old clinical content to fix a speaker label is not a trade anyone should make. The new
door clears the diarization fields and drives `/process` with `{only:"diarize"}`, which narrows
the step machine and can never widen it — every step still gates on its own `need-` predicate,
and the STT-lab fan-out is suppressed so a diarize-only re-run cannot quietly fire ASR engines at
the very machine it is re-running.

**Retryable ≠ failed.** A run that never got the slot records its wait and leaves
`diarize_status` alone. Marking it failed would be terminal, and stranding an encounter over
pure contention is the bug wearing a different hat.

---

## What blocked it — the lock that was never held

The first production re-run got `skipped: "locked"` thirty times in a row against an encounter
whose `processing_step_at` was demonstrably NULL. That is not possible unless the claim was
throwing, and the claim's `.catch(() => [])` was silent, so a throw and a held lock were
indistinguishable.

Instrumented, it said:

```
column "status" is of type encounter_status but expression is of type text
```

`d28b9f4` (26 June 2026) changed the per-encounter claim from `SET status = 'processing'` to

```sql
SET status = CASE WHEN status = 'complete' THEN 'complete' ELSE 'processing' END
```

so post-completion steps would not drag a finished encounter back to `processing`. The intent
was right. `encounter.status` is the `encounter_status` ENUM (0001), and a `CASE` whose branches
are **both untyped literals** resolves to `text`, which Postgres will not assign to an enum
column. Naming the column in one branch — `THEN status` — types the whole expression.
`app/api/webhooks/resend/route.ts` has had the correct shape all along.

**For nearly two months, every `{step:true}` invocation answered `skipped: "locked"`, and the
resume cron ran every three minutes and drained nothing.** It was invisible because a lock that
is not held looks exactly like a lock that is. Fixed in `5690328`; the catch now logs and
reports; `tests/unit/process-step-claim.test.ts` pins both halves.

Two smaller things fell out of the same run:

- **The queue wait had no relationship to the budget it lives in.** `maxDuration` is 300 s and
  the R2 fetch spends some of it before we queue. The wait is now
  `min(DIARIZE_QUEUE_WAIT_MS, remaining − dispatch reserve)`. The dispatched call keeps its full
  configured budget on purpose: if the function dies under it, the step lock TTL and the bounded
  retry are what handle that, not a shortened clock.
- **`skipped: "locked"` now says who holds it and for how long.**

---

## Acceptance

### A1 — `enc_7kszcrtwzc` diarizes

`complete`, 2 speakers, 38 099 ms wall. Table above.

### A2 — the five that already worked still work

Three of the five re-run (the other two were left alone). All still `complete`, all still 2
speakers — unchanged from their 1 June values.

| encounter | before | after |
|---|---|---|
| `enc_bn5ttmn7qm` (482 s) | complete, 2 speakers | complete, 2 speakers |
| `enc_su3fhbqg8j` (171 s) | complete, 2 speakers | complete, 2 speakers |
| `enc_3acaggx727` (139 s) | complete, 2 speakers | complete, 2 speakers |

### A3 — the clock starts at dispatch

Three re-runs issued at once against the serialising service. Every number below is read back
from `encounter.diarize_timing`.

| encounter | audio | bytes | **queue wait** | **service** | transfer | wall | timeout in force | timed out |
|---|---|---|---|---|---|---|---|---|
| `enc_su3fhbqg8j` | 171 s | 0.42 MB | **197 ms** | **1 510 ms** | 203 ms | 1 713 ms | 300 000 | no |
| `enc_bn5ttmn7qm` | 482 s | 12.70 MB | **1 868 ms** | **23 033 ms** | 2 173 ms | 25 206 ms | 300 000 | no |
| `enc_3acaggx727` | 139 s | 3.70 MB | **28 523 ms** | **8 291 ms** | 458 ms | 8 749 ms | 300 000 | no |

`enc_3acaggx727` waited **28 523 ms — 3.3× its own work** — and the timeout applied to
`wall_ms = 8 749`, not to `28 523 + 8 749 = 37 272`. Under start-at-enqueue its clock would have
read 37 272 ms. That is the whole fix, in one row.

### A4 — depth 1 holds (observed, not inferred)

`dispatched_at → completed_at` for the three concurrent calls:

```
enc_su3fhbqg8j   04:50:54.840 ─────► 04:50:56.553
enc_bn5ttmn7qm                        04:50:57.436 ──────────────────► 04:51:22.642
enc_3acaggx727                                                         04:51:23.360 ──────► 04:51:32.109
```

Strictly disjoint, with 883 ms and 718 ms between them (lease release plus the next waiter's
poll). At no instant were two requests in flight. Each waiter's `queue_wait_ms` ends within
10 ms of the previous call's `completed_at`, which is the lease being released rather than a
timer coinciding.

`ungated: false` on every run — the lease was genuinely taken, so migration 0063 is live and the
fail-open path was not used.

The same property is held mechanically in `tests/unit/diarize-dispatch.test.ts`, by
instrumenting the fetch and asserting `maxInFlight === 1` against a fake Postgres that
implements the real upsert semantics.

### A5 — the timeout value

Configurable via `DIARIZE_TIMEOUT_MS`; default `DIARIZE_TIMEOUT_MS_DEFAULT = 300_000`, exported,
with the "measured under load, upper bound, re-measure on a quiet machine" note attached to it in
the source and asserted by a test. No bare `300000` literal anywhere else — asserted by a test
that greps the tree, not by this paragraph. Observed in force in production: every run above
records `timeout_ms: 300000`.

### A6 — transfer and service recorded separately

Every row above, and every row in `encounter.diarize_timing`.

Worth recording, because it changes a number from the probe: **transfer from Vercel `bom1` is
~0.17 s/MB, not the probe's ~1.1 s/MB.** The probe measured from a local process over the
tunnel; production egress is a different path. Transfer is 4–9% of wall here, not 28%. This is
exactly what B4 exists to make visible — folded into one number, it would have read as the model
getting faster.

### A7 — nothing on the room path moved

| observation | before | after |
|---|---|---|
| `speaker_cluster` rows | 0 | 0 |
| `transcription_run` with `subject_type='bench_window'` | 9 subjects, 1 engine each, 0 errored | 9 subjects, 1 engine each, 0 errored — same ids |
| `bench_window` state (`bw_g3dwud4p_1787422500000_primary`) | `transcribed`, 1 sarvam run, 17 156 ms | `transcribed`, 1 sarvam run, 17 156 ms |

`speaker_cluster` is counted directly (brain role, `psql`). The `bench_window` counts are read
through the STT-lab subject listing, because the brain role has no `SELECT` on `bench_window` or
`transcription_run` — stated so the reader knows which numbers are direct and which are via a
reader.

Independently of the counts, `tests/unit/diarize-encounter-only.test.ts` asserts that no shipped
file in this build names `bench_window`, `speaker_cluster`, `room_day`, `stt_window`,
`ROOM_STT_DRAIN_ENABLED` or `FUSE_LIVE_ENABLED` in code, that migration 0063 contains exactly two
DDL statements (create `diarize_slot`, add `encounter.diarize_timing`) and no `DROP`, and that
the `?rediarize=1` UPDATE cannot touch `note_json`, `cdmss_json`, transcripts or `status`.

### A8 — flags

`ROOM_STT_DRAIN_ENABLED` and `FUSE_LIVE_ENABLED` are **not present in the production
environment**. Absent parses to `{ set: false, rooms: [] }` — off for every room, which is the
default and the intended state. Neither this build nor its migration references either name.

**sha `5690328`.**

---

## Timing against the probe's model

The probe's warm fit was `service_ms = 46.42 × seconds + 148`. Measured again today, from
production, on encounter audio rather than room audio:

| encounter | audio s | predicted | observed | note |
|---|---|---|---|---|
| `enc_bn5ttmn7qm` | 482 | 22 522 ms | 23 033 ms | **+2.3% — the fit holds** |
| `enc_3acaggx727` | 139 | 6 600 ms | 8 291 ms | +26% |
| `enc_7kszcrtwzc` | 288 | 13 519 ms | 36 441 ms | +22.9 s — a **cold start**, first call of the day, squarely inside the handover's 12–30 s model load |
| `enc_su3fhbqg8j` | 171 | 8 086 ms | 1 510 ms | −81%; 0.42 MB for 171 s is ~20 kbps, far sparser than the room audio the fit was built on |

The 482-second case is the one that matters and it lands within 2%. The slope is not universal
across content — `enc_su3fhbqg8j` is four times cheaper than the fit predicts — so the fit is a
good planning tool and not a contract. Nothing here is close to the budget: the worst observed
dispatched call is 38 s against 300 000 ms.

---

## H3 — still unresolved, and still not chased

`/health` reports `device: "mps"`. The handover says `PYTORCH_ENABLE_MPS_FALLBACK=1` is
**required**, because SpeechBrain's ECAPA front-end uses `torch.stft` → `aten::_fft_r2c`, which
torch 2.2.2 has not implemented for MPS. **So part of the pipeline runs on CPU by design**, and
a partial fallback is the expected state rather than a fault.

Nobody has watched GPU power during a long call. Nothing in this build touches it and nothing in
this build's numbers settles it — 47.8 ms per audio-second on the 482-second case is consistent
with GPU acceleration but is not evidence of it. Settling it needs
`powermetrics --samplers gpu_power` or `asitop` on the Mini during one 15-minute diarize, which
needs shell on the Mini. It is a five-minute job for whoever has that.

---

## What this build did NOT do

- No diarization of a room window, a `bench_window`, or anything on the tape. That slice is
  gated on a schema decision that has not been made.
- No writes to `speaker_cluster`.
- No change to `ROOM_STT_DRAIN_ENABLED`, `FUSE_LIVE_ENABLED`, arm A, the fuse or the drain.
- No change to what `/diarize` returns or how embeddings are stored.
- No attempt at H3.

## Follow-ups worth someone's time

1. **Re-measure `DIARIZE_TIMEOUT_MS` on a quiet Mini.** The default is an upper bound measured
   under load and the source says so. Today's worst dispatched call was 38 s.
2. **The step lock's 5-minute TTL is now shorter than a worst-case diarize step** (up to 120 s
   queue + 300 s dispatch). The diarize gate prevents the double-dispatch that would otherwise
   follow, so this degrades safely — but the TTL and the step it guards no longer agree, and
   somebody should decide which one moves.
3. **Two months of the resume cron did nothing.** Now that the claim works, encounters that were
   silently un-drained since 26 June will start being picked up. Worth watching the next few
   cron ticks rather than discovering it as load.
4. **`services/audio-join/node_modules/` is untracked in the repo** and was before this build.
   Not touched here; it wants a `.gitignore` entry.
