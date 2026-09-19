# ETA — S1: the room-day tape. Build Spec v1.0

Date: 18 Sep 2026
Author: Fable (orchestrator), for a Sonnet Builder in Claude Code
Repo: `Even-Transcription-Assistant`, branch off `vinay/s1-auto-drain`
Status: SPEC. Read-only surface. Nothing in this spec writes to any table or changes any pipeline.

---

## 0. Read this first

**Goal.** One admin page that shows, for one room on one day, **every 15-minute window down the day** — the
time, what state the window is in, the transcript, the turns, who each turn was matched to and at what
score, the score that *lost*, and the emotion scores — with the gaps shown as gaps.

**Why this and why now.** Room audio has been draining into `bench_window`, `transcription_run`,
`room_diarize_window`, `room_turn_speaker` and `room_span_emotion` for weeks, and **nothing in the app
displays any of it.** V asked where it shows up in EvenScribe; today the honest answer is *nowhere*. Two
pieces of work are blocked behind that: the voice cosine thresholds (0.65 room / 0.70 encounter / 0.78
phone, all unratified) and the emotion floor. E20 shipped `losing_score` specifically so a threshold could
be set from evidence — **this page is where that evidence becomes visible.** It is also the thing that
makes Arm D's output inspectable when it lands.

**V's two rulings, 18 Sep, which decide the design:**
1. **The page leads with the tape**, not with reconstructed visits. Window-by-window down the day, raw
   truth of what the room heard. A visits view may come later; it is NOT in this spec.
2. **Voice AND emotion are both visible.** Not hidden behind a later phase.

**Delegation contract.** Build exactly the scope below. Report in the format in §9, under the cap. Anything
you could not verify is marked UNVERIFIED in your report.

---

## 1. Measured facts this spec depends on (18 Sep, verified against production — do not rediscover)

- 93 `room_day` rows exist, 18 Aug to 18 Sep. `room_day` is `UNIQUE(room_id, ist_date)`.
- 2,548 `bench_window` rows; **2,540 carry `room_day_id`, 8 do not.** The 8 must not vanish — see §5.4.
- `room_span_emotion`: **332 rows across 10 windows.** Real emotion data exists to render on day one.
- `room_turn_speaker`: **650 rows, 227 of them carrying `losing_clinician_id`.** Real E20 evidence exists.
- Today's coverage is uneven and the page must show that honestly: OPD 3 has 48 windows and **0**
  transcribed; OPD 4 has 48 and 3; Home Office 47 and 4. This is the drain shortfall (~6.4 windows/hour
  serviced against ~24/hour produced) and **the page's job is to make it obvious, not to smooth it over.**
- `EMOTION_SURFACE_ENABLED` is currently **unset**, so `canSurfaceEmotion()` returns false in production
  right now. The page must behave correctly in BOTH states (§6).

## 2. Extension points (verified 18 Sep, do not rediscover)

| Thing | Where | Note |
|---|---|---|
| House page pattern | `app/admin/encounters/[id]/page.tsx:1-40` | thin async server component: `readAdminCookie()` → `verifyAdminJwt()` → redirect `/admin` on failure → render `<AdminShell adminEmail active=… pageTitle=… breadcrumb=…>` wrapping a client component. **Copy this exactly.** |
| Client fetch pattern | `components/admin/EncounterDetailAdminClient.tsx:200-295` | the page passes only the id; the client component fetches its own bundle from `/api/admin/...`. |
| API auth pattern | `app/api/admin/encounters/[id]/route.ts:24-32` | every admin API route re-does `readAdminCookie` + `verifyAdminJwt` in its own local `guard()`. **Do the same; do not rely on the page's check.** |
| Query helper pattern | `lib/encounter/admin.ts` (`getFullEncounter`) | one `lib/<domain>/admin.ts` exporting the assembly function. |
| Nav | `components/admin/AdminShell.tsx:40-72` | add a key to the `AdminNavKey` union (line 40-51) and an entry to `NAV` (shape at line 69): `{ key, label, href, icon, section: "operate"\|"observe"\|"configure" }`. Use `section: "observe"`. |
| Closest existing reader | `lib/mcp/tools/fuse-report.ts:88` `fuseReport` | reads the cue/visit/tape join for one room-day. **Read it before you write the query** — reuse its SQL constants from `lib/brain/state.ts` (`SQL_ROOM_DAY_BY_ID`, `SQL_CUES_FOR_ROOM_DAY`) rather than writing new ones. Do NOT modify it. |
| Emotion gate | `lib/emotion/gate.ts` | `emotionEnabled(env)` gates compute+storage; `canSurfaceEmotion(env)` requires BOTH `EMOTION_ENABLED` and `EMOTION_SURFACE_ENABLED`, and throws `FlagValueError` on an unrecognised value. |
| Dormancy test | `tests/unit/c3-emotion.test.ts:39` | asserts NOTHING under `lib/**`/`app/**` calls `canSurfaceEmotion(`. **This spec makes S1 the first caller — see §6.3.** |
| Flags | `lib/flags.ts` `parseFlag` | enables `1\|true\|yes\|on`; disables `0\|false\|no\|off\|""`; anything else THROWS. |
| DB access | raw `sql` template from `@/lib/db` | **`db/schema.ts` is stale for every table below** (it lacks `transcription_run.subject_type` among others). Read migrations, not the schema file. Neon HTTP driver: no `sql.unsafe()`, no interactive transactions. |

## 3. Scope

**In scope:** three routes (room list, day list for a room, the tape), one API route, one query helper, the
nav entry, unit tests.

**Out of scope, do not build:** a visits view; any write, re-drain, re-diarize or re-score button; editing a
speaker label; audio playback; any change to `fuse-report.ts`, `room-drain.ts`, the diarize service, the
fuse arms, or any cosine threshold; any change to what the pipeline computes. This page **reads**.

---

## 4. Routes

| route | file | renders |
|---|---|---|
| `/admin/rooms` | `app/admin/rooms/page.tsx` | every room, with its most recent room-day and a count of days |
| `/admin/rooms/[roomId]` | `app/admin/rooms/[roomId]/page.tsx` | that room's days, newest first: date, window count, transcribed count, turn count, whether any voice match landed |
| `/admin/rooms/[roomId]/[date]` | `app/admin/rooms/[roomId]/[date]/page.tsx` | **the tape.** `[date]` is the IST date as `YYYY-MM-DD`, not a `room_day_id` — `UNIQUE(room_id, ist_date)` makes it unambiguous and V can type it. |

Each `page.tsx` is thin: auth + `<AdminShell active="rooms" …>` + the client component. All three client
components live under `components/admin/rooms/`.

## 5. The read model — `lib/room-day/admin.ts`, `getRoomDayTape(roomId, istDate)`

### 5.1 Column facts (verified from migrations; **do not read `db/schema.ts` for these**)

- **`bench_window`** (`0057`, altered `0092`, `0101`): `id, session_id, room_day_id (nullable), start_ms,
  end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at, created_at, auto_drain_refused_at,
  auto_drain_refused_reason`. Legal `state` (CHECK `bench_window_state_chk`, final form in `0101`):
  **`open, closed, transcribing, transcribed, failed, silent`** — all six must render distinctly (§5.3).
- **`transcription_run`** where `subject_type='bench_window' AND subject_id = <window id>`. Text lives in
  `transcript_original` and `transcript_english`. **`transcript_english` is NULL on every bench window that
  has ever existed** (the drain submits `translate:false`) and `detected_language` is NULL too — so the
  page reads `transcript_original` and takes language from `metrics_json`, never from `detected_language`.
  `metrics_json` keys: `activity, audio_seconds, segment_count, probe_language, probe_seconds,
  probe_engine, full_window_language, language_sent, sarvam_language, whisper_probe_ms,
  whisper_probe_attempts, whisper_full_ms, whisper_full_attempts, whisper_model_reported, clip_r2_key,
  window{start_ms,end_ms,source_mic}`, plus route-timeline keys (`language_timeline` with `spans`,
  `language_mix`, `engine_mix`, `spoken_seconds`) when present.
- **`room_diarize_window`** (`0074`, altered `0088/0090/0099`): `window_id PK, room_day_id, state
  (ok|failed|skipped|no_speakers), speakers_json, segments_json, clip_r2_key, error, timing_json,
  diarized_at, attempts, failure_history, last_run_id, segments_run_id`.
  **GOTCHA: `segments_json` times are RELATIVE TO THE CLIP** — `{start_ms, end_ms, speaker_idx, overlap}`
  with the window's `start_ms` NOT added. Add it once, in the helper, and never again downstream.
  **GOTCHA: `speakers_json` heuristic guesses are nested under `unverified_service_guess` since `0090`** —
  never render anything from there as an attribution.
- **`room_turn_speaker`** (`0074`, altered `0085/0090/0096`): PK `(window_id, source_ref)`; `speaker_idx,
  cluster_id, overlap_ms, room_day_id, created_at, run_id, clinician_id, role, match_confidence,
  no_role_reason, losing_clinician_id, losing_score, score_basis`. `role` CHECK: **`NULL` or
  `'clinician'`** — nothing else is legal, so do not invent role labels in the UI.
- **`room_span_emotion`** (`0089`, `0097`): PK `(window_id, diarize_run_id, speaker_idx, run_start_ms,
  chunk_idx)`. Scores: `anger, disgust, enthusiasm, fear, happiness, neutral, sadness` (double precision),
  plus `labels_json, top_label, top_score, speech_ms, service_speech_ms, speech_basis, source_refs text[],
  clip_r2_key, clip_start_s, clip_end_s, state (scored|skipped|failed)`.
  **GOTCHA: emotion carries no identity by design — join to `room_turn_speaker` on
  `room_span_emotion.source_refs @> ARRAY[room_turn_speaker.source_ref]`.**
- **`room_emotion_window`** (per-window job status): `state` is `ok|failed|no_segments|diarize_stale`.
  Render this state so "no emotion here" is explained rather than blank.
- **`room_day`** (`0042`): `id, room_id, doctor_id, ist_date, started_at, ended_at`, `UNIQUE(room_id, ist_date)`.
- **`cue`** (`0042`): `id, room_day_id, type (open set, no CHECK), payload jsonb, at, created_at`. Turn text
  is on `type='stt_turn'` payloads. **The payload's exact keys are UNVERIFIED** — `fuse-report.ts` reads
  `payload.window` and `payload.source_used`. **Read `lib/brain/state.ts` and confirm the shape before you
  depend on it; if a key you need is not there, say so in your report rather than inventing a fallback.**

### 5.2 Shape returned

```ts
type RoomDayTape = {
  room: { id: string; name: string; slug: string };
  room_day: { id: string | null; ist_date: string; doctor_id: string | null;
              started_at: string | null; ended_at: string | null };
  emotion: { compute_enabled: boolean; surface_enabled: boolean };   // §6
  totals: { slots: number; windows: number; by_state: Record<string, number>;
            turns: number; turns_named: number; turns_with_losing_score: number;
            emotion_windows_scored: number };
  slots: TapeSlot[];                       // ONE ENTRY PER 15-MINUTE SLOT ACROSS THE DAY'S SPAN
};

type TapeSlot = {
  start_ms: number; end_ms: number; label: string;      // "14:15–14:30 IST"
  kind: "window" | "no_recording";                      // no_recording = no row exists for this slot
  window?: {
    id: string; session_id: string; source_mic: string; state: BenchWindowState;
    grid_aligned: boolean; closed_at: string | null;
    auto_drain_refused_at: string | null; auto_drain_refused_reason: string | null;
    drain_reachable: boolean;                            // §5.5
    transcript: { text: string | null; language: string | null; activity: string | null;
                  audio_seconds: number | null; spoken_seconds: number | null;
                  segment_count: number | null; engine: string | null;
                  language_mix: Record<string, number> | null; latency_ms: number | null;
                  error: string | null } | null;
    diarize: { state: string; speaker_count: number | null; error: string | null;
               attempts: number; segments_run_id: string | null } | null;
    turns: TapeTurn[];
    emotion_window: { state: string; segments_scored: number | null;
                      segments_skipped: number | null; error: string | null } | null;
  };
};

type TapeTurn = {
  source_ref: string; speaker_idx: number; cluster_id: string | null;
  start_ms: number; end_ms: number;                      // ABSOLUTE — window start already added
  text: string | null;                                   // from the stt_turn cue, if joinable
  voice: {
    clinician_id: string | null; clinician_name: string | null;
    role: "clinician" | null; match_confidence: number | null;
    losing_clinician_id: string | null; losing_clinician_name: string | null;
    losing_score: number | null; score_basis: string | null;
    no_role_reason: string | null;
  };
  emotion: { top_label: string; top_score: number; speech_ms: number | null;
             speech_basis: string | null;
             scores: Record<string, number> } | null;    // null when not scored OR not surfaceable
};
```

### 5.3 THE SIX STATES MUST EACH READ AS THEMSELVES

`open`, `closed`, `transcribing`, `transcribed`, `failed`, `silent` are six different facts and the UI must
distinguish all six. In particular **`silent` is a verdict with evidence** (companion table
`bench_window_silence`, migration `0101`) and **`closed` means "waiting", not "nothing there"** — 2,236
windows sit in `closed` right now. A design that collapses `closed`, `silent` and `no_recording` into one
grey row is REJECTED: those are "not processed yet", "we listened and it was quiet", and "we were not
recording", and conflating them is the exact failure this page exists to prevent.

### 5.4 GAPS ARE DERIVED AT READ TIME, AGAINST A FRESH CLOCK (D-11)

Do **not** render only the rows that exist. Build the slot grid from the day's span — earliest
`bench_session.started_at` to `min(ended_at or now())` for that room and date — step it in 15-minute
slots, and place each `bench_window` into its slot. A slot with no window is `kind: "no_recording"`. An
absence is a rendered fact, never a missing row.

**The 8 windows with a NULL `room_day_id` must not vanish.** Resolve a window's room-day by
`room_day_id` when present, and otherwise by joining `bench_session.room_id` + the IST date of
`start_ms`. Report in your build report how many rows the fallback rescued for the day you tested.

### 5.5 `drain_reachable` — the number that makes the backlog visible

`AUTO_DRAIN_MAX_AGE_HOURS` (default 6, clamped 1..48) means the auto-drain will never pick up a window
older than that. **2,135 of the 2,236 closed windows are already past it.** Compute
`drain_reachable = state === "closed" && (now - start_ms) < AUTO_DRAIN_MAX_AGE_HOURS` and render an
unreachable closed window distinctly from a reachable one, with a one-line explanation in the UI that it
needs a deliberate backfill. Read the env through the existing helper in `lib/stt/auto-drain.ts`; do not
re-parse it.

---

## 6. Voice and emotion on the page

### 6.1 Voice — this is the E20 payoff, render it fully

For every turn show: the matched clinician and `match_confidence` when named; and **when unnamed, the
`losing_clinician_id` and `losing_score`** with `score_basis`. 227 rows already carry a losing score.
Sort/filter is not required in v1, but the day-level `totals` must report `turns_named` and
`turns_with_losing_score` so a threshold conversation can start from this page.

**Label `losing_score` as a raw cosine in [0,1], not a confidence.** They are different quantities and
`0096` says so explicitly. Show the three current thresholds (room 0.65 / encounter 0.70 / phone 0.78) in
the page's footnote **marked UNRATIFIED**, so nobody reads a rendered number as a settled one.

### 6.2 Emotion — visible, and honest about what it is

V has ruled emotion visible. Render `top_label`, `top_score` and the seven scores per turn, with
`speech_ms` beside them (a score over 300 ms of speech is not the same evidence as one over 30 s).

**Every emotion number on this page carries an UNCALIBRATED marker.** No floor has been set from data;
that work is downstream of this page. A number that looks settled when it is not is the failure mode here,
and it is worse for emotion than for anything else on the page because it reads as a judgement about a
named person. The marker is not decoration — do not let a "clean UI" pass remove it.

### 6.3 The gate, and the test that guards it

`canSurfaceEmotion(env)` requires BOTH `EMOTION_ENABLED` and `EMOTION_SURFACE_ENABLED`.
`EMOTION_SURFACE_ENABLED` is unset in production today, so the page must ship correct in both states:

- gate **true** → emotion rendered as §6.2.
- gate **false** → the emotion column renders the words **"emotion surface off"**, and
  `TapeTurn.emotion` is `null`. It does NOT silently disappear, and the helper does NOT query
  `room_span_emotion` at all — the gate is checked before the query, so "off" costs nothing.
- `emotion.compute_enabled` and `emotion.surface_enabled` both ride in the payload so the page can say
  which of the two is off.

**S1 becomes the first caller of `canSurfaceEmotion()` in the codebase.** `tests/unit/c3-emotion.test.ts:39`
asserts that nothing calls it. **Change that test, do not delete it:** it must now assert that the call
sites are exactly the S1 read path (an allowlist of one file) and nothing else. A test that stops checking
is worse than no test — the point of that assertion is that a second, unreviewed surface cannot appear
quietly. Say in your report exactly what the new assertion is.

---

## 7. Tests (`tests/unit/room-day-tape.test.ts`), with the fake-pg harness used by `tests/unit/fuse-arms.test.ts`

Required cases:
1. A day whose windows do not cover the whole span produces `no_recording` slots in the holes, and the
   slot count equals the span divided by 15 minutes.
2. Each of the six `bench_window` states survives to the payload distinctly — a table-driven case over all
   six, asserting six different rendered kinds.
3. `closed` older than `AUTO_DRAIN_MAX_AGE_HOURS` ⇒ `drain_reachable:false`; inside it ⇒ `true`. Use an
   injected clock, not `Date.now()` — a test that passes only today is not a test.
4. Diarize segment times are shifted by the window `start_ms` exactly once (feed a segment at clip-relative
   0 and assert the absolute value equals the window start).
5. A window whose `room_day_id` is NULL is still placed, via the `bench_session` + IST-date fallback.
6. Gate false ⇒ `emotion` is null on every turn AND `room_span_emotion` was never queried (assert on the
   fake pg call list, not on the output alone).
7. Gate true ⇒ emotion joins to the right turn through `source_refs @> ARRAY[source_ref]`, including a turn
   with two source_refs and one with none.
8. An unnamed turn carrying `losing_clinician_id`/`losing_score` renders both, and `losing_score` is not
   relabelled as a confidence anywhere in the payload.
9. `transcript_english` NULL and `detected_language` NULL (the real production shape) still yields a
   transcript from `transcript_original` with a language from `metrics_json`.

---

## 8. Not in this spec, listed so nobody builds them by accident

- A visits view, or any rendering of `visit` / fuse-arm output.
- Any button that re-drains, re-diarizes, re-scores, or edits a speaker label.
- Audio playback or clip download.
- Changing any threshold, or reading one from anywhere but the existing env helper.
- Backfilling the 2,135 unreachable windows — that is its own job, not a page feature.
- Touching `fuse-report.ts`, `room-drain.ts`, `auto-drain.ts`, `gate.ts`, or any migration.

## 9. Builder contract

**Allowed changes:** new files under `app/admin/rooms/**`, `app/api/admin/rooms/[roomId]/days/[date]/`,
`lib/room-day/admin.ts`, `components/admin/rooms/**`, `tests/unit/room-day-tape.test.ts`; minimal edits to
`components/admin/AdminShell.tsx` (nav key + entry only) and `tests/unit/c3-emotion.test.ts` (the
allowlist change in §6.3, nothing else).
**Forbidden:** every file in §8; any migration; any CHECK constraint; any write statement anywhere in the
new code — the helper issues SELECTs only.
**Verify before reporting:** `npm test` green; `npm run typecheck:tests` green; the page renders for a real
room-day (use OPD 4 Ortho on 2026-09-18 — 48 windows, 3 transcribed, so it exercises `transcribed`,
`closed` and gaps in one screen) and for a day with NO transcribed windows (OPD 3 on 2026-09-18, 48
windows, 0 transcribed) without erroring or rendering an empty page; `EMOTION_SURFACE_ENABLED` unset ⇒
"emotion surface off" and no query to `room_span_emotion` (prove it).
**Do not:** widen scope to a visits view; add a dependency; put transcript text into logs or traces;
"tidy" the UNCALIBRATED and UNRATIFIED markers away.
**Report format (cap 400 words plus the file list):** commit SHA on branch `vinay/s1-room-day-tape`; files
added and changed; test count before and after; the exact new assertion in `c3-emotion.test.ts`; how many
NULL-`room_day_id` windows the fallback rescued; the confirmed `stt_turn` payload shape (or UNVERIFIED with
what you found instead); any place this spec was wrong or underspecified, with what you did and why; every
UNVERIFIED item. Large logs go to `docs/handoff/scratch/s1-build-<date>.log`.

## 10. Known gotchas

- Neon HTTP driver: no `sql.unsafe()`, no interactive transactions; timestamps come back as ISO strings,
  not `Date` objects — calling `.toISOString()` on one crashes.
- `db/schema.ts` is stale for every table in §5.1. Read the migrations.
- Vercel env vars are baked at BUILD time — flipping `EMOTION_SURFACE_ENABLED` later needs a redeploy, not
  just a setting change. Note it in the PR body so nobody is surprised.
- SWC rejects `\u{XXXX}` escapes inside JSX text.
- This repo commits NO npm lockfile; Vercel runs `npm install`, not `npm ci`.
- `parseFlag` THROWS on an unrecognised flag value — an unset variable is fine, a typo'd one is a 500.

## 11. Open decisions

None. Both design questions (tape-first; voice and emotion both visible) were ruled by V on 18 Sep.
