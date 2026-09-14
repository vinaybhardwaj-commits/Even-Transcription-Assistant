# ETA — S1 ROUND 2 RULINGS · M1 ACCEPTED
**14 September 2026 · Orchestrator · Rules the Refuter's FAIL (N1–N4), the Builder's C2 stop, and accepts M1.**

## 1. The scoreboard

| Item | Verdict |
|---|---|
| S1 contract (`d852127`) | **PASS** — six files, none untouched, no migration, gate independently reproduced by the Refuter (105 files / 2535 tests, Postgres suite ran). |
| S1 fitness for the flag | **FAIL** on N1 and N2. **Both come from my kickoff, not from Builder deviation.** |
| FIX1 | **Correctly halted.** The kickoff contained a contradiction; stopping was the right call and cost 1m 37s instead of a wrong ledger. |
| M1 (Mini event loop) | **ACCEPTED.** |

## 2. C2 — the actor. RULED: option (c).

The kickoff told the Builder to copy `diarize-windows`, to pass a resolved admin id, and not to invent a
string. Those cannot all hold: `diarize-windows` discards the admin's identity and files everything as the
fixed label `"admin_route:diarize_windows"`; `bench/drain` resolves a real id but has no secret door.

**Ruling: POST is cookie-only, and says so.**
- POST resolves the admin id exactly as `app/api/admin/bench/drain/route.ts` does, including its
  `admin_id_missing_from_token` refusal. Actor is that id with `via: "admin_route"`.
- A POST carrying only `MIGRATION_SECRET` is refused `AUTH_REQUIRED` with a message naming the reason:
  a manual drain spends, and spend is recorded against a person.
- GET is unchanged — `CRON_SECRET` or `MIGRATION_SECRET`, actor `SYSTEM_ACTOR` / `"cron"`.

Why, and it settles the contradiction by removing the question: a shared secret proves knowledge, not
identity, so any label invented for it recreates the exact defect F3 exists to prevent — spend filed under
nobody. `bench/drain` is the right precedent because it is the route that also spends; `diarize-windows`
merely enqueues. **No new actor string is invented anywhere**, so the "don't invent one" rule is kept.
The scripted door survives on GET, which is where automation belongs.

## 3. N1 — a retried zero-scored window records `ok` with no scores. FIX, and fix the class.

S1 made the window retryable; on retry `writeScoredOrFailed` collides with attempt 1's `failed` rows and
does nothing (`lib/emotion/store.ts:41`), while `finish()` counts from memory and records `ok`. Every
segment row still says `failed`. That is testing rule 9 with the data left wrong.

**Ruling, both halves:**
1. **Window-as-unit replace.** Each attempt deletes that window's existing segment rows before writing its
   own. This is already the house pattern — the room drain deletes a previous run's turns before the new
   ones land, never merges them. Do the same here.
2. **`finish()` records what was persisted, not what was remembered.** Derive the counts from the rows in
   the same statement that writes the window record. An in-memory counter can always drift from the
   database; deriving it cannot.

The second half is the one that matters. Fixing only the collision leaves the next drift undetected.

## 4. N2 — a named refusal holds the only slot. FIX. My spec error.

`flag_off`, `too_long` and `join_failed` return before the claim, so the window stays `closed` and is picked
again every tick. One recording room with Transcript off starved the others from 144 to 69–82 of 180 in the
Refuter's model. The cause is my instruction that the selector not repeat the Transcript check and leave it
to the drain: **a refusal that does not change state, plus one slot per tick, re-offers the same window
forever.**

**Ruling: the refusal becomes data.** Migration `0092` adds to `bench_window`:
`auto_drain_refused_at timestamptz NULL` and `auto_drain_refused_reason text NULL`.
- The auto-drain sets both whenever `drainRoomWindow` returns any step other than `enqueued`, recording the
  step name as the reason.
- It clears both on a successful enqueue.
- The selector excludes rows whose `auto_drain_refused_at` is inside
  `AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES` (default **60**, env override, clamp 5..1440).

A room whose Transcript switch is turned on is picked up within the hour; a permanently broken window costs
one slot an hour instead of every tick; and the reason is queryable instead of invisible, which is the same
principle as 0090 nesting the service's guess into the row.

## 5. N3 — my throughput premise was false. Acknowledged.

"288/day > 216/day" compared daily totals against clinic-hour production. Six rooms produce **24 windows an
hour**; a one-per-tick cron drains **12**. The model ages 72 of 216 windows out undrained.

**Ruling: the cap is not set by arithmetic. It is set by measurement, and it gates the flag.**
The cap stays **1** and `ROOM_AUTO_DRAIN_ENABLED` stays off until `route`'s realtime factor is measured on a
genuine clinic-length window (order M2). Then the cap is set from that number with headroom, and recorded in
the kickoff that sets it.

Structural note for the record: **the Mini's `route` service is the throughput ceiling of the entire
room-tape pipeline, and it is serialised.** Not the cron, not the job runner (3 jobs a minute is 180 an
hour). If measured throughput cannot clear 24 windows an hour with headroom, the answer is concurrency on
the Mini or a second engine — not a larger cap.

## 6. N4 — tests that pass against broken code. FIX all of it.

Hard-coding `6::int` and misspelling `"AUTO_DRAIN_MAX_AGE_HOURS"` each left 24/24 green. The class matters
more than the instances: **a misspelled env name falls back to the default silently, and the default is the
value the tests assume, so the test and the bug agree.**

Required: every tunable is exercised at a **non-default** value, so the test fails if the name is wrong or
the value is ignored. Also fix the POST cookie door never being exercised positively, `seedScrambled` using
raw minutes instead of deriving from the constant (rule 10), and `realSql` inlining literals so neon's
bind-parameter typing is never tested.

**Standing addition to the mutation check** the Builder invented on S1 and I commended: it must cover **how
the environment is read**, not only the SQL clauses. Mutate each env name and each default, and confirm a
test fails.

## 7. M1 — ACCEPTED. The fix is proven.

| Service | Health during real work, before | after | Idle |
|---|---|---|---|
| diarize | 3067 ms | **≤1.4 ms** (5 polls) | ≤13 ms → ≤4 ms |
| router | **3 timeouts at 15 s** | **≤4.9 ms** (66 polls) | ≤13 ms → ≤4 ms |

Responses unchanged in shape; diarize still serialises (two concurrent `/diarize` ran one after the other,
so the semaphore holds); `/enroll` still `ok:true, dim:192`; rollback commands recorded for both services.
The Builder correctly refused to claim the router's 50.8 s → 35.0 s as a speed-up when the code change does
not explain it.

**Recorded as a gotcha:** `latency_ms` (diarize) and `sec` (router) now **include time queued behind a
previous request**; before, they did not. Do not compare a post-M1 number with a pre-M1 number, and measure
only with nothing else in flight.

Order **M2** closes M1's own not-verified list and takes the measurement N3 depends on.
