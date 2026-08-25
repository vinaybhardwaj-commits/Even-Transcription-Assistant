# Build 1 — the page tells the truth

**Kickoff for Claude Code. Paste this whole file.**
Spec: `ETA-MONITORING-SURFACE-PRD-24-AUG-2026-v1.2.md`, same folder. Read it before you write code.
Production `6594170`, migrations `0065`. Repo `~/dev/Even-Transcription-Assistant`.

**All design decisions are settled.** The PRD carries 35 of them, D1 to D35, ratified by V on
24 August. Do not reopen any. If something genuinely is not covered, flag it in your report — do
not decide it silently.

---

## 0. The one rule for this build

**Nothing in this build may touch anything that records, uploads, or stores audio.**

This is Build 1 of three. It changes what the operator page *says*. Build 2 changes the room page
and the recorder; Build 3 adds recovery. A live pilot is running in two clinic rooms, so this
build has to be safe to deploy on a working day.

Concretely: no change to the kiosk, the recorder, the chunk upload path, the window writer, the
drain, or any migration that alters behaviour. Read paths and rendering only.

---

## 1. Why this build exists

Four alarms have been raised on this page in front of a person. **Every one of them fired on
healthy behaviour:**

| Alarm | Fired on |
|---|---|
| the end-time alarm, first version | every ordinary end of day |
| the doctor clock | every room, thirty minutes after it starts |
| main microphone lost | two working microphones, twice in one morning |
| kiosk dropped | every room, every time a day is ended on purpose |

The cost is not noise. On 24 August the one true alarm on the page — Cardiology recording for an
hour with no day record, so none of its audio could be processed — sat unread underneath two false
ones.

---

## 2. Read these first

| File | Why |
|---|---|
| `lib/admin/rooms-live.ts` | The whole server-side picture: `roomState()`, the lane views, the vitals, the thresholds, the rollup. Most of this build is here. |
| `components/admin/BenchRoomsLive.tsx` | The room cards, the attention list, the lanes, the switches, the day summary. |
| `app/api/admin/bench/rooms-live/route.ts` | The route the page reads. |
| `lib/mcp/tools/bench.ts` | `scribe_diff_room` — "the door". It must end this build agreeing with the screen. |
| `lib/bench-bus-constants.ts` | Freshness and stall windows. Reuse; do not invent new numbers. |
| `app/api/admin/bench/drain/route.ts` | Read only for its SQL. It has the verified column names for `bench_window`, `stt_subject_job` and `transcription_run` — see §6. |
| `tailwind.config.ts` | Read the warning comment at the top. See §7. |
| `ETA-MONITORING-SURFACE-PRD-24-AUG-2026-v1.2.md` §3.1, §3.4, §3.5, §3.6, §3.7 | The requirements themselves. |
| `ETA-MONITORING-SURFACE-MOCKUP-24-AUG-2026.html` | Approved by V on 24 August. The card in section 1 and the panel in section 2 are what you are building. |

---

## 3. What to build — six items

### 3.1 Hide the doctor clock

Nothing in production writes warehouse clock events. The only writer is a script run by hand. When
there is no event, the code **falls back to the time recording started**, so the number displayed
is the length of the recording wearing the label of a clock gap. Every room turns red thirty
minutes in. Worse, the screen falls back and the door does not, so the two disagree about the same
room.

Do:
- Render the **This doctor** row only when a genuine warehouse-typed cue exists on that room-day.
  With none, the row does not render and its attention rule cannot fire.
- **Delete the fallback to session start in both `lib/admin/rooms-live.ts` and
  `lib/mcp/tools/bench.ts`.** Neither may ever substitute a different clock for a missing one.

Do not:
- Do not remove the vital's code or its thresholds. It returns when something feeds it.
- Do not change the label. It stays **This doctor**, never "the warehouse".
- **Banned phrases stay banned**: nothing may render "warehouse silent", "no warehouse event", or
  anything implying Pulse is down. There is a test asserting this. Keep it, and extend it if you
  add copy.
- Do not attempt to work out which doctor is really in the room. That is fenced off by name in the
  PRD and the hospital field that would support it is empty on all three hospitals.

### 3.2 A seventh state — finished for today (D30)

Today both clinic rooms were ended deliberately at 16:16 and then read **"Kiosk dropped 9m ago —
it may come back on its own"**, in amber, telling the operator to reopen a page. There is no state
for a day that is simply over.

Add `finished` to `roomState()`:
- **Condition**: the room's most recent session today has `status = 'ended'`, and no session is
  recording.
- **Precedence**: after `paused` and `recording`, before `ready`, `dropped` and `offline`.
- **Copy**: label `Finished for today · 4h 21m recorded`, hint `Press start to record again`.
- **Level**: `ok` or a neutral grey. **Never amber.**

The other six states keep their meanings, their order and their copy. D30 is licence to add one
state, not to reshuffle the chain.

### 3.3 Stranded audio, in minutes (D7)

The page counts pieces and never says how much *time* cannot be turned into words. On 24 August
that number was over eight hours and was invisible.

Add one figure to the day summary and one per room card: **minutes that cannot currently be turned
into words**, broken into three reasons, computed from `bench_window`:

| Reason | Condition | Copy |
|---|---|---|
| waiting for someone to run it | window `state = 'closed'` and no row in `stt_subject_job` for it | `waiting for someone to run it` |
| cannot be processed — no day record | window has no `room_day_id` | `cannot be processed — this room has no day record for today` |
| never closed | window `state = 'open'` after its session ended | `never closed — the recording did not cover the whole slot` |

**Verified tonight against production**: Cardiology session `bs_z3gpbh6e` has 20 windows — 17
`closed` with **no job row at all**, and 3 `open`. So "17 waiting" on the card today was counting
finished windows, not a queue. Nothing was ever enqueued.

Minutes come from the window's own span (`end_ms - start_ms`), not from piece durations. If you
also surface "audio recorded", say plainly in the copy that the two are measured differently —
one sums pieces, the other sums window spans — or make them commensurate. Do not present two
incomparable numbers as if they compare.

### 3.4 Copy fixes

- A lane with finished windows and no worker reads **"waiting for someone to run it"**. Today it
  reads "waiting to be turned into words" and the attention row offers to make it "stop trying".
  **Nothing is trying.** There is no scheduled pass anywhere in this system; a person runs each
  one by hand. Never offer to stop something that is not running.
- The sessions list badge that reads **"on backup mic · 40 chunks"** for a session that ran on its
  main microphone throughout: that badge reads the stale lost-microphone flag. In this build,
  **stop rendering that badge from the flag.** Do not replace it with a size judgement — that is
  Build 2. Render nothing rather than something false.
- A room with one microphone says nothing about a spare (D32). No empty lane, no grey placeholder,
  no amber vital. Most rooms have one microphone and that is normal.

### 3.5 Show what is already on the wire (D8)

No new queries. These are computed, sent to the page and discarded:

- last piece from each microphone, separately — today only the newer of the two is shown
- pieces from a spare today, as a number rather than only a flag
- when the last consult mark was pressed
- minutes turned into words, per room — today only the all-rooms total is shown
- the thresholds themselves, so a person can see that amber means seven minutes
- the per-room degraded list, assembled and never read

### 3.6 The screen and the door must agree (D8, §3.6)

Three known divergences, all the same bug:

1. The screen has the end-time-disagreement alarm; the door reports the mirror-image check; neither
   has both. **Give both to both.**
2. **The door does not report the two processing switches at all.** An automated watcher cannot
   warn that a room is recording into nothing. Add `transcript_enabled` and `visits_enabled` to
   `scribe_diff_room`'s answer.
3. The doctor-clock fallback exists on one side only. Fixed by 3.1.

**Make one shared source for every room fact and have both call it.** Anything the screen can say,
the door can say, in the same words. This is the item most likely to be done shallowly — do not
copy logic into two places, move it into one.

---

## 4. Do not touch

- The kiosk, the recorder, the chunk upload path, the window writer, the drain.
- The six existing room states, their order and their copy.
- The microphone freshness vitals and their 7 and 10 minute thresholds. Size is Build 2.
- The abandoned-session repair control and the marks row.
- The end-time alarm's discriminator. It compares **capture** times, not arrival times, and it was
  built that way because the first version fired on every ordinary end of day. Leave it.
- `package.json` dependencies. Deploy config. Auth guards.
- The vocabulary. The lanes are **Tape**, **Transcript**, **Visits**. The page never says drain,
  fuse, subject, window, cue, or the name of any table.
- Green means working. On-with-nothing-to-do is grey, not green.

---

## 5. Two traps that have already cost this project

**A failed read must not silence a different alarm.** The page correctly treats "cannot tell" as
unknown, but that means one failed query turns the day-record answer unknown in *every* room and
silences the no-day alarm — which is the one true alarm this page has ever raised. If you add a
query, make its failure local to the thing it feeds.

**Check every new alarm against an ordinary day before you ship it.** Four for four so far. If a
new rule fires on a healthy room doing a normal thing, the rule is wrong, not the room.

---

## 6. Schema honesty

You have no live database. Every column name you write is inferred unless it appears below.

**Verified tonight by running against production** (read from `app/api/admin/bench/drain/route.ts`
and confirmed by a live call): `bench_window(id, session_id, start_ms, end_ms, source_mic, state,
clip_r2_key, room_day_id, grid_aligned)` · `stt_subject_job(subject_type, subject_id, tier, state,
attempts, last_error)` · `transcription_run(subject_type, subject_id, engine, stt_engine_id,
detected_language, latency_ms, metrics_json, transcript_original)` · `bench_session(id, room_id)` ·
`room(id, slug, name, disabled_at, transcript_enabled, visits_enabled)`.

`bench_window.state` values seen in production: `open`, `closed`, `transcribed`.
`stt_subject_job.subject_type` value seen: `'bench_window'`. `tier` value seen: `'asr'`.

**Everything else you write is inferred.** For every inferred query:

- It must **fail safe**. An error degrades to empty, unknown, or a hidden row — never a 500, never
  a wrong number on screen. A vital that cannot be computed reads *unknown*, never *false*.
- List every inferred SQL string **verbatim** in your report. I validate them against the live
  database before anyone relies on the page.

No migration in this build unless you can show it is additive, idempotent, and changes no
behaviour. If you think you need one, flag it instead of writing it.

---

## 7. The palette trap

Tailwind silently drops undefined palette shades. It has happened three times. The last one made a
switch that was **on** render white, which looks off — on the control panel. `tailwind.config.ts`
already carried a warning comment about exactly this, and a comment is not a control. There is now
a test that reads the palette and fails on any undefined shade.

Every colour you add must be a defined shade, and **acceptance requires a screenshot**, because the
last one was caught by looking, not by any test.

---

## 8. Gate before you push

All of these, no exceptions:

1. `tsc` clean for every file you touched
2. every existing test green — including the banned-phrases test and the palette test
3. full production build green
4. new tests for: the finished state and its precedence; the doctor clock hidden when no warehouse
   cue exists; stranded minutes for each of the three reasons; the door and the screen returning
   the same answer for the same room
5. a screenshot of the room card and the day summary

A failing gate blocks the push. Push directly to `main` after it passes.

---

## 9. Report back with

- the commit sha
- gate results, item by item
- **every inferred SQL string, verbatim**
- the screenshot
- anything you flagged rather than decided
- any place where the PRD was genuinely ambiguous, so I can fix the PRD rather than argue with the
  code
- confirmation, explicitly, that you touched nothing in the do-not-touch list in §4
