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
| **B1** | Same closed window, drained twice. Transcript **OFF** → `step: "flag_off"`, refused at the switch. Transcript **ON** → `step: "no_room_day"` — it went **past** the switch and failed later for an unrelated reason. The switch is the gate and it opens; see the caveat below. |
| **B2** | `consult_mark` cue posted to OPD Test with Visits **OFF** → cue accepted, **0 visit rows**. Same cue with Visits **ON** → **2 visit rows** (`vis_c62tucgv`, `vis_8rdq2xmv`, both `opened_by_kind: mark`). The fuse ran only when the switch was on. |
| **B3** | Above. |
| **B4** | Turning a switch off stops the *next* unit of work: the guard is re-checked on entry to `drainRoomWindow` and to `runLiveFuse`, so nothing in flight is interrupted. Observed as the `flag_off` refusal at the queue head, not as a cancellation. |
| **B5** | One `audit_log` row per room per lane. One Stop-all produced **six** `room processing off` rows across three rooms, visible on the admin dashboard's Recent activity. |

**B1's caveat, stated plainly.** The only closed window available on a room I was allowed to use
belonged to `bs_5wytcjze`, a synthetic API probe session with 4 KB placeholder chunks and no
`room_day`. So the drain got past the switch and stopped at `no_room_day`. **The full
transcribe-and-write half of B1 was not run end to end** — the switch behaviour either side of it
was, which is what the row exists to test, but somebody should watch one real window drain before
Monday.

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

- **Desktop width was not captured for U1/U8.** The browser tooling here cannot reach the
  viewport: `resize_window` reports success and `window.innerWidth` stays where it is, and a root
  `zoom` does not move `documentElement.clientWidth`. Everything attached is a genuine 820 px
  iPad-portrait render. What can be said about desktop without a screenshot: at 820 px the grid is
  already two-up, desktop adds a third column, and a desktop card column measures ~368 px — 
  *narrower* than the ~380 px cards these screenshots show. The lanes are being exercised at
  essentially desktop card width already. That is an argument, not a picture.
- **B1's drain half was not run end to end** — see above.
- **The backup microphone is unchanged and still records near-silence.** Untouched by request.

## Follow-ups

1. **Watch one real window drain** with Transcript on, before Monday.
2. **The header pill still shows the six-state room word**, not the mockup's "Transcript behind".
   Deliberate, to keep U8 true. If V wants the mockup's pill, it is a small, separate change.
3. **`scribe_diff_room` does not report the two switches.** The MCP door and the screen now know
   different things about a room. Out of this build's scope; worth closing.
