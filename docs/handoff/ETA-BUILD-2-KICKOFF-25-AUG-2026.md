# Build 2 — the room and the tape

**Kickoff for Claude Code. Paste this whole file.**
Spec: `docs/handoff/ETA-MONITORING-SURFACE-PRD-24-AUG-2026-v1.2.md` — **it is in the repo now.**
Read §3.2, §3.3, §3.7, §3.8, §3.9, §4 and the decisions table before you write code.
Build 1 is `4d21eb8`, live. Migrations `0065`.

**All design decisions are settled.** 38 of them, D1 to D38, ratified by V. Do not reopen any. If
something is genuinely not covered, flag it in your report rather than deciding it silently.

---

## 0. What makes this build different from Build 1

**Build 1 could not break a recording. This one can.**

It touches the room page, the recorder and the window writer, while a pilot is running in two
clinic rooms that see real patients. Read §5 before you start, and hold to it.

The rule that governs every choice here: **the archive always wins.** If any change in this build
could cost one piece of clinical audio, it does not ship. A monitor that lies is survivable. A
recording that did not happen is not.

---

## 1. Read these first

| File | Why |
|---|---|
| `docs/handoff/ETA-MONITORING-SURFACE-PRD-24-AUG-2026-v1.2.md` | The spec. §3.2, §3.3, §3.7, §3.8, §3.9, §4 and the decisions table. |
| `docs/handoff/ETA-MONITORING-SURFACE-MOCKUP-24-AUG-2026.html` | Approved by V. Section 1 shows the level bars and the size vital as they should look. |
| `docs/handoff/ETA-PILOT-BACKLOG-24-AUG-2026.md` | P1, P2 and P6 are fixed by this build. Read what was actually observed. |
| the kiosk room page and its recorder | Where the heartbeat and the meter live. |
| `lib/bench-bus-constants.ts` | Cadences and windows. |
| `lib/admin/rooms-live.ts`, `lib/mcp/tools/bench.ts` | Build 1 moved the shared room facts here. Extend, do not fork. |
| the window writer that sets `bench_window.source_mic` | §2.4 is entirely about this decision. |
| `db/migrations/0065_room_processing_switches.sql` | The pattern for an additive migration, **including its grants**. |

---

## 2. What to build — five items

### 2.1 The page reports itself whenever it is open (D38, §3.7, §3.8)

**Observed 24 August.** Both clinic rooms were ended from the operator screen at 16:16 and stopped
reporting themselves within seconds. V had to walk downstairs and reload one; the other was still
unreachable hours later. The Mini at home, ended by the same command, kept reporting itself for
fifty minutes and could be restarted from the desk throughout.

Stopping a room is what removes the ability to start it. That makes the remote control one-way,
which is worse than having none, because it looks safe.

Build:
- The room page reports itself **whenever it is open**, whatever the session is doing.
- Idle cadence **every 3 seconds**. While recording, the existing cadence is unchanged.
- The **10-second freshness window is unchanged** everywhere.

**Do not assume you know why the clinic rooms went quiet.** Three candidates were never tested: the
machine sleeping once recording releases its wake lock, the page being closed by a person, and the
poll living inside something that unmounts when recording stops. Fix the third if that is what you
find, and **say in your report which one it actually was.** If the page had been closed or the
machine asleep, this change cannot help and V needs to know that plainly, because the remedy is
then in the room, not in the code.

### 2.2 Level bars (§4, D32)

The level is already measured once a second to feed the silence check, and thrown away one second
later. The channel to the server, the row it writes and the operator page's read of it all exist
and run in production. One number has to ride the channel that is already there.

Build:
- The room page sends **the highest and the average level since its last report**, not the raw
  instantaneous reading. An eleven-millisecond sample reads zero between two words.
- One column per value on the room-listener row. **Grants belong in the migration** — on this
  platform the migration runner is the only owner-privileged path.
- A bar on the room card per microphone **that actually exists on that rig** (D32). Most rooms have
  one. A room with one microphone shows one bar and says nothing at all about a spare: no empty
  lane, no grey placeholder, no amber vital. A second device, if genuinely present, gets a second
  bar.
- Add a meter to the spare where one exists. Today only the main microphone is measured, which is
  why nobody noticed a spare recording nothing for weeks.

**The added field must never be able to make the poll fail.** That poll is the operator command bus
and it fails open for the doctor by design. Additive, ignored by an older page, absent from an
older server, and no new way for it to throw.

### 2.3 A microphone judged by size, and one that comes back (§3.2, D36, D37)

Two faults with one symptom, and they cost four hours of Cardiology's transcription yesterday.

The watchdog compares two moments against the wall clock rather than counting samples, and each
reading is about eleven milliseconds — shorter than a pause between words. And **nothing ever
clears it**: there is no restored event, so a room reads as being on its spare for the rest of the
day.

Build:
- Emit **microphone restored** when a following piece from that microphone arrives at a healthy
  size. The event has a name and a counter already; nothing writes it.
- The watchdog requires **consecutive evidence**, not elapsed time, and resets its clock whenever a
  sample is skipped rather than carrying a stale one across the gap.
- A **size vital** beside the freshness vital, judged against **a baseline learned from that room's
  own recent pieces on that same microphone** — a rule that works on a one-microphone rig, which is
  the normal case. Where a second device genuinely exists, the ratio between them is a useful extra
  signal, never the primary one.
- **D36: a piece is only called faulty when the level meter heard sound during it.** A quiet room
  making small pieces is quiet, not broken. This is the only version that cannot cry wolf on a slow
  afternoon, and it is why the meter and the size rule ship together.
- Exempt the last piece of a session. A flush piece is legitimately 27 KB.

Measured sizes per five minutes, for calibration: **4.83 MB** on the Home Office rig, **8.2 MB** on
both clinic rigs, and **70 KB** for the Home Office spare — a ratio of 68 to 1. An absolute floor
is wrong on at least one rig in each direction.

Freshness stays. Size is added beside it, not instead of it.

### 2.4 The binding rule (§3.9, D33, D37)

**The worst thing found on 24 August.** Cardiology's false "main microphone lost" fired at 12:25.
From that moment the window writer bound **every remaining window of the day to the spare
microphone** — sixteen of twenty — and never switched back, because nothing clears that flag. The
main microphone recorded perfectly throughout. Cardiology's spare happened to be healthy, so the
audio is real. On a rig with no spare, or one writing near-silence, the same fault would have handed
four hours of consultation to an empty microphone and returned nothing, with no error anywhere.

Build:
1. **Every window binds to the main microphone by default.**
2. A window may bind to a spare **only when the main is proven dead and the spare is proven
   healthy** — proven by piece size and continuity, never by a flag.
3. **D37 defines dead**: the device is reported gone, **or** two consecutive full-length pieces come
   back tiny while the meter heard sound. **The silence watchdog is not an input to this decision.**
4. **A room with no second device has no spare lane at all.** Do not create one, do not write
   near-empty pieces into one, and do not show a spare vital. A near-empty spare piece is worse than
   no piece, because it looks like a working failsafe.
5. The absence of a spare is **not a fault** and never raises an alarm or an amber vital.

Re-binding the sixteen windows already bound wrongly is **Build 3**. Do not touch them here.

### 2.5 A session's end time is the end of its audio (§3.3, backlog P1)

`bs_f46u4jxw` on OPD 5 has a stored end more than ten minutes after its last piece. Half this class
was fixed on 23 August — the room page is now told when its session was closed underneath it — but
nothing repairs an end time that does not match the tape.

Build:
- On end, set the end time **from the last verified piece**, not from a clock reading or a sweep.
- Same rule on the reload and resume paths.
- Repair the rows already wrong, including the stale one on `bs_jmh9jxmx` left by an earlier version
  of the disagreement alarm.

**Check first** whether `bs_f46u4jxw` started before the two related fixes went live. If it did, this
may already be fixed and that row is merely old. Say which in your report.

---

## 3. Do not touch

- Anything Build 1 changed, unless this build's items require it. If you must, say so.
- The drain, and the re-binding of existing windows. Build 3.
- The six existing room states, plus `finished`, their order and their copy.
- The end-time alarm's discriminator. It compares **capture** times, not arrival times, because the
  first version fired on every ordinary end of day.
- `package.json` dependencies. Deploy config. Auth guards.
- The vocabulary. The lanes are **Tape**, **Transcript**, **Visits**. The page never says drain,
  fuse, subject, window, cue, or the name of any table.

---

## 4. Traps that have already cost this project

**On iPhone browsers a recorder and an audio analyser cannot share one microphone track.** That rule
took two wrong diagnoses to establish. The room Macs are not affected, but do not copy this pattern
into the phone app, and do not remove the guard that exists.

**Tailwind silently drops undefined palette shades — three times now.** The last made a switch that
was on render white, which looks off, on the control panel. Every colour you add must be a defined
shade, and **acceptance requires a screenshot**.

**Four alarms, four false.** The end-time alarm on every ordinary end of day; the doctor clock on
every room after thirty minutes; main-microphone-lost on two working microphones; kiosk-dropped on
every deliberate close. **Check every new rule against an ordinary day before you ship it.** If it
fires on a healthy room doing a normal thing, the rule is wrong, not the room.

---

## 5. Where this gets tested

**Every clinic room is currently unreachable and will be rebuilt by hand at the hospital later. So
all development and all testing happens on Home Office.** That is not a limitation for this build —
Home Office has **one microphone and no spare**, which is the normal case (D32) and the one most
likely to be got wrong.

- **The archive always wins.** If a change here costs a single piece of audio in testing, it does
  not ship.
- **Do not deploy during clinic hours** as a standing rule, even though no clinic room is live right
  now.
- Do not build anything that assumes a second microphone exists, and do not test only on a rig that
  has one.

---

## 6. Schema honesty

**Verified against production**: `bench_window(id, session_id, start_ms, end_ms, source_mic, state,
clip_r2_key, room_day_id, grid_aligned)` · `stt_subject_job(subject_type, subject_id, tier, state,
attempts, last_error)` · `transcription_run(subject_type, subject_id, engine, stt_engine_id,
detected_language, latency_ms, metrics_json, transcript_original)` · `bench_session(id, room_id)` ·
`room(id, slug, name, disabled_at, transcript_enabled, visits_enabled)`.
`bench_window.state` values seen: `open`, `closed`, `transcribed`. `subject_type`: `bench_window`.
`tier`: `asr`.

Everything else is inferred. For every inferred query: **fail safe** — an error degrades to empty or
unknown, never a 500, never a wrong number, and a vital that cannot be computed reads *unknown*,
never *false*. **List every inferred SQL string verbatim in your report**, and every column you add.
I validate them against the live database before anyone relies on them.

The migration for §2.2 must be **additive, idempotent, and carry its grants**.

---

## 7. Gate before you push

1. `tsc` clean for every file you touched
2. every existing test green, including the banned-phrases and palette tests
3. full production build green
4. new tests: the binding rule under a false silence flag; restored fired on a healthy piece; the
   size vital silent when the meter heard nothing; a one-microphone rig showing one bar and no spare
   vital; end time taken from the last verified piece
5. a screenshot of a room card showing the bars

**And one acceptance that only a running room can give.** On Home Office: record for at least twenty
minutes, then compare piece count, piece sizes and total gap against yesterday's control session
`bs_pte4yy9s` — 5 pieces, 23,183,966 bytes, **13 ms of gap across the whole session**. If this build
costs gap or pieces, it does not ship. Then stop the room from the operator screen and confirm it is
**still reporting itself and still startable from the desk.** That is the whole point of §2.1.

---

## 8. Report back with

- the commit sha
- gate results item by item, including the Home Office comparison with its numbers
- **which of the three candidate causes actually explains the clinic rooms going quiet** — or that
  you could not tell from the code, which is an acceptable answer
- every inferred SQL string, verbatim, and every column added
- the migration, and confirmation it is additive, idempotent and carries grants
- the screenshot
- anything you flagged rather than decided
- explicit confirmation that you touched nothing in §3
