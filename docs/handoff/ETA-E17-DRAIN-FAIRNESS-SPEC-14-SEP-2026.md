# ETA-E17 — the drain must not starve a room · BUILD SPEC · 14 Sep 2026 · Orchestrator

Read `ETA-E9-VERDICT-FIRST-LIVE-RUN-14-SEP-2026.md` §5 and `ETA-E8-CONSOLIDATED-RULING-14-SEP-2026.md`
§3. This is R5, promoted by live evidence.

## 0. THIS IS THE GATE ON CLINIC ROLLOUT

`ROOM_AUTO_DRAIN_ENABLED` cannot go on for a clinic day until this is fixed. Not because of throughput
— because of coverage:

> **In the live run, two rooms were eligible. All 25 slots went to one of them.
> `room_ymch4bxu`, holding 113 windows, got zero for two hours and thirteen minutes.**

That is not a simulation. That is what the shipped selector did on production data.

## 1. WHY IT HAPPENS, AND THE PART THAT IS EASY TO MISS

The order is `closed_at DESC` (`lib/stt/auto-drain.ts:126`). `closed_at` is written when the covering
chunk is verified, and each kiosk rotates on its own timer, so every room closes its windows at a fixed
offset after each grid line. **Within one kiosk run that offset's standard deviation is 0.0 seconds —
exactly, not approximately.** The same room is "newest" at every tick, and the loser loses every tick.

The part that is easy to miss, and the reason this is urgent rather than tidy:

> **The offset re-randomises only when a kiosk restarts — a pause, a reload, a rejoin. So the only
> thing currently sharing drain capacity between rooms is kiosk instability. Make the kiosks more
> reliable, which we want, and the starvation gets worse.**

Fairness has to be built **before** reliability improves, not after.

## 2. THE PROPERTY

> **Within any 15-minute grid, no Transcript-on room holding a closed window goes unserved while
> another room is served twice. Within a room, newest-first is preserved.**

**Explicitly NOT oldest-first.** The file header forbids it and it is the wrong trade: under a deficit
oldest-first makes every transcript uniformly stale instead of making some of them prompt. The
freshness intent is right; the cross-room tiebreak is what is broken.

## 3. DESIGN — the shape is ruled, the implementation is yours

Rank **rooms** first, then windows within a room:

- Across rooms: least-recently-served first. A room that has just been drained goes to the back.
- Within a room: `closed_at DESC`, unchanged.
- One window per room per tick, so a room cannot take two while another waits.

You will need a per-room "last served" fact. Deriving it from existing rows is preferable to a new
column if you can do it without a scan that grows with the backlog; if you cannot, a column is fine —
say which you chose and why.

**R6 — do not rank on `closed_at` alone.** Two rooms show close lags up to **64,517 s (17.9 hours)**.
A window whose chunk is verified 18 hours late arrives with a *fresh* `closed_at` and jumps the entire
queue ahead of material recorded minutes ago. Rank on something the recorder controls — the chunk's own
`ended_at` is the candidate — so a late verify cannot reorder the queue. **Prove this with a test that
fails under the old ordering.**

## 4. THE CAP IS NOT PART OF THIS ROUND

`AUTO_DRAIN_BATCH_LIMIT` stays at its default of 1. The binding constraint is emotion's one-job-per-tick
(12/h system-wide), not the drain's, so raising the drain's cap moves nothing downstream and the file
header forbids it without a measurement we do not yet have. **Fairness redistributes; it does not
create capacity. Say so plainly in your report so nobody reads this round as a throughput fix.**

## 5. THE ACCEPTANCE TEST ALREADY EXISTS — USE IT

`docs/handoff/scratch/E4-STARVATION-*-14-SEP-2026.py.txt` is the simulation that predicted this, and
`ETA-E6-REFUTATION-14-SEP-2026.md` §7 extends it to 7, 8 and 9 rooms. **Re-run it against the new
selector.**

Pass condition: **zero rooms with nothing drained in clinic hours**, at every room count from 6 to 9
and at every jitter setting in the table — including **±0 s**, the rigid case, which is the one the
current selector fails in 2,000 of 2,000 phase sets.

Report the same table shape as E6 §7 so the two are directly comparable. The total drained will barely
move (144 → 156 across 6–9 rooms, because capacity is fixed); **what must change is the count of rooms
getting nothing.**

## 6. WHAT MUST NOT HAPPEN

- Do **not** switch to oldest-first.
- Do **not** change `AUTO_DRAIN_BATCH_LIMIT` or `AUTO_DRAIN_MAX_AGE_HOURS`.
- Do **not** turn `ROOM_AUTO_DRAIN_ENABLED` on. It stays `0` until I rule otherwise.
- Do **not** change `room.transcript_enabled` on any room.
- Do **not** touch `lib/emotion/`.
- Do **not** deploy, push, merge or open a PR.

## 7. VERIFY

- **V1** The property in §2, as a behavioural test over a multi-room fixture — not a source-text check.
- **V2** The simulation passes at 6, 7, 8 and 9 rooms, at ±0 s jitter, with **zero** starved rooms.
- **V3** A window verified 18 hours late does **not** jump the queue. The test must fail under
  `closed_at DESC`.
- **V4** Within a room, newest-first still holds. Fairness must not have quietly become FIFO.
- **V5** A Transcript-off room is still excluded before the limit, and still costs no tick — the C8
  join and C6 cooldown behaviour from S1 is unchanged. **Prove the old guarantees survive**; this is
  where a fairness rewrite would silently undo a fix that took four rounds to land.
- **V6 Mutation check**, including the room-ordering key and the one-per-room-per-tick rule.

## 8. OUTPUT

`docs/handoff/ETA-E17-REPORT-14-SEP-2026.md` — diff by file and line count; V1–V6 with the mutation
count; the E6 §7 table re-run against the new selector; which "last served" mechanism you chose and
why. **Cap: 110 lines.** Commit on green; do not push or merge.

## 9. KNOWN FACTS

- Live run, 16:40–18:53 IST: 25 drain attempts, 11.5/h against a `*/5` cron at cap 1. All 25 to
  `room_2qe955hy` (76 backlog windows); `room_ymch4bxu` (113) got zero. No refusals were recorded.
- Per kiosk run, close-lag `sd_phase` is **0.0**. Between runs the median jumps the full 900 s grid.
- Only 2 of 13 rooms have `transcript_enabled`. The backlog is 1,442 closed windows across 9 rooms.
- Emotion's ceiling is 12 windows/hour system-wide; diarize 48/h; drain 12/h.
- `auto-drain.ts:22-24` forbids oldest-first and a higher cap without a measurement.
- Docker is down on the Mini; name the suites that did not run rather than reporting green (rule 8).
