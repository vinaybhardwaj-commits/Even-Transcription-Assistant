# ETA — THE ENCOUNTER STEP CLAIM, ITS TTL, AND OVERLAPPING WRITERS · 17 Sep 2026 · Researcher (Mac Mini)

READ ONLY. Main clone `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant`, branch `vinay/s1-auto-drain`, HEAD
`c8ffc12`. I read the route in this clone, and `git diff HEAD` on it is empty. `-e32b`, `-rr23` and `-b2` were not
entered. No source edited, no test run, no database, no Docker. This file is uncommitted. No fix is proposed.

All `route.ts` lines below are `app/[slug]/api/encounters/[id]/process/route.ts`.

**Marking.** Anything not read with my own eyes in this session is **UNVERIFIED**. Three platform facts that decide
reachability are marked that way, and I say what changes if they are wrong.

---

## 0. HEADLINE

1. **The timeline as posed is almost certainly not reachable between two step-mode invocations.** In it, A is
   still alive at t=310 after claiming at t=0. But the claim is written *after* the invocation starts, and the
   platform kills the invocation at `maxDuration = 300` s from its start. So A dies before its own claim can
   expire. This rests on one platform fact: that `after()` work is bounded by `maxDuration`. **UNVERIFIED.** A
   residual race exists only for a statement A sent just before the kill that lands late (§4a).
2. **Overlapping writers are nevertheless reachable today, without any TTL expiry, through two doors the claim does
   not cover:**
   - **The doctor's "Retry processing" button** (`components/encounter/EncounterDetailClient.tsx:520-523`) runs
     the **streaming branch, which takes no claim**, while the background step machine is still running. The page
     shows the button whenever the encounter is `processing` and older than 5 minutes by `recorded_at`.
     `recorded_at` is stamped **when the recording screen opens** (`components/recording/RecordingScreen.tsx:92`
     → `app/[slug]/api/encounters/route.ts:76`; `db/migrations/0001_init.sql:101` `DEFAULT NOW()`). **So for any
     consultation longer than 5 minutes the button is on screen the moment processing begins**, beside the text
     "It may still be finishing in the background — you can keep waiting, or retry if it seems stuck." "Regenerate"
     (`:685`, on `complete`) is the same claimless branch.
   - **The admin recovery doors null a live claim.** `app/api/admin/resume-processing/route.ts:91`, `:105`, `:113`
     set `processing_step_at = NULL` unconditionally, then drive steps. The step machine's own unfenced release
     (`route.ts:884`) then clears the *new* claim.
3. **Blast radius: patient-facing, not only bookkeeping.**
   - The clinical note, the CDS output, the displayed transcript, the native analysis and the speaker-tagged
     conversation can each end up from a **different generation** of the same consultation.
   - The note and the CDS are **emailed together** (`app/[slug]/api/encounters/[id]/send/route.ts:97`, `:149`), so
     a doctor can send a note beside decision support computed from a different note.
   - The worst concrete case: a note generated from the **finalize placeholder transcript**, stored beside the final
     transcript, never regenerated (§5, M3).
   - **Every write is `WHERE id = $id`**, and every input is that encounter's own audio and transcript. **No
     cross-patient mixing is possible through this mechanism.**

---

## 1. THE CLAIM

**Where:** `route.ts:782-797`, step mode only (`if (internal && stepRequested)`, `:670`). Quoted:

```sql
UPDATE encounter
   SET processing_step_at = now(), process_attempts = process_attempts + 1,
       status = CASE WHEN status = 'complete' THEN status ELSE 'processing' END
 WHERE id = ${id}
   AND (processing_step_at IS NULL OR processing_step_at < now() - interval '5 minutes')
 RETURNING id
```

(SQL comments at `:786-789` omitted.) A throw is caught, logged `[process:step] enc=… claim FAILED` (`:796`), and
treated as not held. `:798` `if (claim.length === 0)` returns `skipped: "locked"` with the holder's age
(`:805-811`).

**What it writes:** `processing_step_at` (DB `now()`), `process_attempts + 1`, and `status` (`processing` unless
already `complete`). Column origin: `db/migrations/0033_processing_step_lock.sql:6`, "Ensures only ONE pipeline
step runs at a time per encounter … Lock auto-releases after 5 min if a worker dies mid-step."

**What it guarantees:**
- At most one **step-mode** invocation passes `:798` for a given `processing_step_at` window. That depends on the
  guarded UPDATE being atomic per row: Postgres re-checks the WHERE on the locked row under READ COMMITTED.
  **Documented behaviour, not re-read this session: UNVERIFIED.**
- It guarantees nothing about any caller that does not run this statement:
  - the streaming branch (`:913-1244`)
  - the non-streaming fallthrough (`:1248-1333`)
  - the reaper (`app/api/admin/reap-stuck/route.ts:93-118`, no `processing_step_at` predicate)
  - the admin doors (`resume-processing/route.ts:88-113`)

**Identity: none.** The claim returns only `id` (`:792`). Its holder is recorded nowhere. `processing_step_at` is
a timestamp that no later statement reads back or compares. `process_attempts` is a counter that is reset to 0 on
release (`:884`) and by the admin doors, so it is not an identity either.

## 2. THE RELEASE

| where | statement | when |
|---|---|---|
| `route.ts:883-884` `releaseAndReset` | `UPDATE encounter SET process_attempts = 0, processing_step_at = NULL WHERE id = ${id}` (`.catch`) | sync mode, if progressed (`:892`); async mode, if progressed (`:902`), then `selfChain()` (`:903`) |
| `route.ts:825` | `UPDATE encounter SET processing_step_at = NULL WHERE id = ${id}` (`.catch`) | translate step with a pending chunked job (`:822-826`) |
| `resume-processing/route.ts:90-92` | `UPDATE encounter SET diarize_status = NULL, diarize_error = NULL, process_attempts = 0, processing_step_at = NULL WHERE id = ${manualId}` | admin `?rediarize=1` |
| `resume-processing/route.ts:105-109` | `UPDATE encounter SET status = 'processing', process_attempts = 0, processing_step_at = NULL, translated = false, note_json = NULL, cdmss_json = NULL, … WHERE id = ${manualId}` | admin `?reset=1` |
| `resume-processing/route.ts:113` | `UPDATE encounter SET status = 'processing', process_attempts = 0, processing_step_at = NULL WHERE id = ${manualId}` | admin `?id=` resurrect |

Not progressed means no release: the claim is held to its TTL (`:905`).

**No release verifies the releaser is the holder.** Each matches on `id` alone. The missing predicate is a check
that the row still holds *this* invocation's claim. The claim returns nothing that could be checked, and the row
carries no holder.

**The repo already has the fenced form one file away.** `lib/diarize-gate.ts`:
- claims with a holder string: `INSERT INTO diarize_slot (slot, holder, acquired_at, expires_at) … ON CONFLICT
  (slot) DO UPDATE SET holder = EXCLUDED.holder, … WHERE diarize_slot.expires_at < now() RETURNING holder`
  (`:143-149`)
- checks it got its own holder back (`:151`)
- releases with `DELETE FROM diarize_slot WHERE slot = ${DIARIZE_SLOT} AND holder = ${holder}` (`:175`)

Its header (`:18-21`) names `processing_step_at` as "the same idiom". It is the same idiom minus the holder.

## 3. THE TTL

- **Figure:** `interval '5 minutes'` in the claim's WHERE (`route.ts:791`) = 300 s.
- **maxDuration:** `export const maxDuration = 300;` (`route.ts:53`). `FN_BUDGET_MS = maxDuration * 1_000` (`:56`).
  No override in `vercel.json` (no `functions` block) or `next.config.js` (grep: no `maxDuration`).
  **They are equal.**
- **What the platform does at 300 s:** it kills the invocation, including work scheduled with `after()`. Next.js
  on Vercel runs `after()` via `waitUntil` inside the same `maxDuration`. **Platform behaviour, not read in this
  repo: UNVERIFIED.** The code assumes it (`route.ts:559-565`; `lib/diarize-gate.ts:18-20`, "a worker killed
  mid-call (Vercel function timeout …)").

**Row state at the kill:**
- `processing_step_at` = the claim time
- `process_attempts` = incremented and not reset (the release never ran)
- `status` = `processing`, or `complete` if the step was a post-completion step (`cdms`, `diarize`, `:731-743`)
- whatever the step had written so far. Examples:
  - translate: `router_job_id` (`:299`), or an intermediate `transcript_raw` from any of `:250`, `:321`, `:361`,
    `:382`, `:412`, `:426`, `:454`, but not `translated = true` (`:830`)
  - diarize: `diarize_status = 'running'` (`:540`)

**Who picks it up next:**
- **Not the self-chain.** It only runs after a release (`:899-904`), and the invocation is dead.
- **`status = 'processing'`: the resume cron.** It runs every 3 min (`vercel.json:13-14`) and selects `status IN
  ('processing','failed')`, recorded 4 min to 24 h ago, `process_attempts < 15`, `ORDER BY recorded_at ASC LIMIT 1`
  (`resume-processing/route.ts:120-126`). Its sync loop meets `skipped: "locked"` until the TTL passes, sleeps 2 s
  per retry (`:52`), and stops after 30 iterations or 250 s (`:36-38`, `:40`), so a later tick takes it.
  - The hourly reaper also takes `processing` rows recorded more than 30 min ago and moves them to
    `complete`/`draft_partial`/`failed` **without looking at `processing_step_at`** (`reap-stuck/route.ts:93-118`).
- **`status = 'complete'` (killed in `cdms` or `diarize`): nobody.** Both the cron and the reaper exclude
  `complete`. `needCdms` stays true (`:736`) and nothing schedules it. It is re-driven only by a doctor's
  "Regenerate" (the streaming branch) or an admin door.

## 4. THE OVERLAP WINDOW, CONCRETELY

### 4a. The timeline as posed — two step-mode invocations across a TTL expiry
1. A's handler starts (`:90`, `requestT0`). It parses the body (`:109-121`) and loads the row in one Neon HTTP
   round trip (`:138-146`).
2. A claims (`:782-797`). `processing_step_at = t_c` (DB time), where t_c ≥ A's start + δ and δ ≥ that round trip.
3. Async: A ACKs (`:908`) and runs the step in `after()` (`:898`).
4. The platform kills A at A's start + 300 s ≤ t_c − δ + 300 s. **UNVERIFIED** (§3).
5. B can claim only when DB `now()` > t_c + 300 s. **A has been dead for at least δ.**

**So "A writes at t=310 after B claims at t=301" is not reachable** if step 4 holds. The two clocks differ only by
an offset, and both spans are 300 s.

**Residual race:** a statement A *sent* just before the kill still executes server-side. If its round trip exceeds
δ plus the gap to B's arrival, it lands after B's claim. Example: A's note write `:850` lands after B's claim; B
loaded its row at `:138` *before* claiming, so B planned from a row without that note, regenerates it, and
overwrites `note_json`. B would have to arrive within about one Neon round trip of TTL expiry: a cron tick, since A
cannot self-chain once dead. **Narrow. Frequency UNVERIFIED.**

**If step 4 is false** (`after()` outlives `maxDuration`), the timeline as posed is live exactly as described:
A's write at t=310 lands over B's claim, and A's `releaseAndReset` (`:884`) clears B's claim.

### 4b. REACHABLE — the doctor's Retry button during background processing (no TTL involved)
Long recording, over 480 s, so it takes the chunked path (`:283`). Background processing is on by default:
`lib/live-flags.ts:33-34`, `NEXT_PUBLIC_ETA_BACKGROUND_PROCESSING !== "0"`.

1. `finalize-upload/route.ts:244-251` writes `transcript_raw = <live or placeholder>` and `status = 'processing'`.
   For non-English, the placeholder is the code-mixed live text: `:231`, "placeholder; /process replaces with
   batch English". Its `after()` POSTs `{step:true}` (`:86-92`).
2. **A** (step, async) loads the row (`:138`): `translated = false`, `note_json = NULL`. A claims (`:782`). In
   `after()`, `translateIfNeeded` (`:821`) submits the chunked job and writes `router_job_id = J` (`:299`), then
   polls up to 240 s (`:305-343`).
3. The doctor opens the encounter page. The status is `processing` with no note (`EncounterDetailClient.tsx:491`),
   and `recorded_at` is more than 5 min old, so "Retry processing" renders (`:520-523`). The doctor taps it:
   `runProcess(true)` → `fetch(…/process, {Accept: ndjson, body: {force:true}})` (`:217-225`).
4. **S** (streaming) loads the row (`:138`): `translated = false`, `router_job_id = J`, `note_json = NULL`.
   **No claim.**
5. S `translateIfNeeded` (`:968`) polls the same job J (`:292`, `:305`). If J is still running at S's 240 s
   deadline: `jobPending = true; return;` (`:344`). **The streaming branch never reads `jobPending`**: its only
   readers are `:822`, `:891`, `:899`, all in step mode.
6. S runs `guardTranscripts` (`:969`), which may write `transcript_raw`/`transcript_original` (`:506-510`), then
   `assessAndFlag` (`:970` → `:482`).
7. S calls `generateNote(row.transcript_raw!)` (`:998`) **on the finalize placeholder**, then writes
   `UPDATE encounter SET note_json = <N_S>, transcript_clean = <placeholder> WHERE id = $id` (`:1051-1055`).
8. A's poll deadline passes. A releases (`:825`) and self-chains (`:899`). **A2** claims and polls J. J finishes,
   and A2 writes `transcript_raw = <chunked English>, transcript_original, translated = true, …` (`:321-328`), then
   guards and writes `translated = true` (`:830`). A2 releases (`:884`) and chains.
9. **A3** loads the row: `note_json = N_S` is present, so `needNote = false` (`:729`). **The background never
   generates a note from the real transcript.**
10. S runs `runCdmssPipeline(N_S)` (`:1077`) and writes `cdmss_json = C(N_S), status = 'complete'`
    (`:1131-1135`), then `diarizeStore(emit)` (`:1168`).

**End state:** `transcript_raw` = the chunked, translated transcript. `note_json` = a note generated from the
placeholder. `transcript_clean` = the placeholder. The doctor page displays `transcript_raw`
(`app/[slug]/encounter/[id]/page.tsx:76`) beside a note that was not written from it. It is permanent and nothing
flags it.

For a shorter file (up to 480 s, not chunked), steps 5-7 instead run a **second full translation** concurrently
(router `:382`, Sarvam `:412`, assist `:426`, fusion `:454`). Both runs write `transcript_raw`, and each note is
generated from its own run's in-memory transcript.

### 4c. REACHABLE — admin resurrect over a live step (the unfenced release, no TTL involved)
1. **A** (async) claims (`:782`) and runs the `note` step, calling `generateNote` (`:848`).
2. The admin calls `GET /api/admin/resume-processing?id=enc_…` (secret). `:113` writes `status = 'processing',
   process_attempts = 0, processing_step_at = NULL`. **A's claim is gone.**
3. `resumeOne` (`:39-45`) POSTs `{step:true, sync:true}`. **B** loads the row (`note_json = NULL`) and claims
   (succeeds, `:782`). B runs the note step.
4. A writes `note_json = N_A, transcript_clean` (`:850`), then `releaseAndReset` (`:884`) **clears B's claim**, then
   `selfChain` (`:903`).
5. **C** loads the row (`note_json = N_A`), claims (succeeds), runs `finalize` (`:864`), releases (`:884`), and
   chains to **D**. D loads `note_json = N_A`, claims, and runs `runCdmssPipeline(row.note_json = N_A)` (`:857`).
6. B writes `note_json = N_B` (`:850`) and releases (`:884`, **clearing D's claim**). The resume loop continues
   (`resume-processing:51`).
7. **E** (sync) loads `note_json = N_B, cdmss_json = NULL`, claims, and runs `runCdmssPipeline(N_B)`.
8. D writes `cdmss_json = C(N_A), status = 'complete'` (`:861`). E writes `cdmss_json = C(N_B)` (`:861`). **Whichever
   lands last wins.** If D is last, `note_json = N_B` sits beside `cdmss_json = C(N_A)`.

## 5. WHAT IS ACTUALLY AT RISK

**Reachable writer pairs:** step mode against streaming (§4b), and step mode against step mode after an admin door
(§4c). Below, S = streaming, P = step. Every statement is `WHERE id = $id`.

| artefact (column) | who sees it | step-mode writer | streaming writer | mixing |
|---|---|---|---|---|
| **clinical note** `note_json`, with `transcript_clean` | doctor page; **emailed** (`send/route.ts:97`, `:149`) | `:850` | `:1051-1055` | **M1**, M2, M3 |
| **CDS output** `cdmss_json` | doctor page; **emailed** (`send/route.ts:149`) | `:861`, from `row.note_json` as loaded at that invocation's `:138` | `:1131-1135`, from its own note; runs only if `!row.cdmss_json` at its load (`:1068`) | **M1** |
| **transcript** `transcript_raw` / `transcript_original` / `detected_language` / `translation_engine` / `language_timeline` | doctor page (`page.tsx:76`) | inside `translateIfNeeded` `:250`, `:321-328`, `:361`, `:382-390`, `:412`, `:426`, `:454-460`; guard `:506-510` | the same statements, via `:968-969` | **M2**, M3 |
| `translated` | step gate (`:727`) | `:830`, and the translate statements | the translate statements | feeds M3 |
| **native analysis** `native_analysis` | inspection | `:836`, `:839`, `:842` | `:983` | mismatched against the note |
| **speakers / tagged conversation** `speakers`, `transcript_segments`, `tagged_transcript` | doctor page (`EncounterDetailClient.tsx:690-718`) | `diarizeStore` `:578`, `:630`, `:631` (from `:867`) | the same statements (from `:1168`) | **M4** |
| `transcript_flag` | doctor page banner | `:482` | `:482` | last writer |
| passive voice sample `voice_sample` | voiceprint centroid | `lib/voice-samples.ts:198-215` (via `:599`) | the same | duplicate rows (no unique index, `0017`) |
| `status`, `processing_pct`, `processing_stages`, `process_attempts`, `processing_step_at` | bookkeeping and progress UI | many | many | bookkeeping |
| STT lab `transcription_run` | lab only | fan-out `after()` `:762` | fan-out `after()` `:1239` | duplicate runs |

**The mixing modes, precisely:**
- **M1 — note from one generation, CDS computed from another.** The P cdms step builds CDS from the note it loaded;
  S or another P writes a different note; the last `cdmss_json` write wins. **The emailed pair can disagree.**
  §4c walks it; §4b gives the same with "Regenerate" (`:685`) pressed while P's `cdms` step runs (P loaded
  `N_P`, S writes `N_S` then `C(N_S)`, P's `C(N_P)` lands last).
- **M2 — note beside a different transcript.** `note_json` and `transcript_clean` are written together (`:850`,
  `:1051`), so they always agree with each other. `transcript_raw`, the displayed transcript, is written separately
  by the other run's translation.
- **M3 — note from the placeholder, permanently** (§4b). The streaming branch ignores `jobPending`; once any note
  exists, step mode never regenerates one (`:729`).
- **M4 — speakers from one diarize run, tagged turns from another.** B1's shape, reached by two concurrent runs
  instead of a failed write. `diarizeStore`'s early return (`:533`) reads `diarize_status` as loaded, so both runs
  proceed. The depth-1 diarize slot (`lib/diarize-gate.ts`) serialises the `/diarize` calls, not the writes.

**Not at risk through this mechanism:**
- a different patient's data
- `note_json_edited`: the doctor's edits are not written by either branch, and send prefers them
  (`send/route.ts:119`)
- `send_event`

**Plainly: the blast radius is not confined to bookkeeping columns. The clinical note and the CDS that is emailed
with it can come from different generations, and the note can be generated from the placeholder transcript.**

**What bounds it:**
- Every generation is over the same audio of the same consultation.
- §4b needs a doctor tap on a button the page shows for every processing encounter older than 5 minutes.
- §4c needs an admin door used on an encounter still being processed.

How often either happens: **UNVERIFIED** (§6).

## 6. HOW OFTEN — what is on disk to look at (nothing was queried)

1. **`encounter`: `note_json IS NOT NULL AND transcript_clean IS DISTINCT FROM transcript_raw`.** In one
   uninterrupted run, every `transcript_raw` write precedes the note write, which copies it into `transcript_clean`.
   Step mode: translate and guard `:821-830` in an earlier invocation, the note at `:850`. Streaming: `:968-970`
   then `:1051`. A mismatch means a transcript write landed after the note's input was captured: M2/M3.
   - Other writers: `finalize-text/route.ts:74-75` writes both equal; `lib/encounter/admin.ts:336-337` nulls both;
     `finalize-upload/route.ts:247` runs before `/process`.
   - Caveat: rows from before this pipeline populated `transcript_clean` may false-positive. Filter by
     `recorded_at`. The date to filter from: **UNVERIFIED**.
2. **`llm_traces` where `surface = 'note-pipeline'`** (`db/migrations/0002_llm_traces.sql`: `encounter_id`,
   `started_at`, `completed_at`, `status`).
   - Only the **streaming** branch writes traces (`:990`, `:1069`); step mode writes none.
   - Any such trace on an encounter created with background processing on means a doctor ran Retry, Regenerate or
     Re-process. That is the precondition for §4b.
   - Two note-pipeline traces on one encounter with overlapping `[started_at, completed_at]` means two concurrent
     streaming runs (two taps or two tabs; the streaming branch has no claim).
3. **`llm_traces` where `surface = 'cdmss-analysis'`**: `request_input->>'note_summary'` is the note headline the
   CDS was computed from (`:1073`). A mismatch against the current `note_json` headline means the CDS came from a
   different note (M1), for streaming-produced CDS only.
4. **`voice_sample`**: more than one `source = 'passive'` row for the same `(clinician_id, source_encounter_id)`.
   The dup check (`lib/voice-samples.ts:198-203`) and insert (`:207`) have no unique index behind them
   (`0017:9-26`), so a duplicate is the signature of **two `diarizeStore` runs overlapping** (M4).
5. **`transcription_run`**: duplicate `(subject_id, engine, mode, tier)` rows for an encounter mean two fan-outs
   (`:762` and `:1239`). Weak signal: `dedupRuns` exists to remove these (`lib/stt/fanout.ts:306-322`).
6. **`audit_log` where `action = 'encounter.cancel_processing'`** (`:1197-1203`, action at `:1201`): a streaming run was in progress
   on that encounter.
7. **Vercel logs:**
   - function-timeout entries on `POST /[slug]/api/encounters/[id]/process` (each is a claim killed with
     `processing_step_at` set, §3)
   - `[process:step] enc=… claim FAILED` (`:796`)
   - `[process:step] enc=… step=… err=` (`:879`)
   - `[finalize-upload] enc=…` (submit time, `finalize-upload/route.ts:236`)

   Whether request logs record the `Accept` header, which separates streaming from step calls: **UNVERIFIED**.
   Retention: **UNVERIFIED**.
8. **Not available:**
   - **`send_event` stores no note body** (`send/route.ts:187-188`: `recipient_email, subject_rendered, status`),
     so what was emailed cannot be compared with what is stored. Whether the email provider retains bodies:
     **UNVERIFIED**.
   - Step mode logs no line on a successful claim or step, and `processing_step_at` is overwritten, so background
     step history is not reconstructable from the row.

## 7. WHAT THE DATABASE COULD HOLD — and what the Neon HTTP handle supports

The app handle is `neon()` HTTP (`lib/db.ts:31`). Each call is one autocommitted statement, or a fixed
`sql.transaction([...])` array with no application logic between statements (survey §2a, citing
`index.d.ts:316`; **not re-read this session: UNVERIFIED**).

| mechanism | what the database holds | HTTP handle? |
|---|---|---|
| **Holder id on the claim** | A column naming the holder, set by the claim; release and protected writes add `AND <holder> = $mine`. **The existing `processing_step_at` is already unique per successful claim** (a guarded UPDATE, microsecond `timestamptz`), but the claim does not `RETURNING` it (`:792`), so no caller knows its own value. | **Yes.** Every statement involved is a single conditional UPDATE. |
| **Conditional (fenced) updates** | Each write that must not land after losing the claim carries the holder predicate. A write that matches 0 rows has lost the claim. | **Yes**, per statement. A step with several statements (translate has up to eight writes) is fenced statement by statement, not atomically. |
| **Fencing token** | A monotonically increasing number issued by each claim, which writers must match or exceed. `process_attempts` **cannot** serve: it is reset to 0 by `:884` and by the admin doors. A new column would be needed. | **Yes**, same as above. |
| **Lease row** | The `diarize_slot` pattern (`lib/diarize-gate.ts:143-149`, `:175`; `db/migrations/0063_diarize_slot.sql:13-18`): holder, `expires_at`, steal-only-expired upsert, holder-fenced release. **Already in production in this repo.** | **Yes**, and it already runs on this handle. |
| **Advisory lock, session-scoped** | `pg_advisory_lock`, held for the step. | **No.** HTTP has no session. `lib/diarize-gate.ts:27-31` states `APP_DATABASE_URL` is "Neon's POOLED endpoint (pgbouncer, transaction mode), where a session-scoped lock is not safe to hold across statements." That is a code comment, and the env value was not read: **UNVERIFIED**. |
| **Advisory lock, transaction-scoped / `SELECT … FOR UPDATE`** | A lock held by an open transaction for the step's duration. | **No** on HTTP: it needs an interactive transaction spanning minutes of LLM and service calls. Technically possible on the WS `Pool` (`lib/brain/db.ts`, as `lib/brain/lock.ts` does for short holds), at the cost of an open transaction and connection for up to 300 s. Whether Neon rolls back and unlocks on a killed function's dropped socket: **UNVERIFIED**. |

**What none of these covers by themselves:** callers that do not take the claim. That is the streaming branch
(§4b), the non-streaming fallthrough, the reaper and the admin doors (§4c). The overlap reachable today goes
through exactly those callers.

## 8. FLAGS — facts, not decisions
1. **The reachable hazard is the claimless streaming branch plus a doctor button, not the TTL.** The TTL and
   unfenced release matter on their own only if `after()` outlives `maxDuration` (§4a), or via the admin doors
   (§4c).
2. **The Retry button's 5-minute threshold is measured from recording start**, so it appears immediately for
   consultations longer than 5 minutes (`EncounterDetailClient.tsx:520`; `RecordingScreen.tsx:92`).
3. **The streaming branch ignores `jobPending`** (`:344` vs `:822/891/899`). With a pending chunked job it
   generates the note from the finalize placeholder.
4. **Once a note exists, step mode never regenerates it** (`:729`), so M3 is permanent.
5. **A post-completion step killed at `maxDuration` is never retried** (`status = 'complete'`: excluded by the cron
   `resume-processing:122` and the reaper `reap-stuck:75`).
6. **The reaper moves `processing` encounters without looking at `processing_step_at`**
   (`reap-stuck/route.ts:93-118`), so a long encounter recorded more than 30 min ago can be flipped `failed` while a
   step is running.
7. **`send_event` does not record the note body**, so emailed content cannot be audited against stored content.

## 9. UNVERIFIED, collected
- Vercel/Next.js bound `after()` work by `maxDuration` from invocation start (§3, §4a). **This single fact decides
  whether the TTL timeline as posed is reachable.**
- Postgres re-evaluates a guarded UPDATE's WHERE on the locked row under READ COMMITTED (§1).
- `APP_DATABASE_URL` is a pgbouncer transaction-mode pooled endpoint (code comment only, §7).
- Neon HTTP `transaction()` is non-interactive (from the survey, §7).
- Which feature flags are on in production (`ETA_ROUTER_ON`, `ROUTER_JOB_ON`, `TRANSCRIPT_FUSION_ON`,
  `INDIC_NOTE_ASSIST_ON`): this changes which translate statements run in §4b, not whether it is reachable.
- Log retention, and whether request logs carry `Accept`. Whether the email provider keeps sent bodies.
- Whether `transcript_clean` was always populated historically (§6.1 false positives).
- Any production frequency.

## 10. METHOD
Read-only, main clone at `c8ffc12`, route diff against HEAD empty. I read:
- the route's entry (`:1-200`), `translateIfNeeded` (`:200-470`), guard, flag and diarize (`:470-661`)
- the step machine (`:661-910`), the streaming branch (`:913-1244`) and the non-streaming fallthrough
  (`:1248-1333`)
- all callers of `/process` (`finalize-upload`, `finalize-text`, the self-chain, `EncounterDetailClient`,
  `resume-processing`)
- the encounter page's processing card and buttons, and `RecordingScreen`'s encounter creation
- `lib/diarize-gate.ts` in full, and `reap-stuck`
- migrations `0001`, `0002`, `0017`, `0033`, `0063`
- the send route's SELECT and `send_event` insert

`git grep` found every writer of `processing_step_at`, `transcript_raw`/`transcript_clean` and `send_event`, and
every `jobPending` reader. No subagents; no test, database, Docker or worktree.
