# ETA Build 3 — Recovery: run the waiting audio, repair the bindings, close the remote gaps

**Kickoff for Claude Code. Paste this whole file.**

Spec: `docs/handoff/ETA-MONITORING-SURFACE-PRD-24-AUG-2026-v1.2.md`. Read §3.5, §3.6, §3.10, §11, §12, §13 and §17 first, and decisions D28, D32, D33, D33a, D34, D36, D37.

Production is `05aaf2e`. Migrations run through `0067`. The next migration number is `0068`.

All design decisions are settled: 39 of them, D1 to D38 plus D33a, ratified by V. Do not reopen any. If something is genuinely not covered, flag it in your report instead of deciding it silently.

**One check before you start.** The repo copies of the PRD and the backlog were stale until this commit. They were re-synced from the master copies together with this kickoff. Confirm that the PRD in `docs/handoff/` contains decision **D33a** and that the backlog contains **P7 and P8**. If either is missing, stop and say so.

---

## 0. What kind of build this is

Builds 1 and 2 made the page tell the truth. Build 3 is recovery. It turns two days of verified tape into words, and it closes the gaps that stranded that tape. Two rules govern everything here.

- **Every transcription is a paid call.** Nothing in this build fires paid calls without an operator asking. Every run reports what it did and what it cost, per window.
- **The archive always wins.** If a change could cost one piece of clinical audio, it does not ship. A re-bind never deletes or rewrites a piece. It changes which piece a window points at, and it records why.

---

## 1. Read these first

| File | Why |
|---|---|
| `docs/handoff/ETA-MONITORING-SURFACE-PRD-24-AUG-2026-v1.2.md` | The spec. §3.10 is item 2.1 verbatim. D32–D37 govern items 2.2 and 2.4. |
| `docs/handoff/ETA-PILOT-BACKLOG-24-AUG-2026.md` | P7 and P8 are items 2.3 and 2.4. Read what was actually observed. |
| `docs/handoff/ETA-BUILD-2-KICKOFF-25-AUG-2026.md` | What Build 2 shipped: the binding rule, the level meters, the heartbeat, the two-way remote stop. |
| `lib/admin/rooms-live.ts` | Build 1 moved the shared room facts here. Extend, do not fork. |
| `lib/mcp/tools/bench.ts` | The operator door. Item 2.5 lives here. |

---

## 2. What to build — six items

### 2.1 A control to run a room's waiting audio (PRD §3.10, D28)

**Observed.** Turning Transcript on queues nothing. All seventeen of Cardiology's finished windows have no job row. The card says "0 done, 17 waiting" and no control anywhere would run them. One window was recovered by hand through an admin address: 5,468 characters, Sarvam, 23 seconds.

**Build:**

1. A control on the room card: **run this room's waiting audio**. It shows how many windows are waiting and reminds the operator that each one is a paid call.
2. It processes finished windows that have no job, oldest first, in batches small enough to finish inside one request.
3. It reports per window: engine, characters out, seconds taken, cost.
4. Copy fix: a lane with finished windows and no worker says **waiting for someone to run it**. Never "waiting to be turned into words". Never offer to stop something that is not running.

### 2.2 Re-bind and re-run the sixteen wrongly bound windows (D34, D33, D33a)

**Observed.** Cardiology's false microphone alarm at 12:25 on 24 August caused the window writer to bind sixteen of twenty windows to the spare microphone. Nothing ever cleared it. The main microphone was never dead. The alarm was false.

**Check first.** Verify the count by query before you change anything. Report the window ids.

**Build:**

1. Re-bind each affected window to the main microphone, per D34. Follow the precedent of migration `0067`: a data-repair migration, additive and idempotent. For each window record the old binding, the new binding, and the reason.
2. Re-run with the caution D28 sets for paid batches: transcribe **four first**. The rest run only after V reads the four and the output reads well. Your report carries the four outputs and stops there. Do not run the remaining twelve in this build's automated flow.
3. Control: the window recovered by hand on 24 August (5,468 characters, Sarvam, 23 seconds). Re-running that window must produce substantially the same text. If it does not, stop and report.

### 2.3 A day record creatable from the desk (backlog P7)

**Observed.** Session `bs_fudv3gqt` was started from the desk on 25 August and recorded 55 minutes of verified tape. None of it could be processed until V pressed Mark consult in the room, 54 minutes in. A recording creates no day record. Only a cue does. The desk has a start button and nothing that creates the day.

**Build:**

1. A control on the room card that creates today's day record. It does exactly what Mark consult does, through the same path. The operator connector already proves this works from the desk (`scribe_mark_consult`, used on Cardiology on 24 August).
2. The card already alarms when a room records with no day record. The new control is the action that resolves that alarm. Put them next to each other.
3. Out of scope, named so it is not lost: the drain creating its own day record for the window's own IST date (PRD §11). Do not build it here.

### 2.4 A spare exists only when a second device exists (backlog P8, D32)

**Observed.** The Home Office Mini has one microphone and no spare. The page reports `spare_exists: true`, draws a spare lane, and the session wrote twelve backup pieces of about 70,590 bytes each. That is 0.235 bytes per millisecond against the main's 16.1. A phantom device is being captured and writes near-silence at a steady rate.

**Check first.** On Home Office, identify what the phantom captured device actually is. Report it.

**Build:**

1. Decide `spare_exists` from device selection: a distinct second device chosen in the kiosk. Never from the arrival of a backup piece.
2. If no distinct second device is chosen: do not open a backup lane, do not write backup pieces, do not render a spare vital.
3. A room with one microphone is a normal room, not a degraded one (D32). No alarm and no warning for having one.
4. In your report, state whether the long-standing 68-to-1 reading was a broken spare or no spare at all.

### 2.5 The operator door reports the level numbers (PRD §3.5, §3.6)

**Observed.** Build 2 put level bars on the screen. The door does not report them. The screen and the door know different things again. That is the exact divergence Build 1 was meant to end.

**Build:**

1. Extend the shared room-facts source so the door reports what the screen renders: per-microphone level, the room's learned baseline, and the D36/D37 judgment inputs.
2. Extend `lib/admin/rooms-live.ts` and `lib/mcp/tools/bench.ts`. Do not fork. One shared source for every room fact, used by both.

### 2.6 Backlog honesty (small, mostly no code)

The backlog file still marks P1–P6 open. The Build 2 kickoff intended P1, P2 and P6 fixed. The carryover records P1 and part of P6 as actually fixed. Do not inherit the ambiguity: check the code and a real session, then update the status line of each of P1–P8 to what is true. In particular, check the sessions-list badge P5 ties to P2 ("on backup mic · 40 chunks") against a session that used the backup. Report whether that badge is now honest.

---

## 3. Do not touch

- The six existing room-pill states plus *finished for today* keep their meanings, their order and their copy.
- The wording rules on the doctor clock. The abandoned-session repair. The marks row. The end-time alarm's discriminator.
- The vocabulary: the lanes are Tape, Transcript and Visits. The page never says drain, fuse, subject, or the name of a table.
- Green means working. On-with-nothing-to-do is grey.
- Nothing the clinician sees.
- No new alarm ships without a check against an ordinary day (PRD §13). Every alarm this page has raised so far fired on healthy behavior.
- Never delete or rewrite an audio piece. Re-binding changes pointers only.
- No automatic paid calls. Every batch starts with an operator action.

---

## 4. Traps that have already cost this project

**Alarms that fire on ordinary days.** Four of four so far. Each measured something real and drew a conclusion nobody could act on, and the one true alarm sat unread underneath two false ones. If a new alarm fires on a healthy day, the alarm is wrong.

**Colors that silently do not exist.** Three controls have shipped with a color the palette does not define, rendering as nothing. Every new control uses a defined shade, and acceptance requires a screenshot.

**The listener table lies after a kiosk dies without a goodbye.** On 25 August the door showed OPD 5 and OPD 7 as recording. Both sessions had in fact ended cleanly the day before (`bs_8294hb7f`, `bs_sanc6g5f`). Never trust a listener row for session state. Read the session.

**The health endpoint serves a cached sha.** Cache-bust when you verify a deploy.

**One failed read silences a different alarm.** A failed query turns the day-record answer unknown in every room and silences the no-day alarm. Be careful what queries you add to the shared source.

**Depth one.** The processing machine is shared with the live clinical path and with speech recognition. Queueing several rooms looks like a hang unless waiting is shown separately from working.

---

## 5. Where this gets tested

Home Office is the only live kiosk. All clinic rooms are offline until they are rebuilt by hand. Field acceptance runs on Home Office, and on the Cardiology tape already in the archive. Re-runs need no kiosk.

Non-negotiables: paid calls run in small batches with per-window cost reporting, and nothing writes a live room's day record except through the Mark-consult path.

---

## 6. Schema honesty

Treat as verified only the columns you check against production yourself, plus what migrations `0066` and `0067` created. Everything else is inferred: list every inferred SQL string verbatim in your report. Any migration is `0068` or later, additive, idempotent, and carries its own grants. On Vercel the migration runner is the only owner-privileged path. Migrations are applied through the run-migrations route, as before.

---

## 7. Gate before you push

1. `tsc` clean.
2. Tests pass. Name the new ones.
3. Build passes.
4. Screenshot: the two new room-card controls, and a one-microphone room rendering no spare lane.
5. Field acceptance, item by item:
   - a. From the desk only: start Home Office, create its day record, stop it. Nobody touches the Mini.
   - b. Run-waiting-audio on a room with waiting windows. Per-window report with cost.
   - c. The control window from 2.2 re-runs to substantially the same 5,468-character Sarvam text.
   - d. A Home Office session shows no spare lane and writes no backup pieces.
   - e. The door and the screen report the same level numbers for the same room at the same moment.

---

## 8. Report back with

- Gate results item by item, with the screenshots.
- The sixteen window ids, with old binding, new binding, and recorded reason for each.
- The four first re-run outputs, for V to read before the remaining twelve run.
- What the phantom device on Home Office actually is.
- Whether the 68-to-1 reading was a broken spare or no spare at all.
- The backlog status pass, P1–P8.
- Every inferred SQL string, verbatim.
- Confirmation that nothing in §3 was touched.
