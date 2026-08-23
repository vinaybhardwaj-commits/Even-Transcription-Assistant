# Ended disagrees — tell the room. Build report, 23 August 2026

**Production `685807e`. Migrations through 0064. Flags OFF for every room.**

Room path only. No reaper change, no flag, no fuse, no drain, no arm A, no diarization.
Not one `bench_chunk` was modified or deleted, and bs_g3dwud4p's `ended_at` was not repaired.

---

## The problem, and the shape of the evidence

Session `bs_g3dwud4p` on Home Office, 22–23 August. The day-rollover reaper stamped `ended_at`
at 19:00:36.677. **The kiosk was never told.** That tab never reloaded — it held the session id
in its own memory — so it carried on writing chunks for another six hours.

Read from production today, untouched:

```
session bs_g3dwud4p   status ended   ended_at 2026-08-22T19:00:36.677Z
                      notes  "auto-ended: day rollover (reaper)"
chunk rows            216   (108 primary + 108 backup)
verified              216   unverified 0
CAPTURED after ended_at   142
  first  idx 37 primary   2026-08-22T19:05:33.890Z
  last   idx 107 backup   2026-08-23T00:55:34.519Z → 00:58:46.775Z
```

**No audio was lost.** What was lost was the truth: a three-hour session row holding nine hours of
audio, and an operator monitor reading NOT RECORDING while the room was still capturing.

K4a fixed the specific cause — the reaper no longer reaps a session that is still receiving
chunks. This fixes the general one: THE ROOM IS NEVER TOLD. A reload was already safe
(`decideResume` rejects an `ended` session); a tab that never reloads was not.

Note the first post-end chunk began **4 minutes 57 seconds** after the reaper's stamp. Under this
build the room is told at that rotation.

---

## What was built

**A1 — the chunk is accepted, always.** A chunk arriving for an ended session is stored in R2 and
written to `bench_chunk` exactly as normal. Nothing in the route branches on session status; the
status read only decides what is said afterwards. Those 142 chunks are the whole argument:
refusing would have converted a bookkeeping fault into six hours of lost recording, which is a
far worse failure than the one being fixed.

**A2 — recorded as an event, once.** One `bench_event` of kind `ended_disagrees` per session,
`brain_status 'none'` (no brain hop is attempted for this row, and `'failed'` is every other
writer's "attempted, not yet succeeded"). Migration 0064 is a PARTIAL unique index on
`(session_id) WHERE kind = 'ended_disagrees'`, so the write is `ON CONFLICT DO NOTHING` and first
detection is arbitrated by Postgres rather than by a read-then-write two `after()` hooks could
both pass. Partial because `bench_event.kind` is an open set and every other kind is legitimately
many-per-session.

**A3 — the kiosk is told in the chunk response.** The chunk upload is the only channel that
reaches a tab which is not reloading, and the kiosk is already talking to the server every five
minutes. No command bus. The response keeps its normal success shape and gains one field.

**B1/B2/B3 — the kiosk stops, says so, starts nothing.** On the signal it runs the same flush the
End-day button runs, so the partial chunk in flight is finished and uploaded like any other. It
then shows, on the room screen, that the recording was closed by the system, that the audio is
saved, and to press start. It creates no replacement session: the kiosk's own start path has no
guard against a second open session, and silent recovery hides the fault from the person watching
the monitor.

It also never PATCHes end. The row is already ended, and stamping `ended_at` again with the time
this tab finished flushing would overwrite the one piece of evidence that says when the
disagreement began — 19:00:36.677 is exactly that evidence.

**C1 — named.** `ENDED_DISAGREES` sits beside `paused_disagrees` in the pure constants module, in
the same shape and the same vocabulary: two witnesses, and a disagreement is named rather than
resolved. It is deliberately NOT a seventh room state — `roomState()` is a first-match-wins
precedence chain and this is orthogonal to all six. A room can read ready, dropped or offline AND
be taking chunks into an ended session, which is precisely what bs_g3dwud4p looked like.

**C2 — on the monitor.** A red attention row beside "recording with no kiosk page open", plus a
line on the room card, both reading their copy from the one source. Derived from the chunk rows
rather than from the event: same fact, two witnesses, and the chunks are the durable evidence
that was there all along — bs_g3dwud4p has 142 qualifying chunks and zero events, because the
build did not exist when it happened.

---

## The thing that was wrong, and how it was caught

The first version detected `session.status === 'ended'` and nothing else. It shipped, and the
**very first live run on OPD Test — an ordinary Start → End day — tripped it.** The room screen
told a person the recording had been closed by the system when they had closed it themselves.

The rows say why:

```
session bs_jmh9jxmx   ended_at   2026-08-23T05:24:09.817Z
chunk   bc_744vkbng   started_at 2026-08-23T05:23:51.705Z   ended_at 05:24:09.571Z
```

The kiosk marks the session ended as soon as the recorder stops, and only then does its flush
finish uploading. So **a chunk row created after `ended_at` is what every normal end of day looks
like**, in every room, every evening — the shape is there in every OPD Test session going back to
4 August. An alarm that fires on that is unread by Wednesday.

What separates a flush from a kiosk nobody told is the **capture** clock. A flush holds at most
the chunk that was in progress when the session ended, so its `started_at` precedes `ended_at` by
construction. A rogue chunk is audio that BEGAN after we said we had stopped; bs_g3dwud4p's kept
beginning for six hours.

Both sides now compare `c.started_at`, deliberately the opposite clock from the monitor's mic
vitals, which use `created_at` because they ask "is audio still ARRIVING". This asks "was it
RECORDED after we stopped", and only the capture stamp can answer that. The 60 s grace is
browser-versus-server clock skew and nothing wider — a genuinely rogue chunk is a whole rotation
late at minimum, so the grace costs no detection.

This is recorded at length rather than quietly fixed because the failure mode is instructive: the
detection rule looked obviously right, had a passing test suite behind it, and was falsified by
one real recording.

---

## Acceptance

Run on **OPD Test** (`room_xf5vcjpt`), the throwaway room. Home Office was never touched, and no
session was created on any room by anything other than its own kiosk.

### A1 — the chunk is stored, the event is written once, the response carries the signal

**How the disagreement was produced, faithfully.** The kiosk was started normally, and then the
session row was ended out from under it with `PATCH /api/bench/sessions/{id} {action:"end"}` —
the same row update the reaper performs, with no command-bus message and nothing that tells the
recorder. Immediately afterwards the kiosk still read **Recording · 00:00:30**. The reaper itself
was not touched.

**The in-flight chunk was correctly NOT flagged.** At the 5-minute rotation the chunk that had
been recording when the session was ended uploaded on both lanes — two `POST /api/bench/chunks`,
200, 380 ms and 303 ms — and the kiosk carried on: `chunk 2 in progress`, `1 chunk archived`,
`Last chunk verified in R2`. No event, no signal, no banner. That chunk began before `ended_at`,
so it is indistinguishable from an ordinary end-of-day flush and is treated as one. This is the
half of the rule that stops the alarm firing every evening.

**The chunk that began after the end.** At the next rotation, `idx 1` uploaded on both lanes and
the disagreement was detected. Read back from production:

```
session bs_fc6stsjd   status ended   ended_at 2026-08-23T05:37:42.710Z
  notes "ended server-side while the kiosk kept recording — ended_disagrees acceptance A1"

chunk  idx source   started_at                 ended_at        bytes      upload_state
       0   primary  05:37:14.434  →  05:42:14.874   4,837,395      verified   before the end
       0   backup   05:37:14.563  →  05:42:14.878      70,680      verified   before the end
       1   primary  05:42:14.875  →  05:47:15.877   4,846,089      verified   +4m 32s  ← DETECTED
       1   backup   05:42:14.878  →  05:47:15.880      70,848      verified   +4m 32s
       2   primary  05:47:15.877  →  05:47:17.595      27,344      verified   the flush
       2   backup   05:47:15.880  →  05:47:17.596         688      verified   the flush

totals   6 rows, 6 verified, 9,853,044 bytes, 0 unverified, 0 refused
```

- **A1 — stored.** Every one of the six rows is `verified`. Four of them arrived AFTER the
  disagreement had been detected and were accepted exactly like any other.
- **A2 — one event, not one per chunk.** Four qualifying chunk uploads, one row:
  ```
  be_hs84c3ca   kind ended_disagrees   brain_status none   at 05:42:14.875
    payload { source: "server", detected_on: { idx: 1, chunk_source: "primary" },
              session_ended_at: "05:37:42.710Z", chunk_started_at: "05:42:14.875Z" }
  ```
- **A3 — the response carried the signal**, and the kiosk acted on it (below). The `disagreement`
  field is absent from every other response in this run.

### A2 (kiosk) — what a person in that room sees

> ### This recording was closed by the system
> The audio recorded so far is saved and verified — nothing was lost. Press start to begin a new
> recording.
>
> 3 chunks archived + 3 backup (9 MB) — all uploads verified.
>
> **[ Start a new recording ]**

The header pill flipped from `Recording` to `Not recording`. `idx 2` — 1.7 seconds long — is the
partial chunk that was in flight when the signal arrived: it was finished and uploaded rather
than discarded, which is B1 in one row.

### A3 — no session was created automatically

OPD Test, IST 2026-08-23: **8 sessions, every one `ended`**, and `bs_fc6stsjd` is the newest. Six
were started by a deliberate press of Start during this acceptance; two are earlier API probes
(`bs_5wytcjze`, `bs_f5dwu7h8`) that predate it. Nothing appeared after the disagreement — the
kiosk sat on **Start a new recording** and waited for a human.

### A4 — the operator's line

Desktop (1920 CSS px), top of the monitor:

> **NEEDS YOUR ATTENTION**
> `act now`  **OPD Test — chunks are still arriving for a session that is marked ended**
> 4 pieces stored since it was marked ended 11m 14s ago, newest 1m 36s ago — the audio is safe
> and still being stored — the room page has been told to stop; go to the room and press start to
> open a fresh recording

and the same on the room card, in red, with the instruction on its own line. Four pieces is
exactly the four chunks captured after `ended_at` — the two `idx 1` and the two `idx 2`.

The card also still reads `dropped` / `Kiosk dropped 1m ago`, which is right and is the argument
for not making this a seventh room state: both facts are true at once, and a first-match-wins
chain would have shown one and hidden the other.

**iPad width: NOT VISUALLY VERIFIED.** The browser tooling available here would not give a true
narrow viewport — `resize_window` reported success but `window.innerWidth` stayed at 1920, and a
root `zoom` did not move `documentElement.clientWidth` either, so any screenshot I produced would
have been a desktop render mislabelled. What can be said instead, measured rather than asserted:
the card block renders at **368 px wide** at desktop (the `xl:grid-cols-3` column), which is
narrower than an iPad viewport, and it carries no fixed width, no `min-w-`, and no
`whitespace-nowrap` — its classes are `mt-3 rounded-lg border p-3` with `text-caption
leading-snug`, character for character the primitives the existing orphan-repair block uses and
which already ship at both widths. The attention row is plain flow text in a single-column list.
That is a good argument and it is not a screenshot; somebody should glance at it on the iPad.

### A5 — normal recording is unchanged

A complete ordinary cycle on the deployed build (`bs_e2wrc5sm`): Start → chunk → End day.

```
session bs_e2wrc5sm   ended_at 05:34:15.169Z
chunk   bc_gb53gck3   started_at 05:33:43.264Z   verified
        bc_gmz5vmtm   started_at 05:33:43.391Z   verified
events  []
```

Screen read **Day ended · 1 chunk archived + 1 backup — all uploads verified**. No event, no
signal field in either response, and the monitor showed **"Nothing needs attention"** immediately
before the A1 experiment. The 20-sample replay below also ran against this session — `ended`,
with a chunk captured before the end — and every response came back plain
`{ok, key, upload_state}`.

### A6 — response time

Real recordings, `POST /api/bench/chunks`, browser Resource Timing:

| | first POST of a cycle | second POST | mid-session rotations |
|---|---|---|---|
| **before** (`5690328`) | 388, 361 | 307, 296 | — |
| **after** (`685807e`) | 552, 448, 380 | 309, 305, 303 | 335, 299, 301, 307 |

The second-POST column is the controlled comparison — same tiny backup payload every time — and
it is 296–307 before against 299–309 after. The first-POST outliers are cold-instance cost on a
freshly loaded page and appear on both sides.

Steady state, 20 sequential POSTs replaying one real already-verified chunk on the new build:

```
287 288 291 292 293 294 294 297 299 299 300 300 301 301 304 317 334 335 338 343
min 287   median 300   max 343
```

Two of the four before-samples sit inside that distribution and two sit above its maximum. The
structural claim behind it is the one that actually matters and it is asserted by test: the same
queries run before the response whether or not the session disagrees. The status is a field on a
row the route already loaded, and the event write is in the same `after()` hook as the window
evaluation.

### A7 — Home Office untouched

```
bs_g3dwud4p   status ended   ended_at 2026-08-22T19:00:36.677Z
              notes "auto-ended: day rollover (reaper)"
              216 chunk rows, 216 verified, 0 unverified, 0 events
```

`ended_at` is still the reaper's stamp and was not repaired. No chunk was modified or deleted.
The monitor shows Home Office with no attention row (its 142 post-end chunks are from 22 August,
outside today's IST window).

`ROOM_STT_DRAIN_ENABLED` and `FUSE_LIVE_ENABLED` are **absent from the production environment** —
which parses to `{ set: false, rooms: [] }`, off for every room. Neither this build nor its
migration references either name, and a test asserts that no shipped file in it mentions
`bench_window`, `speaker_cluster`, `room_day`, `stt_window` or either flag in code.

**sha `685807e`.**

---

## What this build did NOT do

- No chunk is refused, for any reason.
- No replacement session is started, ever.
- No `bench_chunk` row was modified or deleted.
- The reaper is unchanged. K4a fixed Rule 2; Rule 1 stands as it is.
- Nothing was added to the `POST /api/bench/chunks` request path.
- No flag, fuse, drain, arm A or diarization was touched.
- bs_g3dwud4p's `ended_at` was not repaired. It is evidence.

## Follow-ups

1. **The kiosk PATCHes end before its flush lands.** Pre-existing, unchanged here, and now
   written down: `endDay()` sets state to `ending` before anything is enqueued, so the
   flush-complete effect fires on an empty queue and ends the session immediately. It is why
   every session's `ended_at` precedes its last chunk row, and it is worth deciding on
   deliberately rather than leaving as an accident of ordering.
2. **A stale `ended_disagrees` event exists on `bs_jmh9jxmx`** (OPD Test), written by the first
   version during the run that exposed the bug. Harmless — the monitor derives from chunk rows,
   not from events, which is exactly why it shows nothing for that session — but it is a wrong
   row and somebody with owner access may want to delete it.
3. **`scribe_diff_room` has the mirror-image check and not this one.** It reports
   `ended_at_lies` — a stored end time LATER than the last piece. `ended_disagrees` is the
   opposite asymmetry. The MCP door and the monitor screen now know different things about a
   room, and this build deliberately stayed inside C2's scope rather than widening.
