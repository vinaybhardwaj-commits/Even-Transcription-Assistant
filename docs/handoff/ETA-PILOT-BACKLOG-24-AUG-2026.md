# ETA — Pilot Backlog

Started 24 Aug 2026, during the OPD room pilot. This file collects bugs found by the room-watch task and by manual review. It is not urgent work. It does not block the pilot. Fix these in the next batch of engine or session-lifecycle work.

---

## P1 — Stored session end time does not match the last audio piece

**Found:** 24 Aug 2026, room-watch scheduled task, ~08:07 UTC (13:37 IST)
**Room:** OPD 5 - Dr. Salanki (`room_4ggnkg5x`)
**Session:** `bs_f46u4jxw`

**Symptom:** The room-watch tool flags `flags.ended_at_lies: true` for this room, with `ended_at_lies_sessions: ["bs_f46u4jxw"]`. This means the session row has a stored `ended_at` time that is more than 10 minutes later than the time its last audio piece actually arrived.

**Impact:**
- Any report that computes session length from `ended_at` gets the wrong number for this session.
- Day reports and audits that use session duration can be off for this room and date.
- The live recording in this room today is not affected. The tape itself has no gaps and no stall.

**Likely cause:** This matches the known pattern from the day-rollover reaper, which can stamp a session as ended at a fixed clock time instead of the time the tape actually stopped. A resume or reload can also leave a stale end time behind. See the carryover note on the day-rollover reaper splitting a live session at IST midnight.

**Fix:** When a session ends, set `ended_at` from the last verified piece, not from a fixed clock time or a reaper sweep. Check the resume/reload path for the same bug.

**Status:** open, not assigned.

---

## P2 — Mic status stays stuck on "backup" after a false silence flag

**Found:** 24 Aug 2026, room-watch scheduled task, ~08:22 UTC (13:52 IST)
**Rooms:** Cardiology OPD (`room_bh6jtq4t`), OPD 5 - Dr. Salanki (`room_4ggnkg5x`)
**Sessions:** `bs_z3gpbh6e` (Cardiology), `bs_8294hb7f` (OPD 5)

**Symptom:** Both rooms show a `mic_primary_lost` event early in the session (Cardiology 06:55, OPD 5 06:35), each tagged `reason: "silence"`. No `mic_primary_restored` event ever fires after that (`primary_restored_count: 0` in both sessions), so the room's live status keeps reading "on backup mic" for the rest of the day even though the primary mic is fine.

**Impact:** Whoever checks the room screen sees a false alarm and may go troubleshoot a working microphone. Read against actual chunk data, both rooms kept recording full-size primary pieces (~8.3–8.4 MB per 5-minute chunk, same size as backup) straight through to the most recent chunk — no real mic failure.

**Likely cause:** The silence watchdog fires a `mic_primary_lost` event off quiet audio measured against the wall clock, but nothing clears the flag once real audio resumes — there is no corresponding "restored" check that looks at actual chunk size/content, only a check for renewed silence.

**Fix:** Either emit a `mic_primary_restored` event once a subsequent primary chunk comes in above a minimum size, or have the room-status computation judge current mic health from the size of the last few primary chunks instead of the stale `primary_lost` flag.

**Status:** open, not assigned.

---

## P6 — The remote control is one-way: stop strands the room

**Found:** 24 Aug 2026, 16:33 IST, after both clinic rooms were ended remotely at 16:16.
**Severity: this is the most serious item in this file.** It is not a display problem.

**Symptom:** an operator can stop a room from the Bench screen but cannot start it again. Starting
needs the room to be listening, and after the remote stop both clinic rooms stopped being heard
from within seconds. V had to walk to the Cardiology OPD Mac and reload the page. OPD 5 was still
unreachable 17 minutes later.

**Measured at 16:33:**

| Room | Page open | Last heard | State |
|---|---|---|---|
| Cardiology OPD | yes, after V reloaded it by hand | 2.5 s ago | ready — startable from the desk |
| OPD 5 · Dr. Salanki | no | 16 m 56 s ago | offline — unreachable |
| Home Office | yes | 0.7 s ago | ready |

**Three rooms out of three. There is no counter-example.** Home Office briefly looked like one —
ended by the same command at 09:24, still listening at 16:33 — until V confirmed he had **reloaded
that window by hand before leaving for the office**. Recorded as his recollection, not a
measurement; part 2 of the fix turns it into evidence at no cost.

So: **ending a session is what stops the page reporting itself.** Stop is the thing that removes
the ability to start.

**Why it matters more than the wrong label.** A control that can be used but not undone from the
same place is a trap. It looks safe, and the cost of pressing it only appears afterwards, in
another building. Today it cost one walk downstairs. In a live clinic it would cost a room's
morning.

**Fix, in three parts:**
1. **The page reports itself whenever it is open**, whatever the session is doing. Idle-and-open
   and dead must stop being indistinguishable.
2. **Prove it on a clinic Mac**, do not assume it. Stop a room remotely, leave the Mac untouched,
   and read the room every minute for thirty minutes. Repeat with the display asleep. Until that
   test exists we do not know which of the three machines today was the exception.
3. **Until it is proven, the stop control states its cost before it is used.** If stopping would
   leave the room unreachable from the desk, say so on the button, not afterwards.

**Operating instruction until this is fixed: do not end a day from the Bench screen.** End it at
the Mac in the room. The remote stop works, and that is the problem — it works once.

**Status:** open, not assigned. Folded into the monitoring surface PRD v1.2 §3.8.

---

## P5 — A room that has finished for the day reads as a fault

**Found:** 24 Aug 2026, 16:25 IST, straight after both clinic rooms were ended on purpose.
**Rooms:** Cardiology OPD (`room_bh6jtq4t`), OPD 5 - Dr. Salanki (`room_4ggnkg5x`)

**Symptom:** Both rooms read **"Kiosk dropped 9m ago — it may come back on its own, wait a
moment"**, in amber, with the advice *"Start is off because the kiosk page stopped responding.
Reopen the room page on the clinic Mac."* Nothing had dropped. Both were ended deliberately at
16:16 through `end_day`, and both ended cleanly — end time matching the tape, every piece verified,
no gaps.

**Measured:** Cardiology's `listener_age_ms` was 558,137 at 16:25 — 9 minutes 18 seconds, exactly
the interval since the day was ended. `page_open: false`, `listener_state: "stale"`.

**Root cause:** the kiosk stops reporting itself when its session ends. The room-state chain then
has nowhere to put a finished room, so it falls through to `dropped` for ten minutes and `offline`
after that. This happens at the end of every clinic day, in every room, and the advice it gives is
to go and reopen a page that is already open and needs nothing done to it.

**Fix:** three parts.
1. Keep the heartbeat running while the room page is open, whether or not a session is recording.
   A room that is open and idle is a different thing from a room whose page has died.
2. Add a state for **finished for today** — the room's last session ended normally today and none
   is running. It ranks after `paused` and `recording`, and before `ready`, `dropped` and
   `offline`. Copy: *"Finished for today · 4h 21m recorded"*, hint *"Press start to record again."*
   Level green or grey, never amber.
3. `dropped` and `offline` then mean only what they say — a page that stopped responding while
   there was still something to do.

**Also on the same screen:** the sessions list badges `bs_8294hb7f` as *"on backup mic · 40
chunks"* for its whole 4h 21m. The session ran on the main microphone throughout; 40 is the number
of pieces the spare wrote before it failed at 15:15. This is P2 showing up in a second place, and
the fix for P2 must cover this badge too.

**Status:** open, not assigned. Folded into the monitoring surface PRD v1.2 §3.7.

---

## P3 — Give Scribe its own Metabase key, in the Vercel project

**Raised:** 24 Aug 2026, deferred by V the same day.

**What:** The Pulse feed (monitoring surface PRD v1.2, D29) reads Metabase database 13, the
Firestore-to-Postgres mirror. Scribe has no Metabase connection today. It needs a base URL and an
API key as environment variables in the Vercel project, using the same variable names CDMSS uses,
so the CDMSS client can be copied without edits.

**Do not copy CDMSS's key.** Create a second API key in Metabase, bound to a group with read
access to database 13 only. One key per system means a leak or a rotation touches one system
instead of two. Before creating it, check what CDMSS's key can actually reach — whatever it can
do, a copy would inherit.

**Not urgent.** Nothing in Scribe reads these variables, so setting them changes nothing until the
Pulse feed is built, and that is the last item in the build order.

**Status:** open, not assigned. Needs V in the Metabase admin screen and in Vercel.

---

## P4 — Rotate `claude@even.in`

**Raised:** 23 Aug 2026 in the carryover. Still owed on 24 Aug. Deferred by V.

**What:** The password for `claude@even.in` appeared in a build log on 23 August. Anyone who can
read that log has it.

**Fix:** Change the password. Check whether anything else was written into the same log.

**Status:** open. Needs V at a keyboard. This is the only item in this file with a clock on it —
the others cost time if left, this one costs more the longer it waits.

---
