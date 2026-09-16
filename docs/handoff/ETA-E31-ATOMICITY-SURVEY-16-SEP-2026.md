# ETA-E31 — ATOMICITY SURVEY · 16 Sep 2026 · Researcher (Mac Mini)

RESEARCH ONLY. No application code changed. Repo `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant`,
branch `vinay/s1-auto-drain`, HEAD `d861abf`. The `-e18` worktree was not entered; where E18 is surveyed it was
read from the branch blob (`git show vinay/e18-silence-is-evidence:…` at `25d640f`), which touches no worktree.
Nothing was merged, pushed, promoted, deployed or applied. No migration ran.

This is an inventory, not a proposal. Severity is named; no cure is designed here.

---

## 0. THE HEADLINE NUMBERS

| | |
|---|---|
| Coupled write sites found | **40** — group A 12, B 8, C 10, D 10 |
| Of those, **a reader cannot tell the half-written state from success** | **19** — A1 A2 A4 A7 A12 · B1 B2 · C1 C2 C3a C3b C3c C4 C5 · D1 D2 D3 D5 D9 |
| Sites where the ORDER of the writes is what makes today's behaviour safe | **11** (§5) — **one** of them is pinned |
| Sites where the order instead *chooses which* bad state you get | 3 — C2, C3, C4 |
| Postgres `sql.transaction()` call sites | **4** (the claim that it is unused is wrong — §1) |
| Sites spanning two connections/roles | 4 — A8, D1, D2, D9 |
| Sites already atomic by construction (one statement) — considered and excluded | 15 (§6) |

Counts are listed by id so they can be checked rather than trusted. `C3a/b/c` is one pattern at three call
sites and is counted as three; `D6a/b` likewise as two.

---

## 1. FACT ONE — `sql.transaction()` IS NOT UNUSED. The claim is wrong.

There are **four** Postgres `sql.transaction()` call sites, all live, all correct:

| file:line | what it wraps |
|---|---|
| `app/api/run-migrations/route.ts:183` | every statement of one migration file, as one transaction. `splitSql` strips `BEGIN;`/`COMMIT;` *because* the runner wraps them — the comment at line 51 says so. |
| `lib/room-install.ts:475` | `mintBootstrapToken`: INSERT `room_install`, then INSERT `room_bootstrap_token`. The comment at 472 says the install row goes first so the token's FK cannot dangle — an ordering argument made *inside* a transaction. |
| `lib/room-install.ts:661` | `enrolWithToken`: claim-token CTE + retire-other-installs, then enrol-this-install. |
| `lib/room-install.ts:1686` | `cleanupExpiredInstalls`: DELETE `room_bootstrap_token`, then DELETE `room_install`. |

**Do not count the other eleven.** `lib/chunk-store.ts` (6) and `lib/use-room-recorder.ts` (5) call
`db.transaction(STORE, "readwrite")` — that is **IndexedDB in the browser**, a different API on a different
database. A grep for `.transaction(` returns 17 hits; only 4 are Postgres.

So the pattern is available, is understood in this codebase, and is already used correctly in one module. It is
absent from the pipeline, not from the repo.

## 2. FACT TWO — THE DRIVERS, AND ONE CORRECTION THAT MATTERS

### 2a. Which driver each site uses

| handle | driver | reaches | transactions available? |
|---|---|---|---|
| `lib/db.ts` → `sql`, `db` | `@neondatabase/serverless` **HTTP** (`neon()`), v0.10.4, `APP_DATABASE_URL` | everything in this survey except the brain legs | **Yes, but only `sql.transaction([...])`** |
| `lib/brain/db.ts` → `getPool()` | same package, **WebSocket `Pool`** (`BRAIN_DATABASE_URL`) | `cue`, `room_day`, `visit` | **Yes, full interactive** BEGIN/COMMIT on one session |
| `lib/db-neon-http.ts` | Neon HTTP (`DATABASE_URL`) | KB chunks | as HTTP |
| `lib/kb-db.ts`, `lib/admin/dashboard.ts:424`, `app/api/health/route.ts:51` | Neon HTTP (`KB_DATABASE_URL`) | knowledge base, **read-only** | n/a |

**36 of the 40 sites run wholly on the app HTTP handle.** Every statement on it autocommits.

**What the HTTP driver can and cannot do.** The shipped `index.d.ts` (line 316) describes `transaction()` as
submitting "multiple queries (over HTTP) as a single, **non-interactive** Postgres transaction". Non-interactive
is the whole constraint: it takes an **array of queries fixed before the first one runs**, and inside it "no
`transaction()` method is available" (line 288). **No application logic can run between the statements.** Every
sequence in §4 that reads a service, branches on a result, or loops over service answers between its writes
cannot be expressed as one `sql.transaction([...])` without being restructured. That is the fact a cure has to
survive; sites are tagged `[HTTP-shaped]` where the statements are already fixed up front and `[interleaved]`
where they are not.

The WS pool has no such limit: `lib/brain/lock.ts:29-38` does real `BEGIN` / `pg_advisory_xact_lock` / `COMMIT`
/ `ROLLBACK` on one `PoolClient`, and `lib/brain/fuse/live.ts:251` wraps a whole multi-row loop in it. **That is
the one place in the repo where a multi-statement pipeline write is already properly atomic.**

### 2b. THE CORRECTION — the "brain database" is the SAME database

The header of `lib/brain/db.ts` calls it "the brain's own role (`BRAIN_DATABASE_URL`)", and a first reading
takes that as a separate database. It is not. **`db/migrations/0042_brain_tables.sql` creates `cue`, `room_day`
and `visit`** — and that file is applied by the app's own runner against `APP_DATABASE_URL`.
`db/migrations/0053` then `GRANT`s those same tables to a role named `brain_svc`. `lib/bench-window.ts:347`
reads `room_day` through the **app** `sql` handle.

So: **one physical Postgres database, two roles, two drivers.** The four sites tagged cross-connection below are
*not* cross-database, and are therefore not beyond reach on that ground alone — but no code path today opens one
connection for both legs, and one of the four crosses an HTTP hop to our own origin as well. Practically nothing
changes for the inventory; it changes what is *possible*, which is a PRD input, so it is stated here rather than
left as the ambiguity it first appears to be.

---

## 3. HOW TO READ THE TABLES

**"Reader can tell?"** is the column that matters, and it is about the database, not about a log line.
- **no** — the half-written state reads as success, or as never-started. The 0097 case scores `no`.
- **partly** — a reader sees something is odd (a stuck state, a null) but cannot tell a crash from work in flight.
- **yes** — the row plainly says it is unfinished.

**"Detected?"** means something in the running system notices and acts, not that a human could find it.

---

## 4. THE INVENTORY

### GROUP A — the three pipeline jobs and the boundaries between them

---

#### A1 · THE 0097 CASE — the span write and the failure bookkeeping that cannot record its own failure
**`lib/emotion/store.ts:79`** (called from `lib/jobs/kinds/emotion-window.ts:221`) `[interleaved]`

1. `INSERT INTO room_span_emotion` — one per scored segment, in a loop, `store.ts:79`.
2. On any throw: `lib/jobs/kinds/emotion-window.ts:267` catch → `fail()` at `:77` →
3. `INSERT INTO room_emotion_window … ON CONFLICT DO UPDATE`, `store.ts:180`, state `failed`.

**If 1 fails and 3 also fails:** proven live. Without 0097, statement 1 dies on `room_span_emotion.speech_ms`
and statement 3 dies on `room_emotion_window.segments_unscorable` — 0097 adds both. The second error escapes the
kind. No failed row, no attempt counted, no error text.

**Detected?** The enqueue scan (`lib/emotion/enqueue.ts`, `e.window_id IS NULL`) re-offers the window, so it is
retried — **but the attempt is never counted**, so `EMOTION_MAX_ATTEMPTS` is never reached and it retries for
ever without ever being reported exhausted.

**Reader can tell? `no`.** `room_emotion_window` has no row, which is byte-identical to "not processed yet". The
window's own `bench_window.state` is still `transcribed` from the drain, so every operator view reads the window
as fully done. **Severity: CRITICAL — this is the shape the survey was ordered for.**

**Order load-bearing?** No. Both orders lose.

---

#### A2 · Emotion prepare deletes the window's spans before it can replace them
**`lib/emotion/store.ts:57`** (`clearWindowSegments`, called `lib/jobs/kinds/emotion-window.ts:160`) `[interleaved]`

1. `DELETE FROM room_span_emotion WHERE window_id = …` — **all** of them, across every diarize run.
2. `writeSkipped` / `writeUnscorable` loop, `emotion-window.ts:161-162`.
3. The scored rows arrive in the **`score` step**, a separate job invocation (`lib/jobs/runner.ts:71` runs one
   step per call and persists progress at `:118`), so a crash between steps is durable.
4. `finishEmotionWindow` (`store.ts:320`) writes the window row last.

**If 1 succeeds and the job never reaches 4:** the window has zero or partial span rows while
`room_emotion_window` still holds the **previous** attempt's row — possibly `state = 'ok'` with `segments_scored
= 12` over a table that now holds nothing.

**Detected?** **No — and worse than A1.** The enqueue scan only re-offers when the emotion row is absent, names
a different diarize run, or is `failed` with attempts left. An `ok` row against the *same* run matches none of
those, so the window is **stranded and never re-offered**.

**Reader can tell? `no`.** The window row says `ok` and carries counts. Only counting `room_span_emotion` would
reveal it, and nothing does. **Severity: CRITICAL.**

---

#### A3 · Diarize writes N turn rows, then the state row that certifies them
**`lib/stt/diarize-window.ts:174`** → **`lib/jobs/kinds/diarize-window.ts:77`** `[interleaved]`

1. `INSERT INTO room_turn_speaker … ON CONFLICT DO UPDATE` — one per turn, in a loop, carrying `run_id`.
2. `recordDiarizeWindow(...)` → `INSERT INTO room_diarize_window` state `ok`, `diarize-window.ts:278`.
3. `repairStaleDiarizeSegments(...)` → `UPDATE room_diarize_window`, `diarize-window.ts:340`.

**If 1 dies partway:** some turn rows carry the new `run_id`, some the previous one; no state row is written, so
`room_diarize_window.last_run_id` still names the **old** run. The window's turns are a mixture of two runs
while the row claims one.

**Detected?** Partly, and by luck rather than design: the diarize scan re-offers when the row is absent or
`failed`, so a **first** run self-heals. A **re-run** over an existing `ok` row does not — the row is `ok`, so
the scan skips it and the mixed turns stay. Downstream, `lib/jobs/kinds/emotion-window.ts:200` re-reads
`last_run_id` and fails `diarize_changed`, which catches the case only when it moved.

**Reader can tell? `partly`.** **Severity: HIGH.**

**ORDER LOAD-BEARING? YES.** The state row is written *after* the turns, so `ok` is only ever claimed over a
complete set. Reverse it and a crash mid-loop leaves `ok` over partial turns, which nothing downstream would
question. Nothing enforces this order. **This is R52-shaped and unpinned.**

---

#### A4 · The drain finishes the window, then finishes the job
**`lib/stt/room-drain.ts:1299`** `[HTTP-shaped]`

1. `UPDATE bench_window SET state = 'transcribed' WHERE id = … AND state = 'transcribing'`
2. `UPDATE stt_subject_job SET state = 'done', finished_at = NOW(), last_error = NULL WHERE …`

**If 1 succeeds and 2 fails:** the window reads `transcribed` — complete, successful — while its job row stays
`running`.

**Detected?** `lib/stt/fanout.ts:219` re-queues any `stt_subject_job` left `running` for 5 minutes, with **no
`subject_type` filter**, so the bench_window job row *is* re-queued. But the claim that consumes it
(`fanout.ts:237`) is filtered to `subject_type = 'encounter'`, so nothing ever executes it. The row cycles
`running` → `queued` for ever. Meanwhile the drain cannot re-claim the window either: `drainable` without
`force` is `['closed','transcribing']` (`room-drain.ts:465`) and the window is `transcribed`.

**Reader can tell? `no`.** The window reads as a clean success. **Severity: HIGH** — the transcript did land, so
the damage is bookkeeping, but the queue is permanently dirty and invisible.

**ORDER LOAD-BEARING? YES** — and this is the safe order. Reversed, the job would read `done` over a window
still `transcribing`, which the auto-drain scan (`w.state = 'closed'` only) would never re-offer.

---

#### A5 · The drain claims the window, then claims the job
**`lib/stt/room-drain.ts:486`** `[HTTP-shaped]`

1. `UPDATE bench_window SET state = 'transcribing' … RETURNING id` (the guarded claim).
2. `UPDATE stt_subject_job SET state = 'running', started_at = NOW() …`

**If 1 succeeds and 2 fails:** window `transcribing`, job still `queued`.
**Detected?** The window is re-claimable (`drainable` includes `transcribing`), but **auto-drain offers only
`w.state = 'closed'`** (`auto-drain.ts:194`), so nothing re-offers it automatically. `lib/admin/room-reads.ts:101`
counts it as `in_progress` for ever.
**Reader can tell? `partly`** — visibly in-flight, indistinguishable from genuinely in-flight. **Severity: MEDIUM.**

---

#### A6 · recordFailure writes the reason, then parks the window
**`lib/stt/room-drain.ts:400`** `[interleaved]` (the branch at 412 depends on 1's RETURNING)

1. `UPDATE stt_subject_job SET attempts = attempts + 1, last_error = …, state = CASE … RETURNING attempts`
2. `UPDATE bench_window SET state = 'failed'` (attempts exhausted, `:413`) **or** `'closed'` (`:415`).

**If 1 succeeds and 2 fails:** the attempt and reason are recorded, the window stays `transcribing`. As A5:
re-claimable by hand, never auto-offered.
**Reader can tell? `partly`.** **Severity: MEDIUM.**
**ORDER LOAD-BEARING? YES.** The reason must exist before the window is parked — the comment at `:410` says the
reason lives on the job row precisely so there is one place it can be read from. Reversed, a window could be
parked `failed` with no reason anywhere.

---

#### A7 · The routed run is deleted before its replacement is written
**`lib/stt/room-drain.ts:1013`** `[HTTP-shaped]`

1. `DELETE FROM transcription_run WHERE subject_type = 'bench_window' AND subject_id = …`
2. `INSERT INTO transcription_run (…) VALUES (…)` — the new run, `:1015`.

**If 1 succeeds and 2 fails:** the window has **no run row at all**, and the previous transcript is gone. The
job then fails and the window is returned to `closed` by `recordFailure`, so it will be re-drained — but the
prior transcript is destroyed in the meantime and is not recoverable from the row.
**Detected?** Nothing notices the absence; re-drain overwrites it if it succeeds.
**Reader can tell? `no`** — "no run for this window" reads as "never transcribed". **Severity: HIGH** (data loss
window, self-healing only if the retry succeeds). **`[HTTP-shaped]` — both statements are fixed before either runs.**

---

#### A8 · The cues go to one role over HTTP, the window state to another
**`lib/stt/room-drain.ts:760`** and **`:934`** (`writeWindowCues` → `postTurnBatch`, `lib/mcp/tools/bench.ts:1421`)
`[cross-connection]`

1. `postTurnBatch` — an **HTTP POST to our own origin** → `/api/brain/cues` → `cue` rows written by the brain
   role under `withRoomDayLock` (a real transaction, `lib/brain/lock.ts:29`).
2. Back in the drain: `cueWriteFailed(counts)` → `recordFailure(…, "cues_refused", …)`, or the phase returns ok
   and `roomWindowFinish` later writes `bench_window.state`.

**If 1 lands but the reply is lost:** the cues are in the database and the drain treats the window as refused,
re-drains it, and writes the cues again (the batch carries `replace_window`, so the rewrite replaces rather than
duplicates — that is what makes this survivable).
**Detected?** Partly — `counts` is inspected and the failure is named.
**Reader can tell? `partly`.** **Severity: MEDIUM.** Two connections *and* an HTTP hop: not atomic as built, and
the least reachable of the four cross-connection sites.

---

#### A9 · Auto-drain: queue row, drain, then the refusal stamp
**`lib/stt/auto-drain.ts:219`** `[interleaved]`

1. `enqueueSubject("bench_window", id, "asr")` — the legacy queue row, first, so the retry bound has something to count.
2. `drainRoomWindow(...)` — the whole of A5/A6/A7 above.
3. `UPDATE bench_window SET auto_drain_refused_at = NULL…` on `enqueued` (`:229`) **or** `= NOW(), …_reason = step` otherwise (`:231`).

**If 2 succeeds (`enqueued`) and 3 fails:** the window keeps a **stale** `auto_drain_refused_at`, so the
cooldown suppresses it from offers for 60 minutes even though it was enqueued successfully — and the room still
counts as "served" either way, because the `offered` CTE (`:170-182`) accepts a job **or** a refusal.
**If 2 refuses and 3 fails:** no cooldown is recorded, and the same window is re-offered on the next tick — the
exact starvation E17/E22 R3 fixed.
**Reader can tell? `partly`.** **Severity: MEDIUM** (fairness, not data).

---

#### A10 · E18: the silence verdict is written in one phase, the state in another
**`lib/stt/room-drain.ts:809` → `:1343`** — *on `vinay/e18-silence-is-evidence` (`25d640f`) only; not on this branch.*

1. `recordSilenceVerdict(...)` → `INSERT INTO bench_window_silence` in the **segment** step.
2. `UPDATE bench_window SET state = 'silent'` in **`roomWindowFinish`**.

**Reader can tell? `no` — if reversed.** A window resting in `silent` with no evidence row has no `decided_at`,
so E18's as-of bound falls back to `closed_at` and the window slips under every bound an operator can pass
(measured `preview 1, moved 2`).

**ORDER LOAD-BEARING? YES — and this is the one such site already pinned.** R52 (`25d640f`) added a test that
reads the order of the two writes as they happen, and comments at both lines. **Severity: LOW as it stands,
listed because it is the template for what A3, A4, A6 and A12 still lack.**

**And the contrast worth recording:** E18's bulk apply, `reopenSilentWindows`
(`lib/stt/silence.ts:509-549` on that branch), is **one statement** — a single `WITH bound/picked/moved/stamped`
CTE that moves the windows and writes the ledger together. It is **atomic under autocommit with no transaction
at all**, and is the only multi-effect write in the pipeline that already cannot half-land.

---

#### A11 · Fanout: the run rows, then the job state
**`lib/stt/fanout.ts:248`** `[interleaved]`
1. `runFanoutForEncounter(...)` — writes `transcription_run` rows.
2. `UPDATE stt_subject_job SET state = …, last_error = …` (`:254`).
3. On throw: `UPDATE stt_subject_job SET state = 'failed', …` (`:261`) — **unguarded**; if *this* write throws,
   it escapes the loop and kills every remaining job in the batch.
**Detected?** Yes — the 5-minute reclaim at `:219` re-queues it.
**Reader can tell? `partly`.** **Severity: MEDIUM**, chiefly for the unguarded catch-write at `:261`.

---

#### A12 · A window is closed irreversibly, then enqueued best-effort
**`lib/bench-window.ts:378`** `[interleaved]`
1. `INSERT INTO bench_window` (`:357`), 2. `UPDATE … room_day_id` (`:368`),
3. `UPDATE bench_window SET state = 'closed' … AND state = 'open' RETURNING id` (`:378`),
4. `enqueueSubject("bench_window", id, "asr")` (`:399`) inside `try { } catch { }` — **swallowed with no log line
   at all**, unlike every other best-effort write in the file.

**If 3 succeeds and 4 fails:** the window is permanently `closed` (the `state = 'open'` guard means this path can
never re-enter) with nothing queued to transcribe it.
**Detected?** **Conditionally.** Auto-drain's scan takes `w.state = 'closed'` and does not require a job row, and
it calls `enqueueSubject` itself at `:219` — so it heals. But auto-drain **ships dark** behind
`ROOM_AUTO_DRAIN_ENABLED` (`auto-drain.ts:46`, "this is the shipped state") and only looks back
`AUTO_DRAIN_MAX_AGE_HOURS`, default **6**. Outside that window, or with the flag off, the gap is permanent.
**Reader can tell? `no`** — `base.enqueued` is merely undercounted and nothing compares windows-closed against
jobs-enqueued. **Severity: HIGH.**

---

### GROUP B — the encounter pipeline (`app/[slug]/api/encounters/[id]/process/route.ts`)

All on the app HTTP handle. `llm_traces` is the **same** database (`lib/llm-trace/log.ts:29` imports `@/lib/db`).

| # | file:line | the sequence | if N succeeds, N+1 fails | detected? | reader? | order? |
|---|---|---|---|---|---|---|
| **B1** | `:577` | UPDATE encounter (speakers, segments, `diarize_status='complete'`) → UPDATE `tagged_transcript` (`:630`) → UPDATE `speakers` refined (`:631`) | `tagged_transcript` holds roles from the **refined** roster while `speakers` holds the **pre-refinement** one; row and turns disagree | **nothing** — the whole block is one `catch (te) { console.warn }` (`:634`) and `diarizeStore` still returns `true` (`:654`) | **no** | no |
| **B2** | `:655` | the outer catch's own bookkeeping: `UPDATE encounter SET diarize_status='failed', diarize_error=…` — wrapped in `try { … } catch { /* intentional */ }` | if the failure write fails, `diarize_status` stays `'running'` from `:540` for ever, and the function still returns `true` | **nothing** | **no** | no |
| **B3** | `:1032` | `noteTrace.finalise(status:'completed')` → UPDATE `note_json`, `transcript_clean` (`:1050`) | `llm_traces` shows a completed note pipeline; the encounter has no note | indirect: status stays non-complete so a retry regenerates | partly | no |
| **B4** | `:1112` | `cdmssTrace.finalise()` → UPDATE `cdmss_json`, `status='complete'` (`:1130`) | trace completed, `cdmss_json` null, status not complete | indirect, as B3 | partly | no |
| **B5** | `:1191` | UPDATE `status='draft_partial'` → INSERT `audit_log` (`:1197`) | a real status change with no record of why | nothing | partly | n/a |
| **B6** | `:867` | `diarizeStore()` → UPDATE `status='complete', processing_pct=100` (`:872`, `.catch(()=>{})`) | status stuck `processing` over complete content | **yes, self-heals** — next tick's "done" branch (`:754`) flips it; 5-min TTL and 15-attempt cap bound it | partly | **yes** — flipping status first would show the encounter done mid-diarization |
| **B7** | `:1271` | UPDATE `note_json` → UPDATE `cdmss_json` + `status='complete'` (`:1304`/`:1316`) | note saved, status not complete | none in-branch; retry regenerates | **yes** | **yes** — status first would read done with no note |
| **B8** | `:782` | claim UPDATE (`processing_step_at`, attempts) → the step's own write → release UPDATE (`:883`) | stuck `processing`, attempts incremented | **yes** — the claim's own 5-min TTL (`:791`) reclaims; 15-attempt cap fails it out | **yes** (briefly) | **yes** — claim-before-work is what stops two workers on one step |

Also noted: `:841` and `:1026` write a sentinel / `status='failed'` with a trailing `.catch(()=>{})` — the same
mask-your-own-failure shape as B2.

---

### GROUP C — the STT lab writers

All on the app HTTP handle. No `sql.transaction`, `BEGIN` or `COMMIT` anywhere in this group.

| # | file:line | the sequence | if N succeeds, N+1 fails | detected? | reader? | order? |
|---|---|---|---|---|---|---|
| **C1** | `lib/stt/window-scoring.ts:382` | INSERT `stt_score_refusal` (`SILENCE_UNTYPED`, own swallowing catch at `:387`) → UPSERT `stt_window_score` (`:392`) | a refusal note with no score row. `buildLeaderboard` excludes `SILENCE_UNTYPED` from `n_refused` **and** the pair is absent from `scored` — it vanishes from **both** numerator and denominator | nothing persisted; only a returned `errors[]` | **no** | no — the decoupling is deliberate (`:387`) but that comment reasons only about the *other* failure order |
| **C2** | `lib/stt/translate-bakeoff.ts:68` | DELETE all `tier='translate'` runs → loop INSERT per candidate (`:78`, per-candidate catch) → `scoreTranslate` (`:84`) stamps `scored_at` on survivors (`:50`) | a bake-off with a winner and `scored_at`, permanently **missing an engine**: `translateBakeoffPending` (`:88`) excludes any encounter with a `scored_at`, so it is never re-picked | nothing | **no** | **the order is what makes it worse** — delete-first is why a partial insert is unrecoverable |
| **C3a/b/c** | `lib/stt/scoring.ts:134`, `:349`, `lib/stt/translate-bakeoff.ts:55` | `UPDATE … SET is_winner = false WHERE encounter_id = …` → `UPDATE … SET is_winner = true WHERE id = winner` | **every run reads `is_winner = false`**. `winner` is provably non-null when the block is reached, so all-false can only be this crash — and `scored_at` is already stamped per row, so the rows look fully scored | nothing | **no** | **order chooses the failure** — reversed you get a brief double-winner instead |
| **C4** | `lib/stt/scoring.ts:270` | DELETE `stt_gold` → UPDATE `transcription_run SET wer=NULL, cer=NULL, med_term_recall=NULL` (`:272`) | rows keep real-looking WER/CER computed against a reference that no longer exists | nothing | **no** | **order chooses the worse mode** — clearing scores first would leave an honest gap |
| **C5** | `lib/stt/fanout.ts:306` | DELETE duplicate runs (RETURNING encounter_id) → UPDATE survivors clearing `scored_at`, `agreement_score`, `judge_score` (`:318`) | the survivor keeps **stale** scores computed when duplicates existed, and reads as currently scored | nothing | **no** | no — this is the only functional order |
| **C6** | `lib/stt/fanout.ts:133` | per-engine DELETE errored run (`:136`) → INSERT new run (`:176`, own catch) → `scoreEncounter` (`:190`) | that engine has zero rows — indistinguishable from never attempted | partly: `drainFanout` persists `res.errors` into `stt_subject_job.last_error` (`:254`) even on `done`; the idempotency check at `:113` re-includes the engine on retry | **partly** (`no` from `transcription_run` alone) | **yes** — delete-before-transcribe is what turns a failure into a gap rather than a visible stale error row |
| **C7** | `lib/stt/fanout.ts:333` | the same shape for the scribe tier (`:381`, `:388`, `:401`); `markScribeDone` (`scoring.ts:304`) can stamp `scored_at` over rows that never got a candidate | as C6, plus C2's permanence risk | as C6 | partly | yes |
| **C8** | `lib/stt/scoring.ts:238` | UPSERT `stt_gold` (atomic) → `scoreGold()` (`:264`), whose per-row loop (`:221`) has **no catch at all** | the gold row is committed; the caller is told the whole call failed | retry is idempotent | **partly** — `gold_scored_at` is present only on rows updated before the throw | no |

---

### GROUP D — brain, install and support writers

| # | file:line | the sequence | if N succeeds, N+1 fails | detected? | reader? | order? | driver |
|---|---|---|---|---|---|---|---|
| **D1** | `lib/brain/fuse/visit-update.ts:143` (called `lib/mcp/tools/fuse.ts:243`) | UPDATE `visit` clinician (brain role) → INSERT `audit_log` (app role, `:189`) | the clinician is changed with **no audit row**, against the file's own "every post-close change writes an audit_log row" | nothing — only `console.warn` (`:194`) | **no** — and worse: `fuse.ts:290` returns `audited: postClose`, a boolean computed from state, so the caller is told `audited:true` when the write failed | no | **cross-connection** |
| **D2** | `app/api/bench/events/route.ts:111` | INSERT `bench_event` with `brain_status='failed'` → POST `/api/brain/cues` (cue committed under the brain lock) → UPDATE `bench_event SET brain_status='sent'` (`:144`) | the cue is delivered and stored while the row says **`failed`** — exactly backwards | nothing reconciles | **no** | no | **cross-connection + HTTP hop** |
| **D3** | `lib/lockout.ts:87` | INSERT `pin_attempt` (own catch) → UPDATE `clinician` (failed count / `locked_until` / status), with two fallback UPDATEs (`:110-148`), **all caught** → return the decision (`:150`) computed from in-memory state | all three UPDATEs can fail and the function still returns `{kind:"disabled"}` / `{kind:"locked"}`; the row keeps its old count and status, and the next attempt starts from stale state | nothing — `console.warn` only | **no** | no | app HTTP. **Severity: HIGH — security-relevant.** A lockout the caller believes is enforced may not be. |
| **D4** | `lib/room-install.ts:1197` → `:1161` | UPDATE `room_install` poll fields → UPDATE `state_flags`, `state_changed_at` derived from them | `last_seen_at` is fresh, the fleet card's health verdict is stale; a Mac that just went unhealthy keeps showing healthy | nothing — `console.warn` (`:1168`) | partly | no | app HTTP |
| **D5** | `app/api/admin/reap-stuck/route.ts:93` | UPDATE encounter→`complete` → →`draft_partial` (`:103`) → →`failed` (`:112`) → INSERT `audit_log` (`:122`, `.catch(()=>{})`) | earlier UPDATEs are committed, the route returns `PIPELINE_FAILED`, and no audit row is written for the rows that did change | nothing | **no** — the HTTP response disagrees with the database | **yes for correctness** — `complete` must run before `draft_partial` so completed rows do not fall into the partial bucket | app HTTP `[HTTP-shaped]` |
| **D6a/b** | `lib/voice-samples.ts:132`, `:216` | loop INSERT `voice_sample` → `recomputeCentroid()` — **uncaught** | samples are committed with `included=true`; `voice_print.centroid` does not reflect them; the caller sees a throw | nothing schedules a later recompute | partly | **yes** — insert must precede recompute for it to be included | app HTTP |
| **D7** | `lib/bench-commands.ts:535` | UPDATE `bench_command` ack → UPDATE `room_install.expected_device_name` (`:562`, own catch) | the ack already reported success; the device label stays stale | `console.warn` (`:578`) | partly | no | app HTTP |
| **D8** | `lib/bench-reaper.ts:80` | UPDATE `bench_session status='ended'` → INSERT `audit_log` (`:91`, own catch setting `audit:"failed"`) | session correctly ended, trail missing | **yes** — `reaped.push({…, audit})` (`:97`) surfaces it in the return value | **yes, if the caller reads the field** | deliberate: only the trail may be lost, never the state change | app HTTP. **The best-behaved site in the survey** — it reports its own partial failure. |
| **D9** | `lib/brain/scratch.ts:180` | INSERT `room` (app role, `:142`) → upsert `room_day` (brain role, via `:170`) | an orphan scratch `room` row, live and — per the file's own comment (`:129`) — **visible in every room listing**, with no day behind it. `resolveScratchGraph` returns `ok:false`; nothing cleans up the room | nothing | **no** | no | **cross-connection** |

---

## 5. THE ORDER-DEPENDENT SITES (R52-shaped)

Eleven sites where **the order of the writes is what makes today's behaviour safe**, and a reorder would break a
guarantee silently. Exactly one of them is pinned.

| site | the guarantee the order buys | pinned? |
|---|---|---|
| **A10** E18 verdict before state | a `silent` window always has an evidence row, so it can be bounded in time | **YES** — test + comments at both lines (`25d640f`) |
| **A3** diarize turn rows before the state row | `ok` is only claimed over a complete set of turns | no |
| **A4** window state before job state | a `transcribed` window is never claimed by a job that thinks it is unfinished | no |
| **A6** reason on the job row before parking the window | a parked window always has a readable reason | no |
| **A12** close before enqueue | the closed edge is the drain's only trigger | no |
| **B6** diarizeStore before the terminal status flip | the encounter is not shown done mid-diarization | no |
| **B7** note before `status='complete'` | `complete` never means "no note" | no |
| **B8** claim before work, release after | two workers never run one step | partly — the TTL enforces the effect, not the order |
| **C6/C7** delete errored run before transcribe | (this order *creates* the gap; listed because reversing it changes behaviour) | no |
| **D5** `complete` before `draft_partial` | completed rows do not fall into the partial bucket | no |
| **D6** insert samples before recompute | the centroid includes the new sample | no |

Three further sites are **order-sensitive in the other direction** — the order does not make them safe, it
chooses which bad state you get: **C2** (delete-first makes partial candidate loss permanent), **C3** (all-false
rather than double-winner), **C4** (stale WER rather than an honest gap).

---

## 6. CONSIDERED AND EXCLUDED — already atomic by construction

Listed so the denominator is visible. Each is **one statement**, therefore one implicit transaction even under
autocommit:

`lib/emotion/store.ts:180` `recordEmotionWindow` (INSERT…SELECT…FROM subquery…ON CONFLICT) ·
`lib/emotion/store.ts:320` `finishEmotionWindow` (CTE counting the rows in the write that uses them) ·
`lib/stt/diarize-window.ts:278` `recordDiarizeWindow` · `:340` `repairStaleDiarizeSegments` ·
`lib/stt/fanout.ts:56`/`:65` `enqueueSubject`/`enqueueBackfill` · `:236` the claim with `FOR UPDATE SKIP LOCKED` ·
`:219` the reclaim · `lib/stt/measure-job.ts:220`, `:303` · `lib/stt/window-scoring.ts:392` ·
`lib/stt/scoring.ts:253` `stt_gold` upsert · `lib/stt/room-drain.ts:486` the guarded claim (as one statement) ·
`lib/brain/fuse/live.ts:251` **the per-room_day loop inside `withRoomDayLock`** — a real transaction, the only
one in the pipeline · `lib/stt/silence.ts:509` **E18's bulk apply** (branch only) — UPDATE + ledger INSERT +
result in one CTE.

Read-only or write-free in the scanned set: `lib/stt/route-run.ts`, `speaker-clusters.ts`, `speaker-roles.ts`,
`window-leaderboard.ts`, `leaderboard.ts`.

---

## 7. WHAT I COULD NOT DETERMINE, AND WHY

1. **Whether any of these has fired in production, and how often.** There is no database in this pane. Every
   "if N fails" above is derived from the code, except A1, which is proven (E26, `445aec1`).
2. **Whether `BRAIN_DATABASE_URL` and `APP_DATABASE_URL` point at the same Postgres instance in the deployed
   environment.** §2b establishes that the *schema* is one database — 0042 creates the brain tables and 0053
   grants them to `brain_svc` — which is strong evidence, but the env values are secrets and were not read. If
   they ever pointed at different instances, `lib/bench-window.ts:347` would be reading a `room_day` the brain
   never wrote, so the code would already be broken; I record the inference and its basis rather than the value.
3. **The real frequency of the 5-minute reclaim and the 15-attempt cap.** Both are code constants; whether the
   cron that drives them runs at the assumed cadence was not verified.
4. **Whether `lib/stt/window-scoring.ts:387`'s decoupling was an oversight.** The comment addresses the
   opposite failure order to the one that loses the pair. Flagged, not judged.
5. **Sites outside the scanned set.** The sweep covered `lib/` and `app/` writers with two or more writes; the
   admin CRUD routes (`doctors`, `recipients`, `admins`, `stt-lab`) were counted in the per-file scan but not
   entered individually, because none of them writes a state column after writing rows elsewhere. If the PRD
   needs them, that is a second pass.

---

## 8. METHOD

Read-only throughout. `git grep` for write statements across `lib/` and `app/` gave a per-file count; every file
with two or more writes was examined for whether those writes are coupled. The three pipeline jobs, the drain,
the boundaries, the E16 pair, the E18 line, the auto-drain path and both facts in §1-§2 were read directly.
Three Researcher subagents (Sonnet, read-only, explicit output caps) surveyed the encounter route, the STT lab
writers and the brain/support writers respectively; **every finding above that came from one of them was
re-read against the source before it was written down**, and two of their conclusions were corrected in the
process — A12's "permanent" gap is conditionally self-healing (auto-drain, if the flag is on and within six
hours), and the "separate brain database" premise is wrong (§2b). Their reports are not reproduced here.
