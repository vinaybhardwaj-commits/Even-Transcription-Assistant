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

**Status:** FIXED — Build 2 (`05aaf2e`). On end, resume and reload, `ended_at` is now set from the last verified piece (`app/api/bench/sessions/[id]/route.ts`: `ended_at = MAX(c.ended_at) …`), and migration 0067 repaired the rows already wrong, including the stale `bs_jmh9jxmx`. Verified 24 Aug 2026 (Build 3 review). `bs_f46u4jxw` predates the fix and its historical row was among those 0067 corrected.

---

## P2 — Mic status stays stuck on "backup" after a false silence flag

**Found:** 24 Aug 2026, room-watch scheduled task, ~08:22 UTC (13:52 IST)
**Rooms:** Cardiology OPD (`room_bh6jtq4t`), OPD 5 - Dr. Salanki (`room_4ggnkg5x`)
**Sessions:** `bs_z3gpbh6e` (Cardiology), `bs_8294hb7f` (OPD 5)

**Symptom:** Both rooms show a `mic_primary_lost` event early in the session (Cardiology 06:55, OPD 5 06:35), each tagged `reason: "silence"`. No `mic_primary_restored` event ever fires after that (`primary_restored_count: 0` in both sessions), so the room's live status keeps reading "on backup mic" for the rest of the day even though the primary mic is fine.

**Impact:** Whoever checks the room screen sees a false alarm and may go troubleshoot a working microphone. Read against actual chunk data, both rooms kept recording full-size primary pieces (~8.3–8.4 MB per 5-minute chunk, same size as backup) straight through to the most recent chunk — no real mic failure.

**Likely cause:** The silence watchdog fires a `mic_primary_lost` event off quiet audio measured against the wall clock, but nothing clears the flag once real audio resumes — there is no corresponding "restored" check that looks at actual chunk size/content, only a check for renewed silence.

**Fix:** Either emit a `mic_primary_restored` event once a subsequent primary chunk comes in above a minimum size, or have the room-status computation judge current mic health from the size of the last few primary chunks instead of the stale `primary_lost` flag.

**Status:** LARGELY FIXED — Build 2 (`05aaf2e`). Live mic health is now judged from piece size against the room's own baseline (D36/D37), a `mic_primary_restored` event fires when a healthy piece follows a loss, and the window writer no longer trusts the `mic_primary_lost` flag (D33/D37) — a silence trip alone moves nothing. The stale-flag badge this surfaced in ("on backup mic · N chunks") was REMOVED in Build 1 §3.4 and now renders nothing, so it is honest (`mic_status` stays on the wire, unread) — confirmed against `bs_z3gpbh6e`, which carries `primary_lost_count: 1` yet no longer shows any backup badge. Build 3 (`this build`) re-bound the sixteen windows the false 12:25 IST flag had already mis-bound to the spare (0068, D34). Remaining: the historical `mic_primary_lost` event on `bs_z3gpbh6e` is untouched — it is a true record that the watchdog tripped, just not evidence the mic died.

---

## P7 — A room started from the desk records into nothing until somebody walks in

**Found:** 25 Aug 2026, by V, during the Build 2 acceptance run on Home Office.
**Session:** `bs_fudv3gqt`, started remotely 07:44:10, recorded 55 minutes.

**Symptom.** The recording was started from the Bench screen and ran perfectly — twelve pieces, all
verified, 19 ms of gap. But **none of it could be turned into words** until V pressed **Mark
consult** on the room page at 08:38:56, fifty-four minutes in. Recording creates no day record;
only a cue does. Until the cue arrived, every window was stranded.

**Why this is worse than the old version of the problem.** It was always true that a room needs a
mark. What is new is that a room can now be **started** from the desk — so an operator can begin a
recording remotely and has no way, from that same screen, to make its audio processable. The page
has a start button and nothing that creates the day. The tape runs; the day does not exist.

The operator connector *can* post a mark (`scribe_mark_consult`, used on Cardiology on 24 August),
so the capability exists. It is simply absent from the screen a person uses.

**Fix, two parts.**
1. **Short term, Build 3:** a control on the room card that creates today's record — the same thing
   Mark consult does, from the operator side. Anywhere a room can be started remotely, its day must
   be creatable remotely.
2. **Proper, and already owed:** the drain creates its own day record for the window's own IST date
   (carryover §5 item 4). That removes the dependency on anybody pressing anything, and it is the
   only version that survives a midnight rollover.

**Status:** FIXED — Build 3 (`this build`, D39). The day record now opens itself: on a `start_day` ack, and when a chunk verifies for an IST date with no record yet (keyed to the piece's own date), through the same resolve-or-create path Mark consult writes through (`lib/brain/open-day.ts`, wired into `app/api/bench/chunks/route.ts` and the ack route). This subsumes the drain-side fix in part 2 — the window writer still only LOOKS UP a day, and there is no separate drain path. No key stroke and no mark stands between recorded tape and processable tape any more; the no-day alarm stays and can now only fire on a genuine bug.

---

## P8 — A rig with one microphone reports a spare that is not there

**Found:** 25 Aug 2026, during the same run.

**Symptom.** V states the Home Office Mini has **one microphone and no spare**. The page reports
`spare_exists: true`, draws a spare lane and a spare bar, and the session wrote **12 backup pieces
at 70,534–70,590 bytes each** — a consistent 0.235 bytes per millisecond against the main
microphone's 16.1. Earlier the same rig logged `mic_backup_unavailable` at session start.

**Cause.** `spare_exists` is derived from *a backup piece arrived*, not from *a distinct second
device is present*. Something on that Mac is being captured as a phantom second microphone and
writes near-silence at a steady rate.

**Why it matters.** D32 says a room with no second device has no spare lane, and §3.9 rule 3 says a
near-empty spare piece is worse than no piece because it looks like a working failsafe. This rig
proves the rule and breaks it at the same time. It also means the 68-to-1 ratio we have carried for
weeks as "a broken spare microphone" may be **no spare microphone at all**.

**Fix.** Decide a spare exists from the device selection, not from the arrival of a piece. If no
distinct second device is chosen, do not open a backup lane, do not write backup pieces, and do not
render a spare vital.

**Status:** FIXED (server half) — Build 3 (`this build`, D32/0068). `spare_exists` is now decided from an explicitly chosen second device the client reports (`bench_listener.spare_device`), never from the arrival of a backup piece. The browser kiosk does not set it (its capture code is untouched this build), so Home Office and every one-microphone rig now show no spare lane, no spare vital and no spare alarm. The phantom captured device on Home Office was the Mac's own BUILT-IN microphone, auto-selected as backup by `pickDefaultBackupDevice` (the heuristic default) because it is a distinct `audioinput` from the TONOR USB mic — it wrote room ambient at ~70 KB/5 min. So the long-carried 68-to-1 reading was NO SPARE AT ALL, not a broken spare. Client half (reporting a real chosen second device) moves to the native Room Recorder app (PRD R6).

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

**Status:** FIXED (part 1) — Build 2 (`05aaf2e`, D38). The room page now reports itself every 3 s whenever it is open, whatever the session is doing, so idle-and-open is distinguishable from dead and a stopped room stays startable from the desk. Parts 2 and 3 (proving sufficiency on a clinic Mac, and the stop control stating its cost) are open: no clinic Mac is reachable to run the 30-minute proof, and the operating instruction — end a day at the Mac, not from the desk — still stands until it is proven. The stop control already states its cost on the card (§3.8 part 3).

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

**Status:** FIXED — Build 1/Build 2. The seventh state, `finished for today`, ships (D30), grey never amber; the heartbeat keeps running while the page is open (Build 2, D38), so `dropped`/`offline` now mean only a page that stopped responding with something still to do. The "on backup mic · 40 chunks" badge was removed in Build 1 §3.4 (renders nothing rather than the false claim) — see P2.

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
