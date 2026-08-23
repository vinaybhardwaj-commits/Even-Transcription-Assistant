# Room processing controls — build report, 23 August 2026

**Production `a04af17`. Migrations through 0065. Every room off.**

Built to `ETA-ROOM-CONTROLS-PRD-23-AUG-2026-v1.0.md` against the approved mockup
`ETA-ROOM-CONTROLS-MOCKUP-23-AUG-2026.html`.

---

## What moved

Two switches came out of Vercel and onto the room. `ROOM_STT_DRAIN_ENABLED` and
`FUSE_LIVE_ENABLED` were environment variables holding a comma-separated list of room ids, and
Vercel bakes environment variables into a build — so turning processing off during a clinic
required a redeploy. The only instant switch was `room.disabled_at`, which stops the room
entirely including its recording. A hammer, not a dial.

`room.disabled_at` was also the pattern to copy, and this copies it.

---

## Acceptance

### The three read first

**B3 — a change takes effect within the stated window and needs NO deploy.**

Measured against a **different serverless route** (`GET /api/admin/bench/drain`, which reads the
switch in its own process), and that route's cache was deliberately **warmed with the old value
first**, so this is the worst case rather than a lucky cold read.

| | write | visible to the other route | deploy |
|---|---|---|---|
| turn Transcript ON | 217 ms | **2 073 ms** | none |
| turn Transcript OFF | — | **1 294 ms** | none |
| turn Transcript ON | — | **2 274 ms** | none |
| turn Transcript OFF | — | **2 274 ms** | none |

`ROOM_SWITCH_CACHE_MS = 5000`, so every one is inside the window. **sha `2a12cee` before and
after every flip — no build, no deploy.** For comparison, the same change as an environment
variable was a full Vercel build: on this repo today those ran 40–60 s of build plus queue,
observed at about **3 minutes** door to door.

**S2 — "Stop all processing" leaves every recording running.**

OPD Test recording, session `bs_5hrjrttd`. Three rooms had processing on.

```
before  Tape: "Recording · 6m · 14 pieces"   recording: true
        (pressed Stop all processing — "Processing stopped in 3 rooms.
         Every recording is still running.")
after   Tape: "Recording · 10m · 15 pieces"  recording: true
        transcript_enabled false   visits_enabled false
```

**A chunk landed after processing was stopped** — 14 pieces to 15 — and the kiosk went on to
"chunk 4 in progress" before I ended the day by hand. The tape never paused. The stop-all
statement names no `bench_session`, no `bench_chunk`, no `bench_command` and not `disabled_at`;
a test asserts that.

**U7 — a failed switch write returns the switch to its true position and says so.**

Forced by replacing `window.fetch` in the browser so the PATCH returned 503, then clicking the
Transcript switch on OPD Test. The switch went back to OFF, the lane still read "Off", and the
card said, in red:

> Transcript could not be changed — it is still off. forced failure for U7

The server was then read independently: `transcript_enabled: false`. Screen and row agreed.

### Migration and reads

| # | Result |
|---|---|
| **M1** | All seven rooms read `transcript_enabled = false`, `visits_enabled = false` after 0065 — the effective state before it. No behaviour changed. |
| **M2** | No file anywhere reads either variable from `process.env` (`git grep -E "process\.env[.[][\"']?(ROOM_STT_DRAIN_ENABLED\|FUSE_LIVE_ENABLED)"` → nothing). Both flag modules are **deleted**. Remaining textual hits are the migration's provenance comment, `lib/room-switches.ts`'s "was X" doc lines, and test assertions — no code path. |
| **M3** | Eight call sites, all reading the room: `lib/stt/room-drain.ts:252,495`, `lib/bench-window.ts:344`, `app/api/brain/cues/route.ts:271,373`, `app/api/admin/bench/drain/route.ts:70`, `lib/brain/fuse/live.ts:155,169`. A test counts them per file and fails on a ninth. |
| **M4** | `lib/room-switches.ts:43 — export const ROOM_SWITCH_CACHE_MS = 5_000;` One constant, one place. |
| **M5** | `brain_svc` SELECT on the new columns: works. `brain_svc` UPDATE: `ERROR: permission denied for table room`. Both proven. |

### Behaviour

| # | Result |
|---|---|
| **B1** | **CLOSED END TO END — see §B1 below.** Real window, real nine-hour tape, real room-day: `ok: true`, `step: "ok"`, 96.5 s, 514 segments, 515 turn cues written, window `transcribed`. Refusal half also proven: with Transcript OFF the same drain returns `step: "flag_off"`. |
| **B2** | `consult_mark` cue posted to OPD Test with Visits **OFF** → cue accepted, **0 visit rows**. Same cue with Visits **ON** → **2 visit rows** (`vis_c62tucgv`, `vis_8rdq2xmv`, both `opened_by_kind: mark`). The fuse ran only when the switch was on. |
| **B3** | Above. |
| **B4** | Turning a switch off stops the *next* unit of work: the guard is re-checked on entry to `drainRoomWindow` and to `runLiveFuse`, so nothing in flight is interrupted. Observed as the `flag_off` refusal at the queue head, not as a cancellation. |
| **B5** | One `audit_log` row per room per lane. One Stop-all produced **six** `room processing off` rows across three rooms, visible on the admin dashboard's Recent activity. |

### B1, closed end to end (added after the first report)

Run on `bs_g3dwud4p` — the nine-hour Home Office tape, 216 verified chunk rows — with the
Transcript switch turned on **by clicking it on the card**, and turned off again afterwards.

**A correction to the premise first.** That session does not have "34 closed windows and a real
room_day". It has 36 windows: 2 open, 9 already transcribed, **25 closed**. And Home Office had
exactly **one** room-day, `2026-08-22`. Every one of the 9 already-drained windows sits on it;
every one of the 25 remaining ones falls on **23 August IST**, because the tape ran to 06:28 IST.
That day had never been created — no cue was ever posted to Home Office on the 23rd, because the
switch was off. That is why all 25 returned `no_room_day`, and it is a real consequence of the
flag having been off, not a fault in the drain.

So the missing precondition was supplied, deliberately and in the open:

1. One cue of a **named probe type**, `b1_room_day_probe`, posted to Home Office. This creates
   today's room-day and nothing else. (Precedent in this same data: `k2_concurrency_probe`,
   `k5_flag_off_probe`.) → `rd_3g4k2jtc`, ist_date `2026-08-23`.
2. `POST /api/admin/bench/windows { session_id }` — the re-evaluation door, whose own header
   names this exact session — to backfill `room_day_id`. 8.3 s. **`inserted: 0, closed: 0,
   still_open: 2, unchanged: 34`**: it filled a NULL and changed nothing else, exactly as
   `lib/bench-window.ts` says it will ("filling a NULL is not a change of mind").

Then the drain, on `bw_g3dwud4p_1787423400000_primary` (22 Aug 18:30–18:45 UTC = 00:00–00:15 IST
on the 23rd — the window immediately after the last one drained on Friday):

```
ok: true          step: "ok"          wall: 96 509 ms  (96.5 s for 900 s of audio)

joined       clips/bs_g3dwud4p/20260822T183000Z-20260822T184500Z-primary.webm
probed       30 s probe → "english"          full_language "english"
sent         language_sent "en-IN"
Sarvam       21 236 ms over 900 audio-seconds        engine "sarvam"
             514 segments, activity "speech"
run stored   tr_s7kmpvs5u1
turns        turns_written 515   turns_deleted 0   turns_failed 0
window       window_recorded true → state "transcribed"
```

Verified independently against the brain, not taken from the response:

```
cue rows on rd_3g4k2jtc   stt_turn 514 · stt_window 1 · b1_room_day_probe 1
window marker             complete: true, segment_count 514, source_used "primary",
                          language "english", session bs_g3dwud4p
turn span                 18:30:00.00Z → 18:44:58.84Z  (the window's own 15 minutes, exactly)
window states             open 2 · transcribed 10 · closed 24   (was 9 transcribed, 25 closed)
```

515 turns written against 514 segments is the 514 turns plus the one completeness marker — the
window-as-unit write from K3, behaving as designed.

**The refusal half is unchanged and still holds**: with Transcript OFF, the same drain endpoint
against the same window returns `step: "flag_off"` in 464 ms, before any join, probe or paid call.

**The switch was returned to OFF**, by clicking it on the card. Home Office reads
`transcript_enabled: false`, `visits_enabled: false`.

### Interface

| # | Result |
|---|---|
| **U1** | Rendered at **820 px (iPad portrait)** — screenshots attached. Three lanes per card with the mockup's states. **Desktop width not captured — see the limitation below.** |
| **U2** | Turning Visits **on** showed the confirmation with the mockup's copy verbatim. Turning Visits **off**, and Transcript either way, took effect with no dialog. |
| **U3** | Visual switch 52 × 30 as drawn, inside a **44 × 44** tap target (`h-11 min-w-11`). `role="switch"`, `aria-checked` bound to state. |
| **U4** | OPD 7 with both switches **on** and nothing to do rendered **grey**, "On, nothing to do" — not green. Visible in the attached screenshots beside OPD Test's amber Transcript. |
| **U5** | Attention list carried, at the same moment, red `act now` "OPD Test — chunks are still arriving…" and amber `watch` "OPD Test — transcript behind — **the audio is safe**… Nothing is lost: the audio is saved and can be processed later." The two emergencies read differently. |
| **U6** | Day summary rendered from `DaySummary`: audio recorded, turned into words, gave up, visits built. Minutes only. No currency anywhere, and `DaySummary` has no field that could carry one — asserted by test. |
| **U7** | Above. |
| **U8** | The only changes to the card are the lane block and the two switches. The six-state room pill, mic vitals, doctor clock, marks and the orphan repair are untouched — deliberately, since changing the header pill to "Transcript behind" as the mockup shows would have altered shipped, tested behaviour. The lane lamp and the attention row carry that message instead. |

### Stop all / nothing else moved

| # | Result |
|---|---|
| **S1** | One statement, one transaction, both columns false for every room, one audit row per room per lane. Asserted by test and observed as six rows. |
| **S2** | Above. |
| **S3** | On the card: "Turns Transcript and Visits off in every room. **Recording carries on and no audio is lost.** Use this first if something looks wrong." |
| **N1** | `POST /api/bench/chunks`, 20 sequential replays of one real verified chunk. Before this build: min 287 / **median 300** / max 343 ms. After: min 282 / **median 297** / max 484 (one outlier). Indistinguishable — the switch read sits in the existing `after()` hook, not the request path. |
| **N2** | The kiosk rendered, recorded for 16 minutes across four chunks, survived a Stop-all untouched, and ended the day with "4 chunks archived + 4 backup (16 MB) — all uploads verified." |
| **N3** | Below. |

---

## Final state

**sha `a04af17`, migrations through 0065.**

| room | id | `transcript_enabled` | `visits_enabled` |
|---|---|---|---|
| ZZ Verification Probe (room disabled) | `room_bn49z3zd` | false | false |
| OPD Test | `room_xf5vcjpt` | false | false |
| OPD 7 | `room_qyzghzaf` | false | false |
| Cardiology OPD | `room_bh6jtq4t` | false | false |
| SCRATCH · OPD 7 | `room_scratch_qyzghzaf` | false | false |
| SCRATCH · Cardiology OPD | `room_scratch_bh6jtq4t` | false | false |
| Home Office | `room_2qe955hy` | false | false |

Nothing is on. V decides when.

---

## The bug this build shipped and then caught

The **Stop all processing button had no background colour at all** for its first deploy.

`bg-danger-600` does not exist in this palette (`danger` has 50/100/200/500/700), and Tailwind
drops unknown classes silently. White text on a pink card: the most important control on the
screen, nearly invisible. `bg-success-600` was the same — the switch track and the "working" lamp
rendered white, so a switch that was ON looked OFF. `border-danger-300` too, including on the
room-screen panel shipped earlier today.

`tailwind.config.ts` already carries a comment about precisely this failure — `border-warning-200
bg-warning-50` generated nothing for the room card's worst-condition signal and had been
invisible since the day it shipped. The comment was not enough. There is now a test that reads
the palette out of the config and fails on any shade the palette does not define.

It was caught by looking at a screenshot, not by any test I had written. Worth remembering when
the next screen goes out.

---

## Limitations, said plainly

- **Desktop width was captured on the second pass** (1440 px), so U1/U8 now have both widths —
  the earlier report's limitation is lifted. The switch measured **52 × 44** in the live DOM,
  confirming U3 by measurement rather than by class name.
- **The backup microphone is unchanged and still records near-silence.** Untouched by request.

## Follow-ups

1. **24 closed windows on `bs_g3dwud4p` remain undrained**, all on 23 Aug IST and now bound to
   `rd_3g4k2jtc`, so they would drain if asked. Left alone deliberately — each is a paid Sarvam
   call and V decides.
2. **The header pill still shows the six-state room word**, not the mockup's "Transcript behind".
   Deliberate, to keep U8 true. If V wants the mockup's pill, it is a small, separate change.
3. **`scribe_diff_room` does not report the two switches.** The MCP door and the screen now know
   different things about a room. Out of this build's scope; worth closing.
